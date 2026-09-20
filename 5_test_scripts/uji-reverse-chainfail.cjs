#!/usr/bin/env node
"use strict";

// ===========================================================================
//  UJI ARAH KEGAGALAN TERBALIK — REGISTRI SIVIL DIREVOKE, REVOKE ON-CHAIN GAGAL
// ===========================================================================
//
//  Berkas 14_cascading_revoke_final_10.csv hanya memuat arah kegagalan satu
//  sisi: pencabutan on-chain selalu berhasil lebih dulu (blockchain_active_
//  initial=false) dan yang diinjeksikan adalah kegagalan sinkronisasi registri
//  SIVIL. Reviewer meminta arah sebaliknya diuji secara operasional:
//
//      registri SIVIL sudah direvoke, tetapi transaksi revokeIjazah TIDAK
//      PERNAH masuk blok, sehingga token masih aktif di kontrak.
//
//  Kasus ini HARUS dibedakan dari 15_recovery_timeout_rpc_final_1.csv. Di sana
//  transaksi sudah ter-commit on-chain dan hanya pembacaan receipt yang gagal.
//  Di sini transaksi ditolak pada tahap penyiaran, jadi setiap eksekusi
//  diverifikasi ulang melalui RPC yang benar: token wajib MASIH AKTIF dan hash
//  transaksi yang ditandatangani wajib TIDAK DITEMUKAN di rantai. Kalau ternyata
//  transaksi berhasil masuk blok, eksekusi ditandai tidak valid dan diulang
//  memakai kandidat berikutnya.
//
//  Injeksi kegagalan memakai cara (b): RPC stub lokal yang meneruskan seluruh
//  metode baca ke RPC sebenarnya (chainId, nonce, fee, estimateGas) tetapi
//  menolak eth_sendRawTransaction. Transaksi karenanya benar-benar dibangun dan
//  ditandatangani, lalu gagal tepat pada penyiaran — bukan sekadar endpoint
//  yang tidak dapat dijangkau.
//
//  Skrip ini TIDAK menerbitkan kredensial baru, TIDAK membuat NINA baru, dan
//  TIDAK mengunggah artefak ke IPFS. Hanya kredensial yang masih aktif dari
//  himpunan penerbitan tunggal (token #1001–#1030) yang dipakai.
//
//  Jalankan dari akar paket replikasi:
//      node 5_test_scripts/uji-reverse-chainfail.cjs
// ===========================================================================

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RUN = process.env.REVERSE_RUN || "reverse-chainfail-final";
const OUT = process.env.REVERSE_LOG_DIR
  || path.join(__dirname, "pengujian-final", "reverse-chainfail", "chainfail");
const RESULTS = path.join(ROOT, "3_raw_measurements", "21_reverse_chainfail_final_5.csv");
const EVENTS = path.join(OUT, "events.ndjson");
const CHECKPOINT = path.join(OUT, "checkpoint.json");
const AUDIT = path.join(OUT, "audit.json");
const RUNINFO = path.join(OUT, "run.json");
const RECEIPTS = path.join(OUT, "receipts");

const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const SIVIL = process.env.SIVIL_URL || "http://localhost:8001";
const MYSQL = process.env.MYSQL_CONTAINER || "ijazah-mysql";
const EMAIL = process.env.REKTOR_EMAIL || "rektor@universitas.ac.id";
const PASSWORD = process.env.REKTOR_PASSWORD || "rahasia123";

const TARGET_CASES = Number(process.env.REVERSE_CASES || 5);

// Kandidat diambil dari himpunan penerbitan tunggal token #1001–#1030. Urutan
// berikut adalah urutan pemakaian; sisa daftar berfungsi sebagai cadangan bila
// sebuah eksekusi harus dibatalkan karena injeksi ternyata masuk blok.
const CANDIDATES = (process.env.REVERSE_CANDIDATES || "20210025,20210026,20210027,20210028,20210029,20210024,20210030")
  .split(",").map((x) => x.trim()).filter(Boolean);

const TOKEN_RANGE = { min: 1001, max: 1030 };

const ABI_READ = [
  "function getIjazahData(uint256) view returns(bytes32 hashedNina,bytes32 hashedNim,string cid,string encData,uint256 mintedAt,uint256 updatedAt,bool isActive,address mintedBy)",
  "function getRevokeReason(uint256) view returns(string)",
];
const ABI_WRITE = ["function revokeIjazah(uint256 _tokenId, string _reason)"];

// ---------------------------------------------------------------------------
//  Utilitas dasar
// ---------------------------------------------------------------------------

function loadEnv() {
  const candidates = [
    process.env.REVERSE_ENV,
    path.join(ROOT, "sia-simulasi", ".env"),
    path.join(ROOT, "..", "sia-simulasi", ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
    return file;
  }
  return null;
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function event(type, data = {}) {
  append(EVENTS, `${JSON.stringify({ timestamp: new Date().toISOString(), run: RUN, type, ...data })}\n`);
}

function saveCheckpoint(data) {
  fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
  const tmp = `${CHECKPOINT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, CHECKPOINT);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Ethers membungkus galat JSON-RPC, sehingga pesan asli dari stub berada di
// error.info.error.message. Ketiganya direkam supaya jejak injeksi lengkap.
function describeError(error) {
  if (!error) return null;
  return {
    short_message: error.shortMessage || null,
    message: error.message || null,
    code: error.code || null,
    rpc_error: error.info?.error?.message || error.error?.message || null,
  };
}

function median(values) {
  const list = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

// ---------------------------------------------------------------------------
//  Pembacaan rantai yang tahan gangguan RPC publik
// ---------------------------------------------------------------------------
//
//  RPC publik Amoy sesekali mengembalikan CALL_EXCEPTION "missing revert data"
//  untuk panggilan view yang sah. Gangguan transport semacam itu tidak boleh
//  disalahartikan sebagai keadaan rantai. Setiap pembacaan karena itu diulang,
//  dan mulai percobaan ketiga dialihkan ke node kedua yang independen supaya
//  klaim "token masih aktif" tidak bergantung pada satu penyedia.

let READERS = [];

async function withRetry(label, fn, attempts = 6) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try { return await fn(i); } catch (error) {
      lastError = error;
      event("rpc_retry", { label, attempt: i, error: error?.shortMessage || error?.message || String(error) });
      await sleep(Math.min(3000, 400 * i));
    }
  }
  throw lastError;
}

function readerFor(attempt) {
  if (attempt >= 3 && READERS.length > 1) return READERS[(attempt - 3) % READERS.length];
  return READERS[0];
}

async function readIjazah(tokenId) {
  return withRetry(`getIjazahData(${tokenId})`, (attempt) => readerFor(attempt).contract.getIjazahData(tokenId));
}

async function lookupTransaction(hash) {
  return withRetry(`getTransaction(${hash})`, (attempt) => readerFor(attempt).provider.getTransaction(hash));
}

let STATIC_PROBES = [];

// Membaca apakah panggilan revoke berikutnya akan di-revert oleh modifier
// tokenAktif. Memakai staticCall sehingga tidak ada transaksi tambahan yang
// dikirim. Revert asli selalu membawa error.reason; galat transport tidak,
// sehingga keduanya dapat dibedakan dan hanya galat transport yang diulang.
async function probeRevokeRevert(tokenId, reason) {
  let lastTransportError = null;
  for (let i = 1; i <= 6; i += 1) {
    const probe = STATIC_PROBES[i >= 3 && STATIC_PROBES.length > 1 ? (i - 3) % STATIC_PROBES.length : 0];
    try {
      await probe.revokeIjazah.staticCall(tokenId, reason);
      return { reverted: false, reason: null, attempts: i };
    } catch (error) {
      if (error?.reason) return { reverted: true, reason: error.reason, attempts: i };
      lastTransportError = error?.shortMessage || error?.message || String(error);
      event("revert_probe_retry", { token_id: tokenId, attempt: i, error: lastTransportError });
      await sleep(Math.min(3000, 400 * i));
    }
  }
  return { reverted: null, reason: `tidak terbaca (galat transport RPC: ${lastTransportError})`, attempts: 6 };
}

// ---------------------------------------------------------------------------
//  Pembacaan state lintas basis data
// ---------------------------------------------------------------------------

function mysql(query) {
  return execFileSync("docker", ["exec", MYSQL, "mysql", "-u", "root", `-p${process.env.MYSQL_PASSWORD || "password"}`, "-B", "-N", "-e", query], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshot(nim) {
  if (!/^\d{8}$/.test(nim)) throw new Error(`NIM tidak sah: ${nim}`);
  const line = mysql(`SELECT d.nina,d.token_id,d.status_blockchain,COALESCE(r.status,''),COALESCE(p.status,''),COALESCE(p.status_eligibilitas,''),COALESCE(i.status,''),COALESCE(v.status,'MISSING'),s.name FROM siakad_db.students s JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN siakad_db.pisn_reservations r ON r.student_id=s.id LEFT JOIN kementerian_db.pddikti_mahasiswa p ON p.nim=s.nim LEFT JOIN kementerian_db.pisn_nina_issued i ON i.nim=s.nim LEFT JOIN sivil_db.sivil_nina_registry v ON v.nina=d.nina WHERE s.nim='${nim}' LIMIT 1;`);
  if (!line) throw new Error(`Snapshot ${nim} tidak ditemukan`);
  const [nina, tokenId, siaDiploma, siaPisn, pddikti, eligibility, pisnIssued, sivil, name] = line.split("\t");
  return {
    nim, nina, name, token_id: Number(tokenId), sia_diploma: siaDiploma, sia_pisn: siaPisn,
    pddikti_status: pddikti, pddikti_eligibility: eligibility, pisn_issued: pisnIssued, sivil_status: sivil,
  };
}

// Predikat konsistensi penuh, identik dengan yang dipakai uji-cascading-revoke.cjs
// agar kolom eventual_consistency dapat dibandingkan langsung dengan berkas 14.
function strictCascade(state) {
  return state.sia_diploma === "revoked"
    && state.sia_pisn === "direvoke"
    && state.pddikti_status === "aktif"
    && state.pisn_issued === "direvoke"
    && state.sivil_status !== "aktif"
    && state.sivil_status !== "MISSING";
}

async function pollSnapshot(nim, predicate, timeoutMs = 20000) {
  const start = Date.now();
  let state = snapshot(nim);
  while (!predicate(state) && Date.now() - start < timeoutMs) {
    await sleep(200);
    state = snapshot(nim);
  }
  return { state, elapsed_ms: Date.now() - start, satisfied: predicate(state) };
}

function bookkeeping() {
  const line = mysql("SELECT (SELECT COUNT(*) FROM siakad_db.students),(SELECT COUNT(*) FROM siakad_db.diplomas),(SELECT COUNT(*) FROM siakad_db.diplomas WHERE token_id BETWEEN 1001 AND 1200);");
  const [students, diplomas, tokens] = line.split("\t").map(Number);
  return { students, diplomas, tokens_1001_1200: tokens };
}

function lastVerificationLog(nina) {
  const line = mysql(`SELECT id,sivil_valid,sivil_status,blockchain_valid,dual_verified FROM sivil_db.verifikasi_logs WHERE nina='${nina}' ORDER BY id DESC LIMIT 1;`);
  if (!line) return null;
  const [id, sivilValid, sivilStatus, blockchainValid, dualVerified] = line.split("\t");
  return {
    log_id: Number(id), sivil_valid: sivilValid === "1", sivil_status: sivilStatus,
    blockchain_valid: blockchainValid === "1", dual_verified: dualVerified === "1",
  };
}

// ---------------------------------------------------------------------------
//  Portal SIVIL — verifikasi dua lapis
// ---------------------------------------------------------------------------

async function verifySivil(nina, name) {
  const response = await fetch(`${SIVIL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(name)}`, { headers: { "X-Test-Mode": "1" } });
  const html = await response.text();
  const valid = /const\s+isValid\s*=\s*(true|false)/.exec(html);
  const status = /const\s+sivilStatus\s*=\s*['"]([^'"]*)['"]/.exec(html);
  const bc = /const\s+blockchainData\s*=\s*(\{[^\n]*\});/.exec(html);
  if (!valid) throw new Error(`isValid tidak ditemukan untuk ${nina}`);
  let blockchain = null;
  try { blockchain = bc ? JSON.parse(bc[1]) : null; } catch (_) { blockchain = null; }
  const sivilStatus = status?.[1] || "";
  const sivilLayerValid = sivilStatus === "found";
  const chainLayerValid = blockchain ? blockchain.valid === true && blockchain.is_active === true : false;
  const rejecting = [];
  if (!sivilLayerValid) rejecting.push("sivil_registry");
  if (!chainLayerValid) rejecting.push("blockchain");
  return {
    http_status: response.status,
    is_valid: valid[1] === "true",
    sivil_status: sivilStatus,
    sivil_layer_valid: sivilLayerValid,
    blockchain_layer_valid: chainLayerValid,
    blockchain_active: blockchain?.is_active ?? null,
    blockchain_message: blockchain?.message ?? null,
    rejecting_layers: rejecting,
    log: lastVerificationLog(nina),
  };
}

// ---------------------------------------------------------------------------
//  Sesi SIAKAD
// ---------------------------------------------------------------------------

let COOKIE = "";
function takeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const part = raw.split(";")[0];
    if (!/^(authjs|next-auth)\./.test(part)) continue;
    const name = part.split("=")[0];
    COOKIE = COOKIE.split("; ").filter((x) => x && !x.startsWith(`${name}=`)).concat(part).join("; ");
  }
}

async function login() {
  const csrf = await fetch(`${SIAKAD}/api/auth/csrf`);
  takeCookies(csrf);
  const { csrfToken } = await csrf.json();
  const response = await fetch(`${SIAKAD}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: COOKIE },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, redirect: "false" }),
  });
  takeCookies(response);
  const check = await (await fetch(`${SIAKAD}/api/eksperimen`, { headers: { Cookie: COOKIE } })).json();
  if (!check.terautentikasi || check.role !== "master") throw new Error("Login master gagal");
}

async function action(name, params) {
  const response = await fetch(`${SIAKAD}/api/eksperimen`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ aksi: name, params }),
  });
  const body = await response.json();
  if (!body.success) throw new Error(`${name}: ${body.error}`);
  return body.hasil;
}

// ---------------------------------------------------------------------------
//  RPC stub — cara (b): menolak eth_sendRawTransaction
// ---------------------------------------------------------------------------
//
//  Seluruh metode baca diteruskan ke RPC sebenarnya supaya nonce, fee, dan
//  estimasi gas benar dan transaksi ditandatangani seperti biasa. Hanya
//  penyiaran yang ditolak, dan raw transaction yang ditolak disimpan supaya
//  hash-nya dapat dicari di rantai sebagai bukti transaksi tidak pernah ada.

function startRpcStub(realUrl) {
  const rejected = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (_) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      }
      const isBatch = Array.isArray(payload);
      const items = isBatch ? payload : [payload];
      const answered = [];
      const forwarded = [];
      for (const item of items) {
        if (item && item.method === "eth_sendRawTransaction") {
          const raw = item.params?.[0];
          rejected.push({ raw, at: new Date().toISOString(), hash: raw ? ethers.keccak256(raw) : null });
          answered.push({
            jsonrpc: "2.0", id: item.id,
            error: { code: -32000, message: "RPC stub uji menolak eth_sendRawTransaction: transaksi tidak disiarkan ke jaringan" },
          });
        } else {
          forwarded.push(item);
        }
      }
      if (forwarded.length) {
        try {
          const upstream = await fetch(realUrl, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(isBatch ? forwarded : forwarded[0]),
          });
          const parsed = await upstream.json();
          answered.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch (error) {
          for (const item of forwarded) {
            answered.push({ jsonrpc: "2.0", id: item.id, error: { code: -32603, message: `stub gagal meneruskan: ${error.message}` } });
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(isBatch ? answered : answered[0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, rejected, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// ---------------------------------------------------------------------------
//  Program utama
// ---------------------------------------------------------------------------

const HEADER = "case_id,mode,nim,nina,token_id,timestamp_start,timestamp_end,action_latency_ms,first_propagation_ms,recovery_latency_ms,status,expected,actual,tx_hash,receipt_status,gas_used,block_number,sia_diploma_status,sia_pisn_status,pddikti_status,pddikti_eligibility,pisn_issued_status,sivil_initial_status,blockchain_active_initial,verification_valid_initial,sivil_final_status,verification_valid_final,first_attempt_cascade,safety_denial,eventual_consistency,notes,blockchain_active_final,detection_method,detection_latency_ms";

const EXPECTED = "registri SIVIL direvoke lebih dulu; revoke on-chain gagal sebelum masuk blok; keputusan verifikasi tetap invalid; rekonsiliasi mengirim ulang revoke dan memulihkan konsistensi";

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(RECEIPTS, { recursive: true });
  const envFile = loadEnv();
  if (!envFile) throw new Error("Berkas .env sia-simulasi tidak ditemukan");

  const rpc = process.env.POLYGON_RPC_URL;
  const address = process.env.CONTRACT_ADDRESS_IJAZAH;
  const privateKey = process.env.REKTOR_PRIVATE_KEY;
  if (!rpc || !address) throw new Error("RPC/alamat kontrak belum tersedia");
  if (!privateKey) throw new Error("REKTOR_PRIVATE_KEY belum tersedia di environment");

  const provider = new ethers.JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  READERS = [{ url: rpc, provider, contract: new ethers.Contract(address, ABI_READ, provider) }];
  const fallbackRpc = process.env.REVERSE_RPC_FALLBACK || "https://80002.rpc.thirdweb.com";
  if (fallbackRpc && fallbackRpc !== rpc) {
    const fallbackProvider = new ethers.JsonRpcProvider(fallbackRpc, Number(network.chainId), { staticNetwork: true });
    READERS.push({ url: fallbackRpc, provider: fallbackProvider, contract: new ethers.Contract(address, ABI_READ, fallbackProvider) });
  }

  const stub = await startRpcStub(rpc);
  const stubProvider = new ethers.JsonRpcProvider(stub.url, Number(network.chainId), { batchMaxCount: 1, staticNetwork: true });
  const stubWallet = new ethers.Wallet(privateKey, stubProvider);
  const stubContract = new ethers.Contract(address, ABI_WRITE, stubWallet);
  // Kontrak khusus staticCall untuk memeriksa revert tanpa mengirim transaksi.
  STATIC_PROBES = READERS.map((r) => new ethers.Contract(address, ABI_WRITE, new ethers.Wallet(privateKey, r.provider)));

  const booksBefore = bookkeeping();
  fs.writeFileSync(RUNINFO, `${JSON.stringify({
    schema_version: 1, run: RUN, started_at: new Date().toISOString(),
    node_version: process.version, contract_address: address, chain_id: Number(network.chainId),
    rpc_host: new URL(rpc).host, read_rpc_hosts: READERS.map((r) => new URL(r.url).host),
    injection_method: "b_local_rpc_stub_reject_eth_sendRawTransaction",
    stub_url: stub.url, target_cases: TARGET_CASES, candidate_pool: CANDIDATES,
    bookkeeping_before: booksBefore,
  }, null, 2)}\n`);
  event("run_started", { contract: address, chain_id: Number(network.chainId), bookkeeping: booksBefore, injection_method: "b_local_rpc_stub_reject_eth_sendRawTransaction" });

  if (booksBefore.students !== 212 || booksBefore.diplomas !== 200 || booksBefore.tokens_1001_1200 !== 200) {
    throw new Error(`Pembukuan awal tidak utuh: ${JSON.stringify(booksBefore)}`);
  }

  const checkpoint = fs.existsSync(CHECKPOINT) ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")) : { schema_version: 1, run: RUN, cases: {}, invalid: [] };
  if (!fs.existsSync(RESULTS)) append(RESULTS, `${HEADER}\n`);
  const alreadyWritten = new Set(
    fs.readFileSync(RESULTS, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((line) => line.split(",")[0])
  );

  await login();

  const rows = [];
  const invalidRuns = [];
  let caseNumber = alreadyWritten.size + 1;

  for (const nim of CANDIDATES) {
    if (rows.length + alreadyWritten.size >= TARGET_CASES) break;
    const caseId = `REV-CHAINFAIL-${caseNumber}`;
    if (alreadyWritten.has(caseId)) { caseNumber += 1; continue; }

    // === 1. Pilih kredensial yang masih aktif; buktikan belum pernah dicabut ===
    const preState = snapshot(nim);
    if (preState.token_id < TOKEN_RANGE.min || preState.token_id > TOKEN_RANGE.max) {
      throw new Error(`${nim}: token ${preState.token_id} di luar himpunan penerbitan tunggal`);
    }
    const preChain = await readIjazah(preState.token_id);
    const eligible = preChain.isActive === true && preState.sivil_status === "aktif" && preState.sia_diploma === "verified" && preState.pisn_issued === "aktif";
    event("candidate_screened", { nim, token_id: preState.token_id, chain_active: preChain.isActive, state: preState, eligible });
    if (!eligible) {
      console.log(`lewati ${nim}: bukan kredensial aktif (chain=${preChain.isActive} sivil=${preState.sivil_status} sia=${preState.sia_diploma})`);
      continue;
    }

    const diplomas = await action("getDiplomas", { query: nim });
    const diploma = diplomas.find((d) => d.student?.nim === nim);
    if (!diploma?.id || !diploma?.tokenId) throw new Error(`${nim}: diploma/token tidak ditemukan di SIAKAD`);
    const target = { diploma_id: Number(diploma.id), nim, nina: preState.nina, name: preState.name, token_id: preState.token_id };

    // === 2. timestamp_start ===
    const startedAt = Date.now();
    event("case_started", { case_id: caseId, ...target });

    // === 3. Cabut registri SIVIL lebih dulu ===
    const propagationStart = Date.now();
    const registryResponse = await fetch(`${PISN}/api/pisn/revoke/${encodeURIComponent(target.nina)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    if (!registryResponse.ok) throw new Error(`${caseId}: revoke registri HTTP ${registryResponse.status}`);
    const propagation = await pollSnapshot(nim, (s) => s.sivil_status === "direvoke");
    const firstPropagationMs = Date.now() - propagationStart;
    if (!propagation.satisfied) throw new Error(`${caseId}: registri SIVIL tidak berubah menjadi direvoke`);
    event("sivil_registry_revoked", { case_id: caseId, first_propagation_ms: firstPropagationMs, state: propagation.state });

    // === 4. Injeksi kegagalan on-chain ===
    const rejectedBefore = stub.rejected.length;
    const injectionStart = Date.now();
    let injectionError = null;
    let injectionUnexpectedHash = null;
    try {
      const tx = await stubContract.revokeIjazah(target.token_id, `Uji ${RUN} ${caseId} (injeksi kegagalan RPC)`);
      injectionUnexpectedHash = tx.hash;
    } catch (error) {
      injectionError = error;
    }
    const injectionMs = Date.now() - injectionStart;
    const signedAttempts = stub.rejected.slice(rejectedBefore);
    const unsentHash = signedAttempts.at(-1)?.hash || null;
    event("chain_injection", {
      case_id: caseId, method: "b_local_rpc_stub_reject_eth_sendRawTransaction",
      duration_ms: injectionMs, error: describeError(injectionError),
      signed_but_unsent_tx_hash: unsentHash, signed_attempts: signedAttempts.length,
      unexpected_broadcast_hash: injectionUnexpectedHash,
    });

    // === 4b. Verifikasi ke RPC yang benar: token HARUS masih aktif ===
    const chainAfterInjection = await readIjazah(target.token_id);
    const unsentLookup = unsentHash ? await lookupTransaction(unsentHash) : null;
    const injectionValid = injectionError !== null
      && chainAfterInjection.isActive === true
      && unsentHash !== null
      && unsentLookup === null;
    event("injection_verified", {
      case_id: caseId, chain_active_after_injection: chainAfterInjection.isActive,
      unsent_tx_found_onchain: unsentLookup !== null, injection_valid: injectionValid,
    });

    if (!injectionValid) {
      const reason = injectionError === null
        ? "transaksi justru berhasil disiarkan"
        : chainAfterInjection.isActive !== true
          ? "token sudah nonaktif on-chain setelah injeksi"
          : unsentLookup !== null
            ? "transaksi yang ditandatangani ternyata ditemukan di rantai"
            : "raw transaction tidak tertangkap stub";
      const record = { case_id: caseId, nim, token_id: target.token_id, reason, at: new Date().toISOString() };
      invalidRuns.push(record);
      checkpoint.invalid = [...(checkpoint.invalid || []), record];
      saveCheckpoint(checkpoint);
      event("execution_invalid", record);
      console.log(`${caseId} TIDAK VALID pada ${nim}: ${reason} — diulang dengan kandidat berikutnya`);
      continue;
    }

    // === 5. Kondisi awal tercatat ===
    const stateInitial = snapshot(nim);
    const blockchainActiveInitial = chainAfterInjection.isActive;
    const sivilInitialStatus = stateInitial.sivil_status;

    // === 6. Verifikasi dua lapis melalui portal SIVIL ===
    const verificationInitial = await verifySivil(target.nina, target.name);
    event("verification_initial", { case_id: caseId, ...verificationInitial });

    // === 7. Deteksi ketidaksesuaian, diukur dari pemicu rekonsiliasi ===
    const reconciliationTrigger = Date.now();
    event("reconciliation_triggered", { case_id: caseId, trigger_at: new Date(reconciliationTrigger).toISOString() });
    const reconciliationRegistry = snapshot(nim);
    const reconciliationChain = await readIjazah(target.token_id);
    const mismatch = reconciliationRegistry.sivil_status === "direvoke" && reconciliationChain.isActive === true;
    const detectionLatencyMs = Date.now() - reconciliationTrigger;
    const detectionMethod = "reconciliation_read_onchain_status";
    event("mismatch_detected", {
      case_id: caseId, detection_method: detectionMethod, detection_latency_ms: detectionLatencyMs,
      registry_status: reconciliationRegistry.sivil_status, chain_active: reconciliationChain.isActive, mismatch,
    });
    if (!mismatch) throw new Error(`${caseId}: rekonsiliasi tidak menemukan ketidaksesuaian yang diharapkan`);

    // === 8. Pemulihan: kirim ulang revoke melalui RPC yang benar ===
    const recovery = await action("revokeDiplomaFromBlockchain", { diplomaId: target.diploma_id, reason: `Rekonsiliasi ${RUN} ${caseId}` });
    if (!recovery.success || !/^0x[0-9a-f]{64}$/i.test(recovery.txHash || "")) {
      throw new Error(recovery.error || `${caseId}: txHash pemulihan tidak sah: ${recovery.txHash}`);
    }
    const receipt = await provider.waitForTransaction(recovery.txHash, 1, 180000);
    if (!receipt || receipt.status !== 1) throw new Error(`${caseId}: receipt pemulihan tidak sukses`);
    const confirmed = await (async () => {
      const deadline = Date.now() + 60000;
      let data = await readIjazah(target.token_id);
      while (data.isActive !== false && Date.now() < deadline) {
        await sleep(500);
        data = await readIjazah(target.token_id);
      }
      return data;
    })();
    const recoveryLatencyMs = Date.now() - reconciliationTrigger;
    if (confirmed.isActive !== false) throw new Error(`${caseId}: token tidak terkonfirmasi revoked on-chain`);
    fs.writeFileSync(path.join(RECEIPTS, `${caseId}.json`), `${JSON.stringify({
      case_id: caseId, tx_hash: receipt.hash, status: receipt.status, block_number: receipt.blockNumber,
      gas_used: receipt.gasUsed.toString(), effective_gas_price: receipt.gasPrice?.toString() ?? null,
      from: receipt.from, to: receipt.to, signed_but_unsent_tx_hash: unsentHash,
    }, null, 2)}\n`);
    event("recovery_confirmed", {
      case_id: caseId, tx_hash: receipt.hash, block_number: receipt.blockNumber,
      gas_used: receipt.gasUsed.toString(), recovery_latency_ms: recoveryLatencyMs,
    });

    // === 9. Apakah transaksi revoke kedua benar-benar diperlukan? ===
    // Bukti positif: sebelum pemulihan token masih aktif (jadi transaksi kedua
    // wajib), dan sesudah pemulihan panggilan revoke berikutnya di-revert oleh
    // modifier tokenAktif. Pemeriksaan revert memakai staticCall sehingga tidak
    // ada transaksi tambahan yang dikirim.
    const revertProbe = await probeRevokeRevert(target.token_id, `Uji revert ${caseId}`);
    const revertReason = revertProbe.reverted === true ? revertProbe.reason
      : revertProbe.reverted === false ? "tidak revert" : revertProbe.reason;
    const secondTxRequired = blockchainActiveInitial === true && receipt.status === 1;
    event("second_tx_assessment", { case_id: caseId, second_tx_required: secondTxRequired, post_revoke_staticcall_revert: revertReason, revert_probe: revertProbe });

    // === 10. Verifikasi ulang dan konsistensi akhir ===
    const finalPoll = await pollSnapshot(nim, strictCascade);
    const stateFinal = finalPoll.state;
    const verificationFinal = await verifySivil(target.nina, target.name);
    const chainFinal = await readIjazah(target.token_id);
    const eventual = strictCascade(stateFinal) && chainFinal.isActive === false && verificationFinal.is_valid === false;
    const endedAt = Date.now();

    // first_attempt_cascade: semantik berkas 14 — seluruh lapisan lokal revoked
    // DAN token nonaktif on-chain pada percobaan pertama. Pada mode ini selalu
    // false karena transaksi on-chain tidak pernah masuk blok.
    const firstAttemptCascade = strictCascade(stateInitial) && blockchainActiveInitial === false;
    // safety_denial: semantik berkas 14 — portal menolak keputusan valid ketika
    // kredensial sudah direvoke pada lapisan otoritatif. Di berkas 14 lapisan
    // otoritatif yang lebih dulu berubah adalah on-chain; pada mode terbalik ini
    // lapisan tersebut adalah registri SIVIL.
    const safetyDenial = sivilInitialStatus === "direvoke" && verificationInitial.is_valid === false;

    const pass = injectionValid && verificationInitial.is_valid === false && mismatch && eventual && safetyDenial;
    const notes = [
      "registri SIVIL direvoke lebih dulu; revoke on-chain diinjeksi gagal",
      "injection_method=b_local_rpc_stub_reject_eth_sendRawTransaction",
      `signed_but_unsent_tx_hash=${unsentHash}`,
      `injection_rpc_error=${describeError(injectionError)?.rpc_error || describeError(injectionError)?.short_message}`,
      "unsent_tx_onchain_lookup=null (berbeda dari kasus receipt-timeout berkas 15 yang sudah ter-commit)",
      `rejecting_layer=${verificationInitial.rejecting_layers.join("+")}`,
      `blockchain_layer_initial_valid=${verificationInitial.blockchain_layer_valid}`,
      `second_revoke_tx_required=${secondTxRequired} (token masih aktif saat rekonsiliasi; kontrak tidak revert)`,
      `post_revoke_staticcall_revert=${revertReason}`,
      "safety_denial memakai lapisan otoritatif registri SIVIL (di berkas 14 lapisan tersebut adalah on-chain)",
      "action_latency_ms = timestamp_end - timestamp_start",
      "analysis_role=first_pass",
    ].join("; ");

    const row = {
      case_id: caseId, mode: "chain_failure", nim, nina: target.nina, token_id: target.token_id,
      timestamp_start: new Date(startedAt).toISOString(), timestamp_end: new Date(endedAt).toISOString(),
      action_latency_ms: endedAt - startedAt, first_propagation_ms: firstPropagationMs,
      recovery_latency_ms: recoveryLatencyMs, status: pass ? "pass" : "fail",
      expected: EXPECTED,
      actual: `chain_awal_aktif=${blockchainActiveInitial}; sivil_awal=${sivilInitialStatus}; ditolak_lapis=${verificationInitial.rejecting_layers.join("+")}; terdeteksi=${mismatch}; recovered=${eventual}`,
      tx_hash: receipt.hash, receipt_status: receipt.status, gas_used: receipt.gasUsed.toString(),
      block_number: receipt.blockNumber,
      sia_diploma_status: stateFinal.sia_diploma, sia_pisn_status: stateFinal.sia_pisn,
      pddikti_status: stateFinal.pddikti_status, pddikti_eligibility: stateFinal.pddikti_eligibility,
      pisn_issued_status: stateFinal.pisn_issued, sivil_initial_status: sivilInitialStatus,
      blockchain_active_initial: blockchainActiveInitial, verification_valid_initial: verificationInitial.is_valid,
      sivil_final_status: stateFinal.sivil_status, verification_valid_final: verificationFinal.is_valid,
      first_attempt_cascade: firstAttemptCascade, safety_denial: safetyDenial, eventual_consistency: eventual,
      notes,
      blockchain_active_final: chainFinal.isActive,
      detection_method: detectionMethod, detection_latency_ms: detectionLatencyMs,
    };

    append(RESULTS, `${HEADER.split(",").map((key) => csv(row[key])).join(",")}\n`);
    rows.push(row);
    checkpoint.cases[caseId] = {
      ...row, state_initial: stateInitial, state_final: stateFinal,
      verification_initial: verificationInitial, verification_final: verificationFinal,
      signed_but_unsent_tx_hash: unsentHash, injection_error: describeError(injectionError),
      second_tx_required: secondTxRequired, post_revoke_staticcall_revert: revertReason,
    };
    saveCheckpoint(checkpoint);
    event("case_completed", { case_id: caseId, status: row.status, eventual_consistency: eventual });
    console.log(`${caseId} (${nim}/token ${target.token_id}): ${row.status} chain_awal_aktif=${blockchainActiveInitial} verif_awal=${verificationInitial.is_valid} deteksi=${detectionLatencyMs}ms pemulihan=${recoveryLatencyMs}ms eventual=${eventual}`);
    caseNumber += 1;
  }

  await stub.close();

  const booksAfter = bookkeeping();
  const summary = {
    executions: rows.length,
    verification_valid_initial_false: rows.filter((r) => r.verification_valid_initial === false).length,
    eventual_consistency_true: rows.filter((r) => r.eventual_consistency === true).length,
    median_first_propagation_ms: median(rows.map((r) => r.first_propagation_ms)),
    median_detection_latency_ms: median(rows.map((r) => r.detection_latency_ms)),
    median_recovery_latency_ms: median(rows.map((r) => r.recovery_latency_ms)),
  };

  const audit = {
    schema_version: 1, run: RUN, recorded_at: new Date().toISOString(),
    mode: "chain_failure",
    status: rows.length === TARGET_CASES && rows.every((r) => r.status === "pass") ? "pass" : "fail",
    contract_address: address, chain_id: Number(network.chainId),
    injection_method: "b_local_rpc_stub_reject_eth_sendRawTransaction",
    read_rpc_hosts: READERS.map((r) => new URL(r.url).host),
    distinguishing_check: "token diverifikasi MASIH AKTIF melalui RPC yang benar dan hash transaksi yang ditandatangani tidak ditemukan di rantai",
    cases_expected: TARGET_CASES, cases_valid: rows.length, invalid_executions: invalidRuns,
    bookkeeping_before: booksBefore, bookkeeping_after: booksAfter,
    summary, cases: rows,
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  event("run_completed", { status: audit.status, ...summary });

  console.log("");
  console.log("=== RINGKASAN UJI REVERSE CHAIN-FAILURE ===");
  console.log(`jumlah eksekusi                      : ${summary.executions}`);
  console.log(`verification_valid_initial == false  : ${summary.verification_valid_initial_false}`);
  console.log(`eventual_consistency == true         : ${summary.eventual_consistency_true}`);
  console.log(`median first_propagation_ms          : ${summary.median_first_propagation_ms}`);
  console.log(`median detection_latency_ms          : ${summary.median_detection_latency_ms}`);
  console.log(`median recovery_latency_ms           : ${summary.median_recovery_latency_ms}`);
  console.log(`eksekusi tidak valid (diulang)       : ${invalidRuns.length}`);
  console.log(`pembukuan (mahasiswa/ijazah/token)   : ${booksAfter.students}/${booksAfter.diplomas}/${booksAfter.tokens_1001_1200}`);
  console.log(`berkas hasil                         : ${path.relative(process.cwd(), RESULTS)}`);
  console.log(`log mentah                           : ${path.relative(process.cwd(), OUT)}`);

  if (audit.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  try { event("run_error", { error: error.message }); } catch (_) {}
  process.exit(1);
});
