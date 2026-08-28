#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "pengujian-final", "domain4-final-20260809");
const MATRIX_LOG = path.join(ROOT, "results.csv");
const CASCADE_LOG = path.join(ROOT, "cascade-revoke", "results.csv");
const CASCADE_AUDIT = path.join(ROOT, "cascade-revoke", "audit.json");
const RPC_RECOVERY = path.join(ROOT, "cascade-revoke", "rpc-receipt-timeout-recovery.json");
const DUP_LOG = path.join(__dirname, "pengujian-final", "duplikat-nim-ui-final-3-20260809", "results.csv");

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8");
  const records = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); records.push(row); row = []; field = ""; }
    else field += char;
  }
  const headers = records.shift() || [];
  return { headers, rows: records.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))) };
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, headers, rows) {
  fs.writeFileSync(file, `${[headers.join(","), ...rows.map((row) => headers.map((header) => csv(row[header])).join(","))].join("\n")}\n`);
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function stats(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const rounded = (value) => Math.round(value * 1000) / 1000;
  return { n: clean.length, min: clean[0], q1: rounded(quantile(clean, 0.25)), median: rounded(quantile(clean, 0.5)), q3: rounded(quantile(clean, 0.75)), p95: rounded(quantile(clean, 0.95)), max: clean[clean.length - 1] };
}

function main() {
  const all = parseCsv(MATRIX_LOG);
  const latency = all.rows.filter((row) => row.scenario_id === "V01" && row.notes.includes("run=latensi-final"));
  const matrix = all.rows.filter((row) => /^V-B[1-5]$/.test(row.scenario_id) && row.notes.includes("run=matriks-final"));
  const setup = all.rows.filter((row) => row.scenario_id.startsWith("V-SETUP-") && row.notes.includes("run=matriks-final"));
  if (latency.length !== 30 || matrix.length !== 13 || setup.length !== 10) throw new Error(`Jumlah Domain 4 tidak sah: latency=${latency.length}, matrix=${matrix.length}, setup=${setup.length}`);
  if (![...latency, ...matrix, ...setup].every((row) => row.status === "pass")) throw new Error("Terdapat baris Domain 4 final yang tidak pass");

  writeCsv(path.join(ROOT, "latensi-verifikasi-final-30.csv"), all.headers, latency);
  writeCsv(path.join(ROOT, "matriks-keputusan-final-13.csv"), all.headers, matrix);
  writeCsv(path.join(ROOT, "setup-matriks-final-10.csv"), all.headers, setup);

  const cascade = parseCsv(CASCADE_LOG);
  const cascadeAudit = JSON.parse(fs.readFileSync(CASCADE_AUDIT, "utf8"));
  const recovery = JSON.parse(fs.readFileSync(RPC_RECOVERY, "utf8"));
  const duplicate = parseCsv(DUP_LOG);
  if (cascade.rows.length !== 10 || !cascade.rows.every((row) => row.status === "pass")) throw new Error("Cascading revoke inti bukan 10/10 pass");
  if (duplicate.rows.length !== 3 || !duplicate.rows.every((row) => row.status === "pass")) throw new Error("Duplikat NIM UI bukan 3/3 pass");
  if (recovery.status !== "pass" || recovery.include_in_core_normal_scr_denominator !== false) throw new Error("Audit recovery receipt RPC tidak sah");

  const normal = cascade.rows.filter((row) => row.mode === "normal");
  const syncFailure = cascade.rows.filter((row) => row.mode === "sync_failure");
  const latencyStats = stats(latency.map((row) => row.latency_ms));
  const normalAction = stats(normal.map((row) => row.action_latency_ms));
  const syncAction = stats(syncFailure.map((row) => row.action_latency_ms));
  const recoveryLatency = stats(syncFailure.map((row) => row.recovery_latency_ms));
  const propagation = stats(cascade.rows.map((row) => row.first_propagation_ms));
  const matrixGroups = Object.fromEntries(["V-B1", "V-B2", "V-B3", "V-B4", "V-B5"].map((id) => [id, matrix.filter((row) => row.scenario_id === id).length]));
  const normalFirst = normal.filter((row) => row.first_attempt_cascade === "true").length;

  const metrics = [];
  const add = (domain, metric, value, unit, denominator = "", method = "") => metrics.push({ domain, metric, value, unit, denominator, method });
  add("verification", "matrix_cases_passed", matrix.filter((row) => row.status === "pass").length, "case", matrix.length, "expected versus actual");
  add("verification", "matrix_conformance", matrix.filter((row) => row.status === "pass").length / matrix.length * 100, "percent", matrix.length, "13 current-final cases");
  for (const [key, value] of Object.entries(latencyStats)) add("verification", `latency_${key}`, value, key === "n" ? "observation" : "ms", latencyStats.n, "quantile type 7");
  add("revoke", "normal_first_attempt_scr", normalFirst / normal.length * 100, "percent", normal.length, "strict consistency all layers");
  add("revoke", "all_first_attempt_scr_with_injected_outage", cascadeAudit.scr_revoke_first_attempt_percent, "percent", cascade.rows.length, "five normal plus five SIVIL outage");
  add("revoke", "safety_denial", cascadeAudit.safety_denial_percent, "percent", cascade.rows.length, "verification invalid after on-chain revoke");
  add("revoke", "eventual_scr_revoke", cascadeAudit.scr_revoke_eventual_percent, "percent", cascade.rows.length, "after explicit retry for injected outage");
  for (const [prefix, groupStats] of [["normal_action", normalAction], ["sync_failure_action", syncAction], ["sync_recovery", recoveryLatency], ["first_propagation", propagation]]) {
    for (const key of ["median", "p95", "min", "max"]) add("revoke", `${prefix}_${key}`, groupStats[key], "ms", groupStats.n, "quantile type 7");
  }
  add("revoke", "rpc_receipt_timeout_auxiliary_cases", 1, "case", 1, "excluded from core n=10");
  add("revoke", "rpc_receipt_timeout_safety_denial", recovery.first_attempt.safety_denial ? 100 : 0, "percent", 1, "on-chain committed while local state stale");
  add("revoke", "rpc_receipt_timeout_recovery_latency", recovery.recovery.latency_ms, "ms", 1, "explicit reconciliation; no second chain tx");
  add("application", "duplicate_nim_rejected", duplicate.rows.filter((row) => row.status === "pass").length, "case", duplicate.rows.length, "actual browser form");
  add("application", "duplicate_nim_rows_added", duplicate.rows.reduce((sum, row) => sum + Number(row.students_after) - Number(row.students_before), 0), "row", duplicate.rows.length, "database count before and after");
  writeCsv(path.join(ROOT, "metrik-domain4-final.csv"), ["domain", "metric", "value", "unit", "denominator", "method"], metrics);

  writeCsv(path.join(ROOT, "recovery-timeout-rpc-final-1.csv"), ["analysis_role", "include_in_core_normal_scr_denominator", "status", "nim", "token_id", "tx_hash", "receipt_status", "block_number", "gas_used", "application_reported_error", "onchain_committed", "local_cascade_complete_first_attempt", "safety_denial", "recovery_latency_ms", "eventual_consistency", "recovery_method"], [{
    analysis_role: recovery.analysis_role,
    include_in_core_normal_scr_denominator: recovery.include_in_core_normal_scr_denominator,
    status: recovery.status, nim: recovery.nim, token_id: recovery.token_id, tx_hash: recovery.tx_hash,
    receipt_status: recovery.receipt.status, block_number: recovery.receipt.block_number, gas_used: recovery.receipt.gas_used,
    application_reported_error: recovery.first_attempt.application_reported_error,
    onchain_committed: recovery.first_attempt.onchain_committed,
    local_cascade_complete_first_attempt: recovery.first_attempt.local_cascade_complete,
    safety_denial: recovery.first_attempt.safety_denial,
    recovery_latency_ms: recovery.recovery.latency_ms,
    eventual_consistency: recovery.recovery.eventual_consistency,
    recovery_method: recovery.recovery.method,
  }]);

  const revokeTransactions = [
    ...setup.filter((row) => row.scenario_id === "V-SETUP-B2").map((row) => ({ category: "matrix_direct_revoke", case_id: row.scenario_id, analysis_role: "core_matrix_setup", nim: row.nim, nina: row.nina, token_id: row.token_id, tx_hash: row.tx_hash, receipt_status: 1, gas_used: row.gas_used, block_number: row.block_number, status: row.status })),
    ...cascade.rows.map((row) => ({ category: "cascading_revoke", case_id: row.case_id, analysis_role: "core_revoke", nim: row.nim, nina: row.nina, token_id: row.token_id, tx_hash: row.tx_hash, receipt_status: row.receipt_status, gas_used: row.gas_used, block_number: row.block_number, status: row.status })),
    { category: "rpc_receipt_timeout_recovery", case_id: "REV-RPC-RECOVERY-1", analysis_role: recovery.analysis_role, nim: recovery.nim, nina: recovery.first_attempt.state.nina, token_id: recovery.token_id, tx_hash: recovery.tx_hash, receipt_status: recovery.receipt.status, gas_used: recovery.receipt.gas_used, block_number: recovery.receipt.block_number, status: recovery.status },
  ];
  if (new Set(revokeTransactions.map((row) => row.tx_hash)).size !== 14) throw new Error("Transaksi revoke unik bukan 14");
  writeCsv(path.join(ROOT, "transaksi-revoke-final-14.csv"), ["category", "case_id", "analysis_role", "nim", "nina", "token_id", "tx_hash", "receipt_status", "gas_used", "block_number", "status"], revokeTransactions);

  const headers = ["nim", "name", "major", "student_pddikti_status", "student_status_mesin", "student_blockchain_status", "diploma_number", "nina", "token_id", "tx_hash", "pdf_cid", "metadata_cid", "diploma_blockchain_status", "pddikti_record_status", "pddikti_eligibility", "pisn_nina_status", "sivil_status"];
  const query = "SELECT s.nim,s.name,s.major,s.pddikti_status,s.status_mesin,s.status_blockchain,COALESCE(d.diploma_number,''),COALESCE(d.nina,''),COALESCE(d.token_id,''),COALESCE(d.tx_hash,''),COALESCE(d.ipfs_hash,''),COALESCE(d.ipfs_json_hash,''),COALESCE(d.status_blockchain,''),COALESCE(p.status,''),COALESCE(p.status_eligibilitas,''),COALESCE(i.status,''),COALESCE(v.status,'') FROM siakad_db.students s LEFT JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN kementerian_db.pddikti_mahasiswa p ON p.nim=s.nim LEFT JOIN kementerian_db.pisn_nina_issued i ON i.nim=s.nim LEFT JOIN sivil_db.sivil_nina_registry v ON v.nim=s.nim ORDER BY s.nim";
  const tsv = execFileSync("docker", ["exec", process.env.MYSQL_CONTAINER || "ijazah-mysql", "mysql", "-u", "root", `-p${process.env.MYSQL_PASSWORD || "password"}`, "-B", "-N", "-e", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const snapshot = tsv.trimEnd().split(/\r?\n/).map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split("\t")[index] || ""])));
  if (snapshot.length !== 212) throw new Error(`Snapshot pasca Domain 4 bukan 212 baris: ${snapshot.length}`);
  writeCsv(path.join(ROOT, "snapshot-pasca-domain4-final-212.csv"), headers, snapshot);

  const audit = {
    schema_version: 1, recorded_at: new Date().toISOString(), scope: "current_final_only",
    contract_address: cascadeAudit.contract_address, chain_id: cascadeAudit.chain_id,
    gateway: "plum-eldest-tortoise-172.mypinata.cloud", dataset_students: 212,
    runs: ["latensi-final", "matriks-final", "cascading-revoke-final-20260809", "duplikat-nim-ui-final-20260809"],
    verification_latency: latencyStats,
    matrix: { groups: matrixGroups, passed: matrix.filter((row) => row.status === "pass").length, total: matrix.length, conformance_percent: 100 },
    revoke: { core_cases: 10, normal_cases: 5, injected_sync_failure_cases: 5, normal_first_attempt_scr_percent: normalFirst / normal.length * 100, overall_first_attempt_strict_percent: cascadeAudit.scr_revoke_first_attempt_percent, safety_denial_percent: cascadeAudit.safety_denial_percent, eventual_scr_revoke_percent: cascadeAudit.scr_revoke_eventual_percent, pin_added: 0 },
    auxiliary_rpc_receipt_timeout: { cases: 1, included_in_core_denominator: false, status: recovery.status, safety_denial: recovery.first_attempt.safety_denial, eventual_consistency: recovery.recovery.eventual_consistency },
    duplicate_nim_ui: { passed: duplicate.rows.filter((row) => row.status === "pass").length, total: duplicate.rows.length, rows_added: 0 },
    historical_data_present: false,
  };
  fs.writeFileSync(path.join(ROOT, "AUDIT_DOMAIN4_FINAL.json"), `${JSON.stringify(audit, null, 2)}\n`);
  console.log(JSON.stringify(audit, null, 2));
}

try { main(); }
catch (error) { console.error(error.stack || error.message); process.exit(1); }
