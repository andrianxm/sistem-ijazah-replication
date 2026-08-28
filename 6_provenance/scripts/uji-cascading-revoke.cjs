#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.REVOKE_ENV || path.join(ROOT, "sia-simulasi", ".env");
const RUN = process.env.REVOKE_RUN || "cascading-revoke-final-20260809";
const OUT = process.env.REVOKE_LOG_DIR || path.join(__dirname, "pengujian-final", "domain4-final-20260809", "cascade-revoke");
const RESULTS = path.join(OUT, "results.csv");
const EVENTS = path.join(OUT, "events.ndjson");
const CHECKPOINT = path.join(OUT, "checkpoint.json");
const AUDIT = path.join(OUT, "audit.json");
const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const SIVIL = process.env.SIVIL_URL || "http://localhost:8001";
const MYSQL = process.env.MYSQL_CONTAINER || "ijazah-mysql";
const SIVIL_CONTAINER = process.env.SIVIL_CONTAINER || "ijazah-sivil";
const EMAIL = process.env.REKTOR_EMAIL || "rektor@universitas.ac.id";
const PASSWORD = process.env.REKTOR_PASSWORD || "rahasia123";

const CASES = [
  { id: "REV-NORMAL-1", nim: "20210013", mode: "normal" },
  // REV-NORMAL-2 (20210014) dipindahkan menjadi kasus tambahan recovery:
  // tx sukses tetapi pembacaan receipt RPC timeout. Pengganti menjaga n=5 normal.
  { id: "REV-NORMAL-2R", nim: "20210023", mode: "normal" },
  { id: "REV-NORMAL-3", nim: "20210015", mode: "normal" },
  { id: "REV-NORMAL-4", nim: "20210016", mode: "normal" },
  { id: "REV-NORMAL-5", nim: "20210017", mode: "normal" },
  ...["20210018", "20210019", "20210020", "20210021", "20210022"].map((nim, i) => ({ id: `REV-SYNCFAIL-${i + 1}`, nim, mode: "sync_failure" })),
];

const ABI = [
  "function getIjazahData(uint256) view returns(bytes32 hashedNina,bytes32 hashedNim,string cid,string encData,uint256 mintedAt,uint256 updatedAt,bool isActive,address mintedBy)",
];

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
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
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function append(file, text) {
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function event(type, data = {}) {
  append(EVENTS, `${JSON.stringify({ timestamp: new Date().toISOString(), run: RUN, type, ...data })}\n`);
}

function saveCheckpoint(data) {
  const tmp = `${CHECKPOINT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, CHECKPOINT);
}

function mysql(query) {
  return execFileSync("docker", ["exec", MYSQL, "mysql", "-u", "root", `-p${process.env.MYSQL_PASSWORD || "password"}`, "-B", "-N", "-e", query], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshot(nim) {
  if (!/^\d{8}$/.test(nim)) throw new Error(`NIM tidak sah: ${nim}`);
  const line = mysql(`SELECT d.nina,d.token_id,d.status_blockchain,COALESCE(r.status,''),COALESCE(p.status,''),COALESCE(p.status_eligibilitas,''),COALESCE(i.status,''),COALESCE(v.status,'MISSING'),d.tx_hash FROM siakad_db.students s JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN siakad_db.pisn_reservations r ON r.student_id=s.id LEFT JOIN kementerian_db.pddikti_mahasiswa p ON p.nim=s.nim LEFT JOIN kementerian_db.pisn_nina_issued i ON i.nim=s.nim LEFT JOIN sivil_db.sivil_nina_registry v ON v.nina=d.nina WHERE s.nim='${nim}' LIMIT 1;`);
  if (!line) throw new Error(`Snapshot ${nim} tidak ditemukan`);
  const [nina, tokenId, siaDiploma, siaPisn, pddikti, eligibility, pisnIssued, sivil, mintTx] = line.split("\t");
  return { nim, nina, token_id: Number(tokenId), sia_diploma: siaDiploma, sia_pisn: siaPisn, pddikti_status: pddikti, pddikti_eligibility: eligibility, pisn_issued: pisnIssued, sivil_status: sivil, mint_tx: mintTx };
}

function strictCascade(state) {
  return state.sia_diploma === "revoked"
    && state.sia_pisn === "direvoke"
    && state.pddikti_status === "aktif"
    && state.pisn_issued === "direvoke"
    && state.sivil_status !== "aktif"
    && state.sivil_status !== "MISSING";
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pollSnapshot(nim, predicate, timeoutMs = 15000) {
  const start = Date.now();
  let state = snapshot(nim);
  while (!predicate(state) && Date.now() - start < timeoutMs) {
    await sleep(200);
    state = snapshot(nim);
  }
  return { state, elapsed_ms: Date.now() - start };
}

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

async function verifySivil(nina, name) {
  const response = await fetch(`${SIVIL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(name)}`, { headers: { "X-Test-Mode": "1" } });
  const html = await response.text();
  const valid = /const\s+isValid\s*=\s*(true|false)/.exec(html);
  const status = /const\s+sivilStatus\s*=\s*['"]([^'"]*)['"]/.exec(html);
  const bc = /const\s+blockchainData\s*=\s*(\{[^\n]*\})/.exec(html);
  let blockchainActive = null;
  try { blockchainActive = bc ? JSON.parse(bc[1])?.is_active ?? null : null; } catch (_) {}
  if (!valid) throw new Error(`isValid tidak ditemukan untuk ${nina}`);
  return { http_status: response.status, is_valid: valid[1] === "true", sivil_status: status?.[1] || "", blockchain_active: blockchainActive };
}

async function waitSivil() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await fetch(SIVIL); if (r.status < 500) return; } catch (_) {}
    await sleep(500);
  }
  throw new Error("SIVIL tidak kembali sehat dalam 30 detik");
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  loadEnv();
  const rpc = process.env.POLYGON_RPC_URL;
  const address = process.env.CONTRACT_ADDRESS_IJAZAH;
  if (!rpc || !address) throw new Error("RPC/alamat kontrak belum tersedia");
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(address, ABI, provider);
  const checkpoint = fs.existsSync(CHECKPOINT) ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")) : { schema_version: 1, run: RUN, cases: {} };
  if (!fs.existsSync(RESULTS)) append(RESULTS, "case_id,mode,nim,nina,token_id,timestamp_start,timestamp_end,action_latency_ms,first_propagation_ms,recovery_latency_ms,status,expected,actual,tx_hash,receipt_status,gas_used,block_number,sia_diploma_status,sia_pisn_status,pddikti_status,pddikti_eligibility,pisn_issued_status,sivil_initial_status,blockchain_active_initial,verification_valid_initial,sivil_final_status,verification_valid_final,first_attempt_cascade,safety_denial,eventual_consistency,notes\n");

  await login();
  const info = {};
  for (const test of CASES) {
    const savedPhase = checkpoint.cases[test.id]?.phase;
    const params = { query: test.nim };
    if (savedPhase === "revoked" || savedPhase === "verified") params.status = "revoked";
    const diplomas = await action("getDiplomas", params);
    const diploma = diplomas.find((d) => d.student?.nim === test.nim);
    if (!diploma?.tokenId || !diploma?.nina) throw new Error(`${test.nim} tidak memiliki diploma/token/NINA`);
    info[test.nim] = { id: Number(diploma.id), name: diploma.student.name, nina: diploma.nina, token_id: Number(diploma.tokenId) };
  }

  // Semua target harus aktif sebelum mutasi pertama, kecuali kasus yang sudah
  // memiliki checkpoint dari eksekusi terputus.
  for (const test of CASES) {
    if (checkpoint.cases[test.id]?.phase) continue;
    const chain = await contract.getIjazahData(info[test.nim].token_id);
    const state = snapshot(test.nim);
    if (!chain.isActive || state.sivil_status !== "aktif" || state.sia_diploma !== "verified") {
      throw new Error(`Preflight ${test.id} gagal: chain=${chain.isActive} sivil=${state.sivil_status} sia=${state.sia_diploma}`);
    }
  }
  event("preflight_passed", { cases: CASES.length, contract: address, chain_id: (await provider.getNetwork()).chainId.toString() });

  async function revokeOne(test) {
    const current = checkpoint.cases[test.id] || {};
    if (current.phase === "revoked" || current.phase === "verified") return current;
    const target = info[test.nim];
    if (current.phase === "retryable_error") {
      const chainBeforeRetry = await contract.getIjazahData(target.token_id);
      if (chainBeforeRetry.isActive === false) {
        throw new Error(`${test.id}: token sudah nonaktif setelah error RPC; hentikan retry untuk rekonsiliasi manual`);
      }
      event("retry_authorized", { case_id: test.id, prior_error: current.error, retry_count: current.retry_count || 1 });
    }
    const started = Date.now();
    event("revoke_started", { case_id: test.id, mode: test.mode, nim: test.nim, token_id: target.token_id });
    const result = await action("revokeDiplomaFromBlockchain", { diplomaId: target.id, reason: `Uji ${RUN} ${test.id}` });
    if (!result.success || !/^0x[0-9a-f]{64}$/i.test(result.txHash || "")) throw new Error(result.error || `TxHash revoke tidak sah: ${result.txHash}`);
    const receipt = await provider.waitForTransaction(result.txHash, 1, 60000);
    if (!receipt || receipt.status !== 1) throw new Error(`${test.id}: receipt revoke tidak sukses`);
    const saved = {
      phase: "revoked", started_at: new Date(started).toISOString(), action_completed_at: new Date().toISOString(),
      action_latency_ms: Date.now() - started, tx_hash: result.txHash, receipt_status: receipt.status,
      gas_used: receipt.gasUsed.toString(), block_number: receipt.blockNumber,
      retry_count: current.retry_count || 0, prior_errors: current.errors || [],
    };
    checkpoint.cases[test.id] = saved;
    saveCheckpoint(checkpoint);
    event("revoke_confirmed", { case_id: test.id, ...saved });
    return saved;
  }

  // Lima cascade normal.
  for (const test of CASES.filter((x) => x.mode === "normal")) {
    try { await revokeOne(test); }
    catch (error) {
      event("case_error", { case_id: test.id, stage: "normal_revoke", error: error.message });
      const previous = checkpoint.cases[test.id] || {};
      checkpoint.cases[test.id] = { ...previous, phase: "retryable_error", error: error.message, errors: [...(previous.errors || []), error.message], retry_count: (previous.retry_count || 0) + 1, error_at: new Date().toISOString() };
      saveCheckpoint(checkpoint);
    }
  }

  // Lima revoke saat SIVIL sengaja dimatikan. Container selalu dinyalakan lagi.
  const pendingSyncFailure = CASES.filter((x) => x.mode === "sync_failure" && !["revoked", "verified"].includes(checkpoint.cases[x.id]?.phase));
  let stopped = false;
  try {
    if (pendingSyncFailure.length) {
      execFileSync("docker", ["stop", SIVIL_CONTAINER], { stdio: ["ignore", "pipe", "pipe"] });
      stopped = true;
      event("sivil_stopped", { container: SIVIL_CONTAINER, pending_cases: pendingSyncFailure.length });
    }
    for (const test of pendingSyncFailure) {
      try { await revokeOne(test); }
      catch (error) {
        event("case_error", { case_id: test.id, stage: "sync_failure_revoke", error: error.message });
        const previous = checkpoint.cases[test.id] || {};
        checkpoint.cases[test.id] = { ...previous, phase: "retryable_error", error: error.message, errors: [...(previous.errors || []), error.message], retry_count: (previous.retry_count || 0) + 1, error_at: new Date().toISOString() };
        saveCheckpoint(checkpoint);
      }
    }
  } finally {
    if (stopped) {
      execFileSync("docker", ["start", SIVIL_CONTAINER], { stdio: ["ignore", "pipe", "pipe"] });
      event("sivil_started", { container: SIVIL_CONTAINER });
      await waitSivil();
    }
  }

  const verified = [];
  for (const test of CASES) {
    const saved = checkpoint.cases[test.id];
    if (!saved || saved.phase === "retryable_error") continue;
    if (saved.phase === "verified") { verified.push(saved); continue; }
    const target = info[test.nim];
    const first = await pollSnapshot(test.nim, (state) => test.mode === "normal" ? strictCascade(state) : state.sia_diploma === "revoked" && state.pisn_issued === "direvoke");
    const chainInitial = await contract.getIjazahData(target.token_id);
    const verificationInitial = await verifySivil(target.nina, target.name);
    const initialState = { ...first.state };
    const firstCascade = strictCascade(initialState) && chainInitial.isActive === false;
    const safetyDenial = chainInitial.isActive === false && verificationInitial.is_valid === false;
    const sivilInitial = initialState.sivil_status;
    let recoveryLatency = 0;

    if (test.mode === "sync_failure") {
      const recoveryStart = Date.now();
      const response = await fetch(`${PISN}/api/pisn/revoke/${target.nina}`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error(`${test.id}: retry sync HTTP ${response.status}`);
      const recovered = await pollSnapshot(test.nim, (state) => state.sivil_status !== "aktif" && state.sivil_status !== "MISSING");
      recoveryLatency = Date.now() - recoveryStart;
      first.state = recovered.state;
    }

    const finalState = snapshot(test.nim);
    const verificationFinal = await verifySivil(target.nina, target.name);
    const chainFinal = await contract.getIjazahData(target.token_id);
    const eventual = strictCascade(finalState) && chainFinal.isActive === false && verificationFinal.is_valid === false;
    const expectedFailureObserved = test.mode === "normal" || sivilInitial === "aktif";
    const pass = safetyDenial && eventual && expectedFailureObserved;
    const row = {
      ...saved, phase: "verified", case_id: test.id, mode: test.mode, nim: test.nim,
      nina: target.nina, token_id: target.token_id, first_propagation_ms: first.elapsed_ms,
      recovery_latency_ms: recoveryLatency, status: pass ? "pass" : "fail",
      expected: test.mode === "normal" ? "seluruh lapisan revoked pada percobaan pertama" : "sync SIVIL gagal; keputusan tetap invalid; retry memulihkan konsistensi",
      actual: test.mode === "normal" ? `cascade=${firstCascade}` : `sivil_awal=${sivilInitial}; safety=${safetyDenial}; recovered=${eventual}`,
      state_initial: initialState, state_final: finalState,
      blockchain_active_initial: chainInitial.isActive, verification_valid_initial: verificationInitial.is_valid,
      verification_valid_final: verificationFinal.is_valid, first_attempt_cascade: firstCascade,
      safety_denial: safetyDenial, eventual_consistency: eventual, verified_at: new Date().toISOString(),
    };
    const retryNote = saved.retry_count ? `; analysis_role=recovery_after_rpc_error; retry_count=${saved.retry_count}` : "; analysis_role=first_pass";
    const values = [row.case_id,row.mode,row.nim,row.nina,row.token_id,row.started_at,row.verified_at,row.action_latency_ms,row.first_propagation_ms,row.recovery_latency_ms,row.status,row.expected,row.actual,row.tx_hash,row.receipt_status,row.gas_used,row.block_number,row.state_final.sia_diploma,row.state_final.sia_pisn,row.state_final.pddikti_status,row.state_final.pddikti_eligibility,row.state_final.pisn_issued,sivilInitial,row.blockchain_active_initial,row.verification_valid_initial,row.state_final.sivil_status,row.verification_valid_final,row.first_attempt_cascade,row.safety_denial,row.eventual_consistency,(test.mode === "sync_failure" ? "SIVIL dimatikan saat revoke lalu sinkronisasi diulang" : "cascade normal") + retryNote];
    append(RESULTS, `${values.map(csv).join(",")}\n`);
    checkpoint.cases[test.id] = row;
    saveCheckpoint(checkpoint);
    event("case_verified", { case_id: test.id, status: row.status, first_attempt_cascade: firstCascade, safety_denial: safetyDenial, eventual_consistency: eventual });
    verified.push(row);
    console.log(`${test.id}: ${row.status} first=${firstCascade} safety=${safetyDenial} eventual=${eventual}`);
  }

  const passed = verified.filter((x) => x.status === "pass").length;
  const firstCascadePass = verified.filter((x) => x.first_attempt_cascade).length;
  const safetyPass = verified.filter((x) => x.safety_denial).length;
  const eventualPass = verified.filter((x) => x.eventual_consistency).length;
  const audit = {
    schema_version: 1, run: RUN, recorded_at: new Date().toISOString(), status: passed === CASES.length ? "pass" : "fail",
    contract_address: address, chain_id: Number((await provider.getNetwork()).chainId), cases_expected: CASES.length,
    cases_verified: verified.length, cases_passed: passed,
    scr_revoke_first_attempt_percent: verified.length ? (firstCascadePass / verified.length) * 100 : 0,
    safety_denial_percent: verified.length ? (safetyPass / verified.length) * 100 : 0,
    scr_revoke_eventual_percent: verified.length ? (eventualPass / verified.length) * 100 : 0,
    normal_cases: 5, injected_sync_failure_cases: 5, pin_added: 0,
    cases: verified,
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  event("run_completed", { status: audit.status, first_attempt_scr: audit.scr_revoke_first_attempt_percent, safety: audit.safety_denial_percent, eventual_scr: audit.scr_revoke_eventual_percent });
  console.log(JSON.stringify({ status: audit.status, passed: `${passed}/${CASES.length}`, first_attempt_scr: audit.scr_revoke_first_attempt_percent, safety_denial: audit.safety_denial_percent, eventual_scr: audit.scr_revoke_eventual_percent }, null, 2));
  if (audit.status !== "pass") process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack || error.message); event("run_error", { error: error.message }); process.exit(1); });
