#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const OUT = process.env.REVOKE_LOG_DIR || path.join(__dirname, "pengujian-final", "domain4-final-20260809", "cascade-revoke");
const AUDIT = path.join(OUT, "rpc-receipt-timeout-recovery.json");
const EVENTS = path.join(OUT, "recovery-events.ndjson");
const TX_HASH = "0x118752ceeb42d339ecda6f2b0147e2d80f18a1aae0154d37ee994a67b364a3e9";
const NIM = "20210014";
const TOKEN_ID = 1013;
const MYSQL = process.env.MYSQL_CONTAINER || "ijazah-mysql";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const SIVIL = process.env.SIVIL_URL || "http://localhost:8001";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
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
}

function appendEvent(type, data = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const fd = fs.openSync(EVENTS, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify({ timestamp: new Date().toISOString(), type, nim: NIM, token_id: TOKEN_ID, tx_hash: TX_HASH, ...data })}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function mysql(query) {
  return execFileSync("docker", ["exec", MYSQL, "mysql", "-u", "root", `-p${process.env.MYSQL_PASSWORD || "password"}`, "-B", "-N", "-e", query], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshot() {
  const line = mysql(`SELECT d.id,s.name,d.diploma_number,d.ipfs_hash,d.nina,d.token_id,d.status_blockchain,COALESCE(r.status,''),COALESCE(p.status,''),COALESCE(p.status_eligibilitas,''),COALESCE(i.status,''),COALESCE(v.status,'MISSING') FROM siakad_db.students s JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN siakad_db.pisn_reservations r ON r.student_id=s.id LEFT JOIN kementerian_db.pddikti_mahasiswa p ON p.nim=s.nim LEFT JOIN kementerian_db.pisn_nina_issued i ON i.nim=s.nim LEFT JOIN sivil_db.sivil_nina_registry v ON v.nina=d.nina WHERE s.nim='${NIM}' LIMIT 1;`);
  if (!line) throw new Error(`State ${NIM} tidak ditemukan`);
  const [diplomaId, name, diplomaNumber, cid, nina, tokenId, siaDiploma, siaPisn, pddikti, eligibility, pisnIssued, sivil] = line.split("\t");
  return { diploma_id: Number(diplomaId), nim: NIM, name, diploma_number: diplomaNumber, cid, nina, token_id: Number(tokenId), sia_diploma: siaDiploma, sia_pisn: siaPisn, pddikti_status: pddikti, pddikti_eligibility: eligibility, pisn_issued: pisnIssued, sivil_status: sivil };
}

async function verify(nina, name) {
  const response = await fetch(`${SIVIL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(name)}`, { headers: { "X-Test-Mode": "1" } });
  const html = await response.text();
  const valid = /const\s+isValid\s*=\s*(true|false)/.exec(html);
  const status = /const\s+sivilStatus\s*=\s*['"]([^'"]*)['"]/.exec(html);
  if (!valid) throw new Error("Variabel isValid tidak ditemukan saat audit recovery");
  return { http_status: response.status, is_valid: valid[1] === "true", sivil_status: status?.[1] || "" };
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  if (!response.ok || parsed?.success === false) throw new Error(`Recovery HTTP ${response.status} ${url}: ${text}`);
  return { http_status: response.status, body: parsed };
}

async function main() {
  loadEnv(path.join(ROOT, "sia-simulasi", ".env"));
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS_IJAZAH, [
    "function getIjazahData(uint256) view returns(bytes32,bytes32,string,string,uint256,uint256,bool isActive,address)",
  ], provider);

  const initial = snapshot();
  const [receipt, chain, verificationInitial] = await Promise.all([
    provider.getTransactionReceipt(TX_HASH), contract.getIjazahData(TOKEN_ID), verify(initial.nina, initial.name),
  ]);
  if (!receipt || receipt.status !== 1 || chain.isActive !== false) throw new Error("Bukti commit on-chain tidak memenuhi syarat recovery");
  if (initial.sia_diploma !== "verified" || initial.sivil_status !== "aktif") throw new Error(`State awal recovery tidak sesuai: sia=${initial.sia_diploma} sivil=${initial.sivil_status}`);
  if (verificationInitial.is_valid !== false) throw new Error("Safety denial gagal: SIVIL masih menyatakan valid saat token nonaktif");

  appendEvent("recovery_preflight", { receipt_status: receipt.status, block_number: receipt.blockNumber, gas_used: receipt.gasUsed.toString(), state: initial, verification: verificationInitial });
  const started = Date.now();

  // Rekonsiliasi eksplisit karena action asli berhenti setelah receipt RPC timeout:
  // on-chain tidak disentuh lagi; hanya state lokal dan dua layanan hilir diselaraskan.
  mysql(`START TRANSACTION;
UPDATE siakad_db.diplomas d JOIN siakad_db.students s ON s.id=d.student_id SET d.status_blockchain='revoked' WHERE s.nim='${NIM}' AND d.token_id='${TOKEN_ID}';
UPDATE siakad_db.pisn_reservations r JOIN siakad_db.students s ON s.id=r.student_id SET r.status='direvoke' WHERE s.nim='${NIM}';
INSERT INTO siakad_db.diploma_logs (nim,student_name,diploma_number,ipfs_hash,aksi,tx_hash,block_number,token_id,user_id,created_at)
SELECT s.nim,s.name,d.diploma_number,d.ipfs_hash,'revoked','${TX_HASH}','${receipt.blockNumber}','${TOKEN_ID}',(SELECT id FROM siakad_db.users WHERE role='master' ORDER BY id LIMIT 1),NOW()
FROM siakad_db.students s JOIN siakad_db.diplomas d ON d.student_id=s.id
WHERE s.nim='${NIM}' AND NOT EXISTS (SELECT 1 FROM siakad_db.diploma_logs l WHERE l.tx_hash='${TX_HASH}');
COMMIT;`);
  appendEvent("sia_reconciled");

  const pisn = await post(`${PISN}/api/pisn/revoke/${initial.nina}`);
  appendEvent("pisn_reconciled", pisn);
  const pddikti = await post(`${PISN}/api/pddikti/batal-lulus`, { nim: NIM });
  appendEvent("pddikti_reconciled", pddikti);

  const finalState = snapshot();
  const [chainFinal, verificationFinal] = await Promise.all([contract.getIjazahData(TOKEN_ID), verify(initial.nina, initial.name)]);
  const eventual = finalState.sia_diploma === "revoked" && finalState.sia_pisn === "direvoke" && finalState.pddikti_status === "aktif" && finalState.pisn_issued === "direvoke" && finalState.sivil_status === "direvoke" && chainFinal.isActive === false && verificationFinal.is_valid === false;
  const audit = {
    schema_version: 1,
    analysis_role: "auxiliary_recovery_after_rpc_receipt_timeout",
    include_in_core_normal_scr_denominator: false,
    status: eventual ? "pass" : "fail",
    recorded_at: new Date().toISOString(),
    contract_address: process.env.CONTRACT_ADDRESS_IJAZAH,
    nim: NIM, token_id: TOKEN_ID, tx_hash: TX_HASH,
    receipt: { status: receipt.status, block_number: receipt.blockNumber, gas_used: receipt.gasUsed.toString() },
    first_attempt: { application_reported_error: true, onchain_committed: true, local_cascade_complete: false, safety_denial: true, state: initial, verification: verificationInitial },
    recovery: { method: "explicit local reconciliation without a second blockchain transaction", latency_ms: Date.now() - started, state: finalState, blockchain_active: chainFinal.isActive, verification: verificationFinal, eventual_consistency: eventual },
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  appendEvent("recovery_completed", { status: audit.status, latency_ms: audit.recovery.latency_ms, eventual_consistency: eventual });
  console.log(JSON.stringify(audit, null, 2));
  if (!eventual) process.exitCode = 1;
}

main().catch((error) => {
  appendEvent("recovery_error", { error: error.message });
  console.error(error.stack || error.message);
  process.exit(1);
});
