#!/usr/bin/env node
"use strict";

/**
 * uji-batch-mint.cjs
 *
 * Runner eksperimen batchMintIjazah yang:
 * - menjalankan batch 5, 10, dan 25 masing-masing 3 repetisi,
 *   serta batch 50 sebanyak 1 repetisi sesuai manifest,
 * - menyiapkan kredensial melalui server action aplikasi,
 * - mencatat jurnal append-only sebelum dan sesudah transaksi,
 * - menyimpan checkpoint atomik,
 * - merekonsiliasi tx_hash sebelum melanjutkan setelah interupsi,
 * - tidak pernah mengirim ulang transaksi berstatus tidak pasti.
 *
 * Lihat README-batch-mint.md sebelum menjalankan transaksi nyata.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const PLAN_FILE = process.env.RENCANA || path.join(__dirname, "diploma_plan.csv");
const MANIFEST_FILE = process.env.MANIFEST || path.join(__dirname, "dataset_manifest.json");
const ENV_FILE = process.env.BATCH_ENV || path.join(ROOT, "sia-simulasi", ".env");
const LOG_ROOT = process.env.BATCH_LOG_DIR || path.join(__dirname, "experiment_logs");

const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const EMAIL = process.env.REKTOR_EMAIL;
const PASSWORD = process.env.REKTOR_PASSWORD;

const ABI = [
  "function batchMintIjazah(bytes32[] _hashedNinaList, bytes32[] _hashedNimList, string[] _cidList, string[] _encDataList) returns (uint256[])",
  "function getTokenIdByHashedNina(bytes32 _hashedNina) view returns (uint256)",
  "function getIjazahData(uint256 _tokenId) view returns (bytes32 hashedNina, bytes32 hashedNim, string cid, string encData, uint256 mintedAt, uint256 updatedAt, bool isActive, address mintedBy)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event BatchMintCompleted(uint256 indexed startTokenId, uint256 indexed endTokenId, uint256 count, address indexed mintedBy, uint256 timestamp)",
];

const CSV_COLUMNS = [
  "record_id", "execution_id", "batch_id", "batch_size", "repetition", "attempt",
  "timestamp_start", "timestamp_end", "latency_ms", "preparation_ms",
  "confirmation_latency_ms", "finalization_ms", "status", "phase",
  "expected", "actual", "credential_count", "verified_count",
  "tx_hash", "nonce", "block_number", "block_timestamp", "confirmations",
  "gas_estimate", "gas_limit", "gas_used", "gas_per_credential", "start_token_id", "end_token_id",
  "wallet_address", "contract_address", "chain_id",
  "error_class", "error_message", "revert_reason", "resumable", "notes",
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function safeId(value) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("--run hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung");
  }
  return value;
}

const DRY_RUN = flag("dry-run");
const PREPARE_ONLY = flag("prepare-only");
const VALIDATE_ONLY = flag("validate-only");
const PREFLIGHT_ONLY = flag("preflight-only");
const REQUESTED_RUN = arg("run", "");
const CONFIG_ERROR = !REQUESTED_RUN && !DRY_RUN && !PREPARE_ONLY && !VALIDATE_ONLY && !PREFLIGHT_ONLY
  ? "--run wajib untuk transaksi nyata agar eksekusi dapat dilanjutkan dengan aman"
  : "";
const EXECUTION_ID = safeId(REQUESTED_RUN || `batch-mint-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const RETRY_FAILED = flag("retry-failed");
const RETRY_BLOCKED = flag("retry-blocked");
const MAX_ATTEMPTS = Number(arg("max-attempts", "3"));
const CONFIRMATIONS = Number(arg("confirmations", "1"));
const RECEIPT_TIMEOUT_MS = Number(arg("receipt-timeout-ms", "180000"));
const ACTION_TIMEOUT_MS = Number(arg("action-timeout-ms", "120000"));
const ONLY = new Set((arg("only", "") || "").split(",").map((x) => x.trim()).filter(Boolean));

const RUN_DIR = path.join(LOG_ROOT, EXECUTION_ID);
const EVENT_FILE = path.join(RUN_DIR, "events.ndjson");
const CSV_FILE = path.join(RUN_DIR, "results.csv");
const CHECKPOINT_FILE = path.join(RUN_DIR, "checkpoint.json");
const META_FILE = path.join(RUN_DIR, "run.json");
const RUN_LOCK_FILE = path.join(RUN_DIR, "runner.lock");

let cookie = "";
let stopRequested = false;
let provider;
let wallet;
let contract;
let chainId = "";
let contractAddress = "";
let runLockFd;
let runLockAcquired = false;

class PauseForReconciliation extends Error {
  constructor(message) {
    super(message);
    this.name = "PauseForReconciliation";
  }
}

function now() { return new Date().toISOString(); }

function mkdir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
}

function acquireRunLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      runLockFd = fs.openSync(RUN_LOCK_FILE, "wx");
      fs.writeFileSync(runLockFd, `${process.pid},${now()}\n`, "utf8");
      runLockAcquired = true;
      process.on("exit", releaseRunLock);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const content = fs.readFileSync(RUN_LOCK_FILE, "utf8").trim();
      const pid = Number(content.split(",", 1)[0]);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) {
        try { process.kill(pid, 0); }
        catch (checkError) { alive = checkError.code !== "ESRCH"; }
      }
      if (alive) throw new Error(`Execution ID ${EXECUTION_ID} sedang dijalankan oleh PID ${pid}`);
      fs.unlinkSync(RUN_LOCK_FILE);
    }
  }
  throw new Error(`Tidak dapat memperoleh kunci ${RUN_LOCK_FILE}`);
}

function releaseRunLock() {
  if (runLockFd !== undefined) {
    try { fs.closeSync(runLockFd); } catch (_) { /* sudah tertutup */ }
    runLockFd = undefined;
  }
  runLockAcquired = false;
  try { fs.unlinkSync(RUN_LOCK_FILE); } catch (_) { /* sudah dilepas */ }
}

function appendDurable(file, line) {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, line, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function event(type, data = {}) {
  const record = {
    event_id: `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`,
    timestamp: now(),
    execution_id: EXECUTION_ID,
    type,
    ...data,
  };
  appendDurable(EVENT_FILE, `${JSON.stringify(record)}\n`);
  return record;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ensureCsv() {
  if (!fs.existsSync(CSV_FILE)) {
    appendDurable(CSV_FILE, `${CSV_COLUMNS.join(",")}\n`);
    return;
  }
  const header = fs.readFileSync(CSV_FILE, "utf8").split(/\r?\n/, 1)[0];
  if (header !== CSV_COLUMNS.join(",")) throw new Error("Header results.csv tidak sesuai skema runner");
}

function appendResult(values) {
  ensureCsv();
  const record = Object.fromEntries(CSV_COLUMNS.map((key) => [key, ""]));
  Object.assign(record, values);
  if (!record.record_id) {
    record.record_id = `${record.batch_id}-A${record.attempt}-${record.phase}-${Date.now()}`;
  }
  appendDurable(CSV_FILE, `${CSV_COLUMNS.map((key) => csvEscape(record[key])).join(",")}\n`);
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return { schema_version: 1, execution_id: EXECUTION_ID, created_at: now(), batches: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  if (parsed.execution_id !== EXECUTION_ID) throw new Error("execution_id checkpoint tidak cocok");
  parsed.batches ||= {};
  return parsed;
}

function saveCheckpoint(checkpoint) {
  checkpoint.updated_at = now();
  const temporary = `${CHECKPOINT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  const fd = fs.openSync(temporary, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, CHECKPOINT_FILE);
}

function setBatchState(checkpoint, batchId, patch) {
  checkpoint.batches[batchId] = { ...(checkpoint.batches[batchId] || {}), ...patch, updated_at: now() };
  saveCheckpoint(checkpoint);
  return checkpoint.batches[batchId];
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(value); value = ""; }
    else if (c === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ""));
  return body.map((r) => Object.fromEntries(header.map((key, i) => [key, r[i] ?? ""])));
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function serializeError(error) {
  const message = error?.shortMessage || error?.reason || error?.message || String(error);
  const revert = error?.reason || error?.revert?.args?.[0] || "";
  return {
    error_class: error?.code || error?.name || "Error",
    error_message: message,
    revert_reason: revert,
  };
}

function isDeterministicRevert(error) {
  return error?.code === "CALL_EXCEPTION" || /revert|execution reverted/i.test(error?.message || "");
}

function isExternalBlocker(error) {
  const message = typeof error === "string"
    ? error
    : error?.error_message || error?.shortMessage || error?.reason || error?.message || "";
  return /account blocked due to plan usage limit|plan usage limit|storage quota|quota (?:exceeded|limit)/i.test(message);
}

function reclassifyExternalBlockers(checkpoint, batches) {
  for (const batch of batches) {
    const state = checkpoint.batches[batch.id];
    if (state?.phase !== "failed_pre_submit" || state.tx_hash || !isExternalBlocker(state.last_error)) continue;
    setBatchState(checkpoint, batch.id, {
      phase: "blocked_external",
      blocker: "ipfs_provider_quota",
      blocked_at: state.ended_at || now(),
    });
    event("batch_reclassified_external_blocker", {
      batch_id: batch.id,
      previous_phase: "failed_pre_submit",
      phase: "blocked_external",
      blocker: "ipfs_provider_quota",
      attempt: state.attempt,
      ...state.last_error,
    });
  }
}

function ensureExternalBlockerResults(checkpoint, batches) {
  const existing = fs.existsSync(CSV_FILE) ? fs.readFileSync(CSV_FILE, "utf8") : "";
  for (const batch of batches) {
    const state = checkpoint.batches[batch.id];
    if (state?.phase !== "blocked_external") continue;
    const recordId = `${batch.id}-A${state.attempt}-blocked-external-reclassification`;
    if (existing.includes(`${recordId},`)) continue;
    const startedAt = state.started_at || state.blocked_at || now();
    const endedAt = state.ended_at || state.blocked_at || now();
    appendResult({
      record_id: recordId,
      execution_id: EXECUTION_ID,
      batch_id: batch.id,
      batch_size: batch.size,
      repetition: batch.repetition,
      attempt: state.attempt,
      timestamp_start: startedAt,
      timestamp_end: endedAt,
      latency_ms: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
      status: "blocked",
      phase: "blocked_external",
      expected: `${batch.size} token aktif`,
      actual: "tertunda sebelum broadcast karena kuota penyedia IPFS",
      credential_count: batch.size,
      tx_hash: state.tx_hash || "",
      wallet_address: state.wallet_address || "",
      contract_address: state.contract_address || contractAddress,
      chain_id: state.chain_id || chainId,
      ...(state.last_error || {}),
      resumable: "yes",
      notes: `reklasifikasi append-only; pulihkan kuota/kredensial IPFS lalu resume dengan --run ${EXECUTION_ID} --retry-blocked`,
    });
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function retry(label, fn, { attempts = 3, batchId, credential } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      event("retryable_error", { batch_id: batchId, credential, operation: label, retry: attempt, ...serializeError(error) });
      if (attempt < attempts) await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  throw last;
}

function takeCookies(response) {
  const values = response.headers.getSetCookie?.() || [];
  for (const raw of values) {
    const part = raw.split(";", 1)[0];
    if (!/^(authjs|next-auth)\./.test(part)) continue;
    const name = part.split("=", 1)[0];
    cookie = cookie.split("; ").filter((x) => x && !x.startsWith(`${name}=`)).concat(part).join("; ");
  }
}

async function fetchWithTimeout(url, options = {}, timeout = ACTION_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label}: respons bukan JSON (HTTP ${response.status}, ${contentType || "tanpa content-type"})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: JSON tidak dapat diparsing (HTTP ${response.status})`);
  }
}

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error("REKTOR_EMAIL dan REKTOR_PASSWORD wajib diisi");
  const csrfResponse = await fetchWithTimeout(`${SIAKAD}/api/auth/csrf`);
  takeCookies(csrfResponse);
  if (!csrfResponse.ok) throw new Error(`CSRF gagal HTTP ${csrfResponse.status}`);
  const { csrfToken } = await readJson(csrfResponse, "CSRF");
  const response = await fetchWithTimeout(`${SIAKAD}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, redirect: "false" }),
    redirect: "manual",
  });
  takeCookies(response);
  const checkResponse = await fetchWithTimeout(`${SIAKAD}/api/eksperimen`, { headers: { Cookie: cookie } });
  const check = await readJson(checkResponse, "Pemeriksaan sesi");
  if (!check.terautentikasi || check.role !== "master") {
    throw new Error(`Login harus menghasilkan role master; diperoleh ${check.role || "tanpa sesi"}`);
  }
  event("authenticated", { email: check.email, role: check.role });
}

async function action(name, params = {}) {
  const response = await fetchWithTimeout(`${SIAKAD}/api/eksperimen`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ aksi: name, params }),
  });
  const json = await readJson(response, name);
  if (!response.ok || !json.success) throw new Error(`${name}: ${json.error || `HTTP ${response.status}`}`);
  return json.hasil;
}

async function remotePisnStatus(nim) {
  const response = await fetchWithTimeout(`${PISN}/api/pisn/status/${encodeURIComponent(nim)}`);
  if (response.status === 404) return null;
  const json = await readJson(response, `status PISN ${nim}`);
  if (!response.ok || !json.success) throw new Error(`status PISN ${nim}: ${json.message || `HTTP ${response.status}`}`);
  return json.data;
}

async function approveRemoteReservation(remoteId) {
  const response = await fetchWithTimeout(`${PISN}/api/pisn/approve/${remoteId}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
  });
  const json = await readJson(response, `approve PISN #${remoteId}`);
  if (!response.ok || !json.success) throw new Error(`approve PISN #${remoteId}: ${json.message || `HTTP ${response.status}`}`);
  return json.data;
}

function exactStudent(list, nim) { return list.find((item) => item.nim === nim); }
function exactDiploma(list, nim) { return list.find((item) => item.student?.nim === nim); }

async function getStudent(nim) {
  return exactStudent(await action("getStudents", { query: nim }), nim);
}

async function getDiploma(nim) {
  return exactDiploma(await action("getDiplomas", { query: nim }), nim);
}

async function ensureCredential(plan, batchId) {
  const nim = plan.nim;
  event("credential_prepare_started", { batch_id: batchId, nim });
  let student = await getStudent(nim);
  if (!student) throw new Error(`Mahasiswa ${nim} tidak ditemukan`);

  if (student.pddiktiStatus === "unverified") {
    const result = await retry("laporDataMahasiswa", () => action("laporDataMahasiswa", { studentId: student.id }), { batchId, credential: nim });
    if (!result.success) throw new Error(result.error || `Pelaporan data ${nim} gagal`);
    event("credential_data_reported", { batch_id: batchId, nim });
    student = await getStudent(nim);
  }

  if (student.pddiktiStatus !== "eligible") {
    const result = await retry("laporKelulusan", () => action("laporKelulusan", {
      studentId: student.id,
      ipk: Number(plan.ipk),
      tanggalLulus: plan.graduationDate,
      nomorSkYudisium: `SK-YUD/2026/${String(plan.urutan).padStart(4, "0")}`,
      tanggalSkYudisium: "2026-05-20",
    }), { batchId, credential: nim });
    if (!result.success) throw new Error(result.error || `Pelaporan kelulusan ${nim} gagal`);
    event("credential_graduation_reported", { batch_id: batchId, nim });
    student = await getStudent(nim);
  }
  if (student.pddiktiStatus !== "eligible") throw new Error(`${nim} belum eligible setelah pelaporan kelulusan`);

  if (!student.nina) {
    let remote = await remotePisnStatus(nim);
    const localList = await action("getPisnReservations", {});
    let local = localList.find((item) => Number(item.student?.id) === Number(student.id));

    if (!remote && !local) {
      const reservation = await retry("createPisnReservation", () => action("createPisnReservation", { studentId: student.id }), { batchId, credential: nim });
      if (!reservation.success) throw new Error(reservation.error || `Reservasi ${nim} gagal`);
      event("credential_reserved", { batch_id: batchId, nim });
      remote = await remotePisnStatus(nim);
      local = (await action("getPisnReservations", {})).find((item) => Number(item.student?.id) === Number(student.id));
    }

    if (!remote || !local) {
      throw new Error(`${nim}: reservasi lokal dan PISN tidak dapat direkonsiliasi otomatis`);
    }
    if (["menunggu", "diproses"].includes(remote.status)) {
      await approveRemoteReservation(remote.id);
      event("credential_reservation_approved", { batch_id: batchId, nim, remote_reservation_id: remote.id });
    }
    const status = await retry("cekStatusPisn", () => action("cekStatusPisn", { reservationId: local.id }), { batchId, credential: nim });
    if (!status.success || !/^\d{15}$/.test(status.nina || "")) {
      throw new Error(`${nim}: NINA tidak terbit (${status.error || status.status || "tanpa status"})`);
    }
    student = await getStudent(nim);
  }
  if (!/^\d{15}$/.test(student.nina || "")) throw new Error(`${nim}: NINA lokal tidak sah`);

  let diploma = await getDiploma(nim);
  if (!diploma) {
    const created = await retry("createDiploma", () => action("createDiploma", {
      studentId: student.id,
      diplomaNumber: `IJZ-2026-${String(plan.urutan).padStart(4, "0")}`,
      nina: student.nina,
      major: plan.major,
      jenjangPendidikan: plan.jenjangPendidikan,
      akreditasi: plan.akreditasi,
      ipk: plan.ipk,
      graduationDate: plan.graduationDate,
      gelar: plan.gelar,
      gelarSingkat: plan.gelarSingkat,
      predikat: plan.predikat,
      facultyId: plan.facultyId,
    }), { attempts: 2, batchId, credential: nim });
    if (!created.success) throw new Error(created.error || `Pembuatan ijazah ${nim} gagal`);
    event("credential_diploma_created", { batch_id: batchId, nim });
    diploma = await getDiploma(nim);
  }
  if (!diploma?.generatedImagePath) throw new Error(`${nim}: PDF ijazah belum tersedia`);

  if (!diploma.ipfsJsonHash) {
    const prepared = await retry("prepareBatchMint-single", () => action("prepareBatchMint", { diplomaIds: [diploma.id] }), { attempts: 3, batchId, credential: nim });
    if (!prepared.success || prepared.cidList?.length !== 1) {
      throw new Error(prepared.error || `${nim}: artefak IPFS tidak siap`);
    }
    event("credential_artifact_prepared", { batch_id: batchId, nim, diploma_id: diploma.id, cid: prepared.cidList[0] });
    diploma = await getDiploma(nim);
  }

  event("credential_ready", {
    batch_id: batchId, nim, nina: student.nina, diploma_id: diploma.id,
    cid: diploma.ipfsJsonHash, status_blockchain: diploma.statusBlockchain,
  });
  return { nim, nina: student.nina, diplomaId: diploma.id, diploma };
}

async function initBlockchain(addressFromApi) {
  loadEnvFile();
  const rpc = process.env.POLYGON_RPC_URL;
  const privateKey = process.env.REKTOR_PRIVATE_KEY;
  const configuredAddress = process.env.CONTRACT_ADDRESS_IJAZAH || "";
  if (addressFromApi && configuredAddress && addressFromApi.toLowerCase() !== configuredAddress.toLowerCase()) {
    throw new Error(`Alamat kontrak API (${addressFromApi}) berbeda dari konfigurasi runner (${configuredAddress})`);
  }
  contractAddress = addressFromApi || configuredAddress;
  if (!rpc || !privateKey || !contractAddress) throw new Error("RPC, private key, atau alamat kontrak belum dikonfigurasi");

  provider = new ethers.JsonRpcProvider(rpc);
  wallet = new ethers.Wallet(privateKey, provider);
  contract = new ethers.Contract(contractAddress, ABI, wallet);
  const network = await provider.getNetwork();
  chainId = network.chainId.toString();
  if (chainId !== "80002") throw new Error(`Chain ID harus Polygon Amoy 80002, diperoleh ${chainId}`);
  if ((await provider.getCode(contractAddress)) === "0x") throw new Error(`Tidak ada bytecode di ${contractAddress}`);
  const role = ethers.id("REKTOR_ROLE");
  if (!(await contract.hasRole(role, wallet.address))) throw new Error(`Wallet ${wallet.address} tidak memiliki REKTOR_ROLE`);
  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) throw new Error(`Wallet ${wallet.address} tidak memiliki saldo POL`);
  event("blockchain_ready", {
    chain_id: chainId, contract_address: contractAddress, wallet_address: wallet.address,
    balance_wei: balance.toString(),
  });
}

async function assertNoActiveTokens(prepared, credentials, batchId) {
  for (let i = 0; i < prepared.hashedNinaList.length; i++) {
    const tokenId = await contract.getTokenIdByHashedNina(prepared.hashedNinaList[i]);
    if (tokenId !== 0n) {
      const data = await contract.getIjazahData(tokenId);
      if (data.isActive) {
        throw new Error(`${batchId}: NINA ${credentials[i].nina} (${credentials[i].nim}) sudah memiliki token aktif ${tokenId}`);
      }
    }
  }
}

/** Tolak kelompok terkontaminasi sebelum membuat PDF/CID untuk anggota lain. */
async function assertExistingPlansNotActive(plans, batchId) {
  if (!contract) await initBlockchain("");
  for (const plan of plans) {
    const student = await getStudent(plan.nim);
    if (!student?.nina) continue;
    const hashedNina = ethers.keccak256(ethers.toUtf8Bytes(student.nina));
    const tokenId = await contract.getTokenIdByHashedNina(hashedNina);
    if (tokenId === 0n) continue;
    const data = await contract.getIjazahData(tokenId);
    if (data.isActive) {
      throw new Error(
        `${batchId}: dataset terkontaminasi sebelum run; ${plan.nim}/${student.nina} sudah memiliki token aktif ${tokenId}`
      );
    }
  }
}

function parseBatchReceipt(receipt) {
  for (const log of receipt.logs || []) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "BatchMintCompleted") {
        return {
          startTokenId: Number(parsed.args.startTokenId),
          endTokenId: Number(parsed.args.endTokenId),
          count: Number(parsed.args.count),
        };
      }
    } catch (_) { /* event kontrak lain */ }
  }
  throw new Error(`Event BatchMintCompleted tidak ditemukan pada ${receipt.hash}`);
}

async function getConfirmedReceipt(txHash) {
  let receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    try {
      receipt = await provider.waitForTransaction(txHash, CONFIRMATIONS, RECEIPT_TIMEOUT_MS);
    } catch (error) {
      receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) event("receipt_wait_error", { tx_hash: txHash, ...serializeError(error) });
    }
  }
  return receipt;
}

async function recordReceipt(checkpoint, batch, state, receipt) {
  if (!receipt) throw new PauseForReconciliation(`Receipt ${state.tx_hash} belum tersedia`);
  if (Number(receipt.status) !== 1) throw Object.assign(new Error(`Transaksi ${state.tx_hash} reverted`), { code: "CALL_EXCEPTION" });
  const parsed = parseBatchReceipt(receipt);
  if (parsed.count !== batch.size) throw new Error(`Event mencatat ${parsed.count}, seharusnya ${batch.size}`);
  const block = await provider.getBlock(receipt.blockNumber);
  const confirmedAt = now();
  const gasUsed = receipt.gasUsed.toString();
  setBatchState(checkpoint, batch.id, {
    phase: "confirmed", tx_hash: state.tx_hash, block_number: receipt.blockNumber,
    block_timestamp: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : "",
    gas_used: gasUsed, start_token_id: parsed.startTokenId, end_token_id: parsed.endTokenId,
    confirmed_at: confirmedAt,
  });
  event("transaction_confirmed", {
    batch_id: batch.id, tx_hash: state.tx_hash, block_number: receipt.blockNumber,
    block_timestamp: checkpoint.batches[batch.id].block_timestamp,
    gas_used: gasUsed, start_token_id: parsed.startTokenId, end_token_id: parsed.endTokenId,
  });
  return checkpoint.batches[batch.id];
}

async function finalizeAndVerify(checkpoint, batch, state) {
  const finalized = await action("finalizeBatchMint", {
    diplomaIds: state.diploma_ids, txHash: state.tx_hash, startTokenId: state.start_token_id,
  });
  if (!finalized.success) throw new Error(finalized.error || `${batch.id}: finalisasi basis data gagal`);
  setBatchState(checkpoint, batch.id, { phase: "finalized", finalized_at: now() });
  event("database_finalized", { batch_id: batch.id, tx_hash: state.tx_hash });

  let verified = 0;
  for (let i = 0; i < state.hashed_nina_list.length; i++) {
    const expectedToken = state.start_token_id + i;
    const tokenId = Number(await contract.getTokenIdByHashedNina(state.hashed_nina_list[i]));
    if (tokenId !== expectedToken) throw new Error(`${batch.id}: token ${tokenId} tidak sama dengan ${expectedToken}`);
    const chainData = await contract.getIjazahData(tokenId);
    if (!chainData.isActive || chainData.cid !== state.cid_list[i]) {
      throw new Error(`${batch.id}: token ${tokenId} tidak aktif atau CID tidak cocok`);
    }
    const diploma = await getDiploma(state.nims[i]);
    if (diploma?.statusBlockchain !== "verified" || Number(diploma.tokenId) !== tokenId || diploma.txHash !== state.tx_hash) {
      throw new Error(`${batch.id}: basis data ${state.nims[i]} tidak sinkron dengan token ${tokenId}`);
    }
    verified++;
  }

  const endedAt = now();
  const latency = new Date(endedAt).getTime() - new Date(state.started_at).getTime();
  const preparationMs = new Date(state.prepared_at).getTime() - new Date(state.started_at).getTime();
  const confirmationMs = new Date(state.confirmed_at).getTime() - new Date(state.submitted_at).getTime();
  const finalizationMs = new Date(endedAt).getTime() - new Date(state.confirmed_at).getTime();
  const gasPerCredential = Math.ceil(Number(state.gas_used) / batch.size);
  setBatchState(checkpoint, batch.id, { phase: "verified", verified_count: verified, ended_at: endedAt });
  event("batch_verified", { batch_id: batch.id, verified_count: verified, tx_hash: state.tx_hash });
  appendResult({
    execution_id: EXECUTION_ID, batch_id: batch.id, batch_size: batch.size,
    repetition: batch.repetition, attempt: state.attempt, timestamp_start: state.started_at,
    timestamp_end: endedAt, latency_ms: latency, preparation_ms: preparationMs,
    confirmation_latency_ms: confirmationMs, finalization_ms: finalizationMs,
    status: "pass", phase: "verified",
    expected: `${batch.size} token aktif`, actual: `${verified} token aktif`,
    credential_count: batch.size, verified_count: verified, tx_hash: state.tx_hash,
    nonce: state.nonce, block_number: state.block_number, block_timestamp: state.block_timestamp,
    confirmations: CONFIRMATIONS, gas_estimate: state.gas_estimate,
    gas_limit: state.gas_limit, gas_used: state.gas_used,
    gas_per_credential: gasPerCredential, start_token_id: state.start_token_id,
    end_token_id: state.end_token_id, wallet_address: wallet.address,
    contract_address: contractAddress, chain_id: chainId, resumable: "yes",
    notes: "batchMintIjazah nyata; status kontrak dan basis data diverifikasi",
  });
}

async function reconcile(checkpoint, batch) {
  let state = checkpoint.batches[batch.id];
  event("reconciliation_started", { batch_id: batch.id, phase: state.phase, tx_hash: state.tx_hash });
  if (["submitted", "pending"].includes(state.phase)) {
    const receipt = await getConfirmedReceipt(state.tx_hash);
    if (!receipt) {
      event("transaction_still_pending", { batch_id: batch.id, tx_hash: state.tx_hash });
      throw new PauseForReconciliation(`${batch.id}: transaksi masih pending; jalankan kembali dengan --run ${EXECUTION_ID}`);
    }
    state = await recordReceipt(checkpoint, batch, state, receipt);
  }
  if (["confirmed", "finalized", "needs_reconciliation"].includes(state.phase)) {
    await finalizeAndVerify(checkpoint, batch, state);
  }
}

async function processBatch(checkpoint, batch, plans) {
  let state = checkpoint.batches[batch.id];
  if (state?.phase === "verified") {
    console.log(`${batch.id.padEnd(15)} lewati — sudah verified`);
    event("batch_skipped_verified", { batch_id: batch.id });
    return;
  }
  if (state?.tx_hash && ["submitted", "pending", "confirmed", "finalized", "needs_reconciliation"].includes(state.phase)) {
    console.log(`${batch.id.padEnd(15)} rekonsiliasi ${state.tx_hash}`);
    await reconcile(checkpoint, batch);
    return;
  }
  if (state?.phase === "reverted" && !RETRY_FAILED) {
    console.log(`${batch.id.padEnd(15)} lewati — reverted; gunakan --retry-failed setelah penyebab diperbaiki`);
    event("batch_skipped_failed", { batch_id: batch.id, phase: state.phase });
    return;
  }
  if (state?.phase === "blocked_external" && !RETRY_BLOCKED) {
    console.log(`${batch.id.padEnd(15)} lewati — kuota penyedia IPFS terblokir; gunakan --retry-blocked setelah kuota dipulihkan`);
    event("batch_skipped_external_blocker", {
      batch_id: batch.id,
      phase: state.phase,
      blocker: state.blocker || "external_service",
      attempt: state.attempt,
    });
    return;
  }

  const attempt = Number(state?.attempt || 0) + 1;
  if (attempt > MAX_ATTEMPTS && state?.phase !== "blocked_external") {
    console.log(`${batch.id.padEnd(15)} lewati — batas ${MAX_ATTEMPTS} attempt tercapai`);
    event("batch_skipped_attempt_limit", { batch_id: batch.id, attempt });
    return;
  }
  const startedAt = now();
  state = setBatchState(checkpoint, batch.id, {
    phase: "preparing", attempt, started_at: startedAt, batch_size: batch.size,
    repetition: batch.repetition, nims: plans.map((p) => p.nim), tx_hash: "",
    nonce: "", block_number: "", block_timestamp: "", gas_estimate: "",
    gas_limit: "", gas_used: "", start_token_id: "", end_token_id: "",
    submitted_at: "", confirmed_at: "", finalized_at: "", ended_at: "", last_error: "",
  });
  event("batch_started", { batch_id: batch.id, batch_size: batch.size, repetition: batch.repetition, attempt, nims: state.nims });
  console.log(`${batch.id.padEnd(15)} siapkan ${batch.size} kredensial (attempt ${attempt})`);

  try {
    await assertExistingPlansNotActive(plans, batch.id);
    const credentials = [];
    for (const plan of plans) {
      if (stopRequested) throw new PauseForReconciliation("Penghentian diminta pengguna pada titik aman");
      credentials.push(await ensureCredential(plan, batch.id));
    }
    const prepared = await retry("prepareBatchMint-final", () => action("prepareBatchMint", {
      diplomaIds: credentials.map((item) => item.diplomaId),
    }), { attempts: 2, batchId: batch.id });
    if (!prepared.success) throw new Error(prepared.error || `${batch.id}: persiapan final gagal`);
    for (const key of ["hashedNinaList", "hashedNimList", "cidList", "encDataList"]) {
      if (!Array.isArray(prepared[key]) || prepared[key].length !== batch.size) {
        throw new Error(`${batch.id}: ${key} berjumlah ${prepared[key]?.length}, seharusnya ${batch.size}`);
      }
    }
    if (!contract) await initBlockchain(prepared.contractAddress);
    await assertNoActiveTokens(prepared, credentials, batch.id);

    state = setBatchState(checkpoint, batch.id, {
      phase: "prepared", diploma_ids: credentials.map((item) => item.diplomaId),
      nims: credentials.map((item) => item.nim), ninas: credentials.map((item) => item.nina),
      hashed_nina_list: prepared.hashedNinaList, hashed_nim_list: prepared.hashedNimList,
      cid_list: prepared.cidList, enc_data_list: prepared.encDataList,
      contract_address: contractAddress, wallet_address: wallet.address, chain_id: chainId,
      prepared_at: now(),
    });
    event("batch_prepared", {
      batch_id: batch.id, diploma_ids: state.diploma_ids, nims: state.nims,
      cids: state.cid_list, contract_address: contractAddress,
    });

    if (DRY_RUN || PREPARE_ONLY) {
      const phase = DRY_RUN ? "dry_run_ready" : "prepared_only";
      setBatchState(checkpoint, batch.id, { phase });
      event(phase, { batch_id: batch.id });
      appendResult({
        execution_id: EXECUTION_ID, batch_id: batch.id, batch_size: batch.size,
        repetition: batch.repetition, attempt, timestamp_start: startedAt, timestamp_end: now(),
        latency_ms: Date.now() - new Date(startedAt).getTime(), status: "skip", phase,
        expected: `${batch.size} kredensial siap`, actual: `${batch.size} kredensial siap; transaksi tidak dikirim`,
        credential_count: batch.size, wallet_address: wallet.address,
        contract_address: contractAddress, chain_id: chainId, resumable: "yes",
      });
      return;
    }

    const estimate = await contract.batchMintIjazah.estimateGas(
      state.hashed_nina_list, state.hashed_nim_list, state.cid_list, state.enc_data_list,
    );
    state = setBatchState(checkpoint, batch.id, { gas_estimate: estimate.toString() });
    event("gas_estimated", { batch_id: batch.id, gas_estimate: estimate.toString() });
    const fee = await provider.getFeeData();
    const minimumPriority = ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas = !fee.maxPriorityFeePerGas || fee.maxPriorityFeePerGas < minimumPriority
      ? minimumPriority : fee.maxPriorityFeePerGas;
    const maxFeePerGas = !fee.maxFeePerGas || fee.maxFeePerGas < maxPriorityFeePerGas
      ? maxPriorityFeePerGas + ethers.parseUnits("10", "gwei") : fee.maxFeePerGas;

    const tx = await contract.batchMintIjazah(
      state.hashed_nina_list, state.hashed_nim_list, state.cid_list, state.enc_data_list,
      { maxPriorityFeePerGas, maxFeePerGas },
    );
    state = setBatchState(checkpoint, batch.id, {
      phase: "submitted", tx_hash: tx.hash, nonce: tx.nonce,
      gas_limit: tx.gasLimit?.toString() || "", submitted_at: now(),
    });
    event("transaction_submitted", {
      batch_id: batch.id, tx_hash: tx.hash, nonce: tx.nonce,
      gas_limit: state.gas_limit,
    });
    console.log(`${batch.id.padEnd(15)} submitted ${tx.hash}`);

    let receipt;
    try {
      receipt = await tx.wait(CONFIRMATIONS, RECEIPT_TIMEOUT_MS);
    } catch (error) {
      if (error?.receipt) receipt = error.receipt;
      else if (error?.replacement?.hash) {
        state = setBatchState(checkpoint, batch.id, { tx_hash: error.replacement.hash, replaced_tx_hash: tx.hash });
        event("transaction_replaced", { batch_id: batch.id, old_tx_hash: tx.hash, tx_hash: error.replacement.hash });
        receipt = error.replacementReceipt || await provider.getTransactionReceipt(error.replacement.hash);
      } else {
        receipt = await provider.getTransactionReceipt(tx.hash);
        if (!receipt) {
          setBatchState(checkpoint, batch.id, { phase: "pending", last_error: serializeError(error) });
          event("transaction_status_unknown", { batch_id: batch.id, tx_hash: tx.hash, ...serializeError(error) });
          appendResult({
            execution_id: EXECUTION_ID, batch_id: batch.id, batch_size: batch.size,
            repetition: batch.repetition, attempt, timestamp_start: startedAt, timestamp_end: now(),
            latency_ms: Date.now() - new Date(startedAt).getTime(), status: "pending", phase: "pending",
            expected: `${batch.size} token aktif`, actual: "transaksi sudah dikirim; receipt belum tersedia",
            credential_count: batch.size, tx_hash: tx.hash, nonce: tx.nonce,
            gas_limit: state.gas_limit, wallet_address: wallet.address,
            contract_address: contractAddress, chain_id: chainId,
            ...serializeError(error), resumable: "yes",
            notes: `jalankan kembali dengan --run ${EXECUTION_ID}; jangan kirim ulang`,
          });
          throw new PauseForReconciliation(`${batch.id}: status transaksi belum pasti`);
        }
      }
    }
    state = await recordReceipt(checkpoint, batch, checkpoint.batches[batch.id], receipt);
    await finalizeAndVerify(checkpoint, batch, state);
    console.log(`${batch.id.padEnd(15)} verified — token ${state.start_token_id}-${state.end_token_id}`);
  } catch (error) {
    if (error instanceof PauseForReconciliation) throw error;
    const current = checkpoint.batches[batch.id];
    const afterBroadcast = Boolean(current?.tx_hash);
    const deterministicRevert = isDeterministicRevert(error);
    const externalBlocker = !afterBroadcast && isExternalBlocker(error);
    const receiptRecorded = Boolean(current?.start_token_id && current?.block_number);
    const phase = externalBlocker
      ? "blocked_external"
      : deterministicRevert
      ? "reverted"
      : afterBroadcast
        ? (receiptRecorded ? "needs_reconciliation" : "pending")
        : "failed_pre_submit";
    setBatchState(checkpoint, batch.id, {
      phase,
      blocker: externalBlocker ? "ipfs_provider_quota" : "",
      blocked_at: externalBlocker ? now() : "",
      last_error: serializeError(error),
      ended_at: now(),
    });
    event(externalBlocker ? "batch_blocked_external" : "batch_failed", {
      batch_id: batch.id,
      phase,
      attempt,
      ...(externalBlocker ? { blocker: "ipfs_provider_quota" } : {}),
      ...serializeError(error),
    });
    appendResult({
      execution_id: EXECUTION_ID, batch_id: batch.id, batch_size: batch.size,
      repetition: batch.repetition, attempt, timestamp_start: startedAt, timestamp_end: now(),
      latency_ms: Date.now() - new Date(startedAt).getTime(), status: externalBlocker ? "blocked" : "fail", phase,
      expected: `${batch.size} token aktif`,
      actual: externalBlocker
        ? "tertunda sebelum broadcast karena kuota penyedia IPFS"
        : deterministicRevert
        ? "transaksi direvert; tidak ada token batch yang terbentuk"
        : afterBroadcast ? "perlu rekonsiliasi" : "gagal sebelum transaksi disiarkan",
      credential_count: batch.size, tx_hash: current?.tx_hash, nonce: current?.nonce,
      block_number: current?.block_number, gas_estimate: current?.gas_estimate,
      gas_limit: current?.gas_limit, gas_used: current?.gas_used,
      wallet_address: wallet?.address || "", contract_address: contractAddress,
      chain_id: chainId, ...serializeError(error), resumable: "yes",
      notes: externalBlocker
        ? `pulihkan kuota/kredensial IPFS lalu resume dengan --run ${EXECUTION_ID} --retry-blocked`
        : deterministicRevert
        ? "revert terkonfirmasi; state kontrak atomik dan batch berikutnya boleh dilanjutkan"
        : afterBroadcast ? `jalankan kembali dengan --run ${EXECUTION_ID}` : "batch berikutnya boleh dilanjutkan",
    });
    if (afterBroadcast && !deterministicRevert) {
      throw new PauseForReconciliation(`${batch.id}: transaksi sudah disiarkan dan perlu rekonsiliasi`);
    }
    console.error(`${batch.id.padEnd(15)} ${externalBlocker ? "tertunda (hambatan eksternal)" : "gagal"}: ${serializeError(error).error_message}`);
  }
}

function buildBatches() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  const plans = parseCsv(fs.readFileSync(PLAN_FILE, "utf8"));
  const batches = manifest.rincian_batch.map((item) => {
    const id = item.label;
    const members = plans.filter((plan) => plan._kelompok === id);
    if (members.length !== item.ukuran) throw new Error(`${id}: plan berisi ${members.length}, seharusnya ${item.ukuran}`);
    return { id, size: item.ukuran, repetition: item.pengulangan, plans: members };
  });
  if (ONLY.size) {
    const known = new Set(batches.map((batch) => batch.id));
    const unknown = [...ONLY].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Batch tidak dikenal: ${unknown.join(", ")}`);
  }
  return batches.filter((batch) => ONLY.size === 0 || ONLY.has(batch.id));
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (stopRequested) {
        event("forced_termination", { signal });
        process.exit(130);
      }
      stopRequested = true;
      event("stop_requested", { signal, message: "runner berhenti pada titik aman; kirim sinyal lagi untuk paksa" });
      console.error(`\n${signal} diterima; menyelesaikan titik aman saat ini. Tekan lagi untuk paksa.`);
    });
  }
}

async function main() {
  mkdir();
  acquireRunLock();
  ensureCsv();
  installSignalHandlers();
  if (CONFIG_ERROR) throw new Error(CONFIG_ERROR);
  if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS < 1) throw new Error("--max-attempts harus bilangan positif");
  if (!Number.isInteger(CONFIRMATIONS) || CONFIRMATIONS < 1) throw new Error("--confirmations harus bilangan positif");
  if (!Number.isFinite(RECEIPT_TIMEOUT_MS) || RECEIPT_TIMEOUT_MS < 1000) throw new Error("--receipt-timeout-ms minimal 1000");
  const checkpoint = loadCheckpoint();
  saveCheckpoint(checkpoint);
  const batches = buildBatches();
  if (!batches.length) throw new Error("Tidak ada batch yang dipilih");

  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, `${JSON.stringify({
      schema_version: 1, execution_id: EXECUTION_ID, created_at: now(),
      plan_file: PLAN_FILE, manifest_file: MANIFEST_FILE,
      selected_batches: batches.map((b) => b.id), dry_run: DRY_RUN,
      validate_only: VALIDATE_ONLY, preflight_only: PREFLIGHT_ONLY,
      prepare_only: PREPARE_ONLY, confirmations: CONFIRMATIONS,
    }, null, 2)}\n`, "utf8");
  }
  event("campaign_started", {
    selected_batches: batches.map((b) => b.id), dry_run: DRY_RUN,
    prepare_only: PREPARE_ONLY, validate_only: VALIDATE_ONLY, preflight_only: PREFLIGHT_ONLY,
  });
  console.log(`Execution ID : ${EXECUTION_ID}`);
  console.log(`Log          : ${RUN_DIR}`);
  console.log(`Batch        : ${batches.map((b) => b.id).join(", ")}`);
  console.log(`Mode         : ${VALIDATE_ONLY ? "validate-only" : PREFLIGHT_ONLY ? "preflight-only" : DRY_RUN ? "dry-run" : PREPARE_ONLY ? "prepare-only" : "transaksi nyata"}\n`);

  reclassifyExternalBlockers(checkpoint, batches);
  ensureExternalBlockerResults(checkpoint, batches);

  if (VALIDATE_ONLY) {
    event("campaign_validated", { batch_count: batches.length, credential_count: batches.reduce((sum, b) => sum + b.size, 0) });
    console.log(`Manifest dan plan valid: ${batches.length} batch, ${batches.reduce((sum, b) => sum + b.size, 0)} kredensial.`);
    return;
  }

  await login();
  if (PREFLIGHT_ONLY) {
    await initBlockchain("");
    event("campaign_preflighted", { chain_id: chainId, contract_address: contractAddress, wallet_address: wallet.address });
    console.log(`Preflight berhasil: chain ${chainId}, kontrak ${contractAddress}, wallet ${wallet.address}.`);
    return;
  }
  let paused = false;
  for (const batch of batches) {
    if (stopRequested) break;
    try {
      await processBatch(checkpoint, batch, batch.plans);
    } catch (error) {
      if (error instanceof PauseForReconciliation) {
        paused = true;
        event("campaign_paused", { batch_id: batch.id, ...serializeError(error) });
        console.error(`Kampanye dijeda: ${error.message}`);
        break;
      }
      event("campaign_batch_unhandled_error", { batch_id: batch.id, ...serializeError(error) });
      console.error(`${batch.id} error tak tertangani: ${serializeError(error).error_message}`);
    }
  }
  const selectedStates = batches.map((batch) => ({
    batch_id: batch.id,
    phase: checkpoint.batches[batch.id]?.phase || "not_started",
  }));
  const failedCount = selectedStates.filter((item) => ["failed_pre_submit", "reverted"].includes(item.phase)).length;
  const blockedCount = selectedStates.filter((item) => item.phase === "blocked_external").length;
  const verifiedCount = selectedStates.filter((item) => item.phase === "verified").length;
  event(paused || stopRequested || blockedCount > 0 ? "campaign_incomplete" : "campaign_finished", {
    paused, stop_requested: stopRequested, failed_count: failedCount,
    blocked_count: blockedCount, verified_count: verifiedCount, batches: selectedStates,
  });
  console.log(`\nSelesai. Jalankan kembali perintah yang sama untuk resume.`);
  if (paused) process.exitCode = 2;
  else if (failedCount > 0) process.exitCode = 1;
  else if (blockedCount > 0) process.exitCode = 3;
}

main().catch((error) => {
  try {
    mkdir();
    if (runLockAcquired) event("campaign_fatal", serializeError(error));
  } catch (_) { /* jangan menutupi galat awal */ }
  console.error(`Fatal: ${serializeError(error).error_message}`);
  process.exitCode = 1;
});
