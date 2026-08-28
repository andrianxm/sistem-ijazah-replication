#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FINAL = path.join(__dirname, "pengujian-final");
const EXP = path.join(__dirname, "experiment_logs");
const TARGET = process.env.ANALYSIS_BUNDLE_DIR || path.join(FINAL, "paket-analisis-final-20260809");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, rows, headers) {
  const allHeaders = headers || [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [allHeaders.map(csvCell).join(",")];
  for (const row of rows) lines.push(allHeaders.map((key) => csvCell(row[key])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

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
  if (field || row.length) { row.push(field); records.push(row); }
  const header = records.shift() || [];
  return records.filter((x) => x.some((v) => v !== "")).map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])),
  );
}

function parseTsv(text, headers) {
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) =>
    Object.fromEntries(headers.map((header, index) => [header, line.split("\t")[index] ?? ""])),
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return "";
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function main() {
  if (fs.existsSync(TARGET)) throw new Error(`Target sudah ada: ${TARGET}`);
  const temp = fs.mkdtempSync(path.join(FINAL, ".paket-analisis-tmp-"));
  const registered = [];

  function register(name, category, role, source = "generated") {
    registered.push({ name, category, role, source });
  }

  function copy(source, name, category, role) {
    if (!fs.existsSync(source)) throw new Error(`Sumber tidak ditemukan: ${source}`);
    fs.copyFileSync(source, path.join(temp, name));
    register(name, category, role, path.relative(ROOT, source));
  }

  function generated(name, content, category, role) {
    fs.writeFileSync(path.join(temp, name), content);
    register(name, category, role);
  }

  try {
    const manualAuditPath = path.join(EXP, "single-manual-20260809", "audit.json");
    const fullAuditPath = path.join(EXP, "fullflow-auto29-final-20260809", "audit.json");
    const fullPrimaryPath = path.join(EXP, "fullflow-auto29-r2-20260809", "results.csv");
    const fullRetryPath = path.join(EXP, "fullflow-auto29-retry-nim05-20260809", "results.csv");
    const batchAuditPath = path.join(FINAL, "batchmint-final-170-20260809", "audit.json");
    const batchResultsPath = path.join(FINAL, "batchmint-final-170-20260809", "results.csv");
    const ineligiblePath = path.join(FINAL, "ineligible-final-10-20260809", "results.csv");
    const duplicatePath = path.join(FINAL, "duplikat-nina-final-2-20260809", "results.csv");
    const tamperPath = path.join(FINAL, "modifikasi-artefak-final-6-20260809", "results.csv");
    const negativeAuditPath = path.join(FINAL, "audit-negatif-final-20260809.json");
    const historicalLogPath = path.join(__dirname, "experiment_logs.csv");

    const manual = readJson(manualAuditPath);
    const fullAudit = readJson(fullAuditPath);
    const batchAudit = readJson(batchAuditPath);
    const negativeAudit = readJson(negativeAuditPath);
    const primaryRows = parseCsv(fullPrimaryPath);
    const retryRows = parseCsv(fullRetryPath);
    const ineligibleRows = parseCsv(ineligiblePath);
    const batchRows = parseCsv(batchResultsPath);
    const duplicateRows = parseCsv(duplicatePath);
    const tamperRows = parseCsv(tamperPath);
    const historicalRows = parseCsv(historicalLogPath);
    const matrixRows = historicalRows.filter((row) => row.notes.includes("run=pasca-perbaikan-sivil"));
    const duplicateNimRows = historicalRows.filter((row) => row.scenario_id === "F-DUP-NIM-APP");
    const verificationLatencyRows = historicalRows.filter((row) => row.scenario_id === "V01");

    const rawFiles = [
      [manualAuditPath, "raw_manual_single_audit.json", "functional", "included_manual"],
      [fullAuditPath, "raw_fullflow_final_audit.json", "functional", "included_audit"],
      [fullPrimaryPath, "raw_fullflow_primary_results.csv", "functional", "included_first_pass"],
      [fullRetryPath, "raw_fullflow_retry_results.csv", "functional", "included_recovery"],
      [path.join(EXP, "fullflow-auto29-startup-failure-20260809.json"), "raw_fullflow_startup_failure.json", "functional", "excluded_startup"],
      [path.join(EXP, "fullflow-auto29-r1-20260809", "results.csv"), "raw_fullflow_development_r1.csv", "functional", "excluded_development"],
      [batchAuditPath, "raw_batch_audit.json", "batch", "included_audit"],
      [batchResultsPath, "raw_batch_results.csv", "batch", "included_results"],
      [path.join(FINAL, "batchmint-final-170-20260809", "events.ndjson"), "raw_batch_events.ndjson", "batch", "included_journal"],
      [path.join(FINAL, "batchmint-final-170-20260809", "checkpoint.json"), "raw_batch_checkpoint.json", "batch", "included_recovery_state"],
      [path.join(FINAL, "batchmint-final-170-20260809", "run.json"), "raw_batch_run.json", "batch", "included_metadata"],
      [ineligiblePath, "raw_ineligible_results.csv", "negative", "included_results"],
      [negativeAuditPath, "raw_negative_audit.json", "negative", "included_audit"],
      [duplicatePath, "raw_duplicate_nina_results.csv", "negative", "included_results"],
      [path.join(FINAL, "duplikat-nina-final-2-20260809", "events.ndjson"), "raw_duplicate_nina_events.ndjson", "negative", "included_journal"],
      [path.join(FINAL, "duplikat-nina-final-2-20260809", "checkpoint.json"), "raw_duplicate_nina_checkpoint.json", "negative", "included_recovery_state"],
      [tamperPath, "raw_tamper_results.csv", "cryptography_ipfs", "included_results"],
      [path.join(FINAL, "modifikasi-artefak-final-6-20260809", "audit.json"), "raw_tamper_audit.json", "cryptography_ipfs", "included_audit"],
      [path.join(FINAL, "modifikasi-artefak-final-6-20260809", "events.ndjson"), "raw_tamper_events.ndjson", "cryptography_ipfs", "included_journal"],
      [path.join(FINAL, "modifikasi-artefak-final-6-20260809", "checkpoint.json"), "raw_tamper_checkpoint.json", "cryptography_ipfs", "included_recovery_state"],
      [path.join(FINAL, "checksums.sha256"), "raw_source_checksums.sha256", "integrity", "source_checksums"],
      [historicalLogPath, "raw_experiment_logs_historis.csv", "historical", "pre_reset_raw_log"],
    ];
    for (const item of rawFiles) copy(...item);

    for (const name of [
      "01-F06-tidak-eligible-ui.png",
      "02-DUP-NINA-ringkasan.png",
      "03-TAMPER-ringkasan.png",
      "04-REKAP-negatif-final.png",
    ]) copy(path.join(FINAL, "lampiran", name), `visual_${name}`, "visual", "included_evidence");

    for (const [source, name] of [
      [path.join(__dirname, "uji-duplikat-nina.cjs"), "script_uji_duplikat_nina.cjs"],
      [path.join(__dirname, "uji-modifikasi-artefak.cjs"), "script_uji_modifikasi_artefak.cjs"],
      [path.join(__dirname, "uji-batch-mint.cjs"), "script_uji_batch_mint.cjs"],
      [path.join(__dirname, "uji-e2e.cjs"), "script_uji_e2e.cjs"],
      [path.join(__dirname, "ambil-lampiran-final.cjs"), "script_ambil_lampiran.cjs"],
    ]) copy(source, name, "reproducibility", "runner_copy");

    const functionalRows = [
      ...primaryRows.map((row) => ({ source_run: "fullflow_primary_r2", analysis_role: "first_pass", ...row })),
      ...retryRows.map((row) => ({ source_run: "fullflow_retry_nim05", analysis_role: "recovery", ...row })),
    ];
    writeCsv(path.join(temp, "analisis_alur_fungsional.csv"), functionalRows);
    register("analisis_alur_fungsional.csv", "analysis", "import_ready");

    writeCsv(path.join(temp, "analisis_matriks_verifikasi_pasca_perbaikan.csv"), matrixRows.map((row) => ({ historical_scope: "pre_reset", ...row })));
    register("analisis_matriks_verifikasi_pasca_perbaikan.csv", "historical_analysis", "pre_reset_import_ready");
    writeCsv(path.join(temp, "analisis_duplikat_nim_aplikasi.csv"), duplicateNimRows.map((row) => ({ historical_scope: "pre_reset", ...row })));
    register("analisis_duplikat_nim_aplikasi.csv", "historical_analysis", "pre_reset_import_ready");
    writeCsv(path.join(temp, "analisis_latensi_verifikasi_historis.csv"), verificationLatencyRows.map((row) => ({ historical_scope: "pre_reset", ...row })));
    register("analisis_latensi_verifikasi_historis.csv", "historical_analysis", "pre_reset_import_ready_unaggregated");

    const batchMetrics = Object.entries(batchAudit.metrics_by_batch_size).map(([size, metric]) => ({
      batch_size: size,
      repetitions: metric.repetitions,
      credentials: metric.credentials,
      gas_used_values: metric.gas_used.join(";"),
      gas_used_mean: metric.gas_used_mean,
      gas_per_credential_values: metric.gas_per_credential.join(";"),
      gas_per_credential_mean: metric.gas_per_credential_mean,
      total_latency_ms_values: metric.total_latency_ms.join(";"),
      total_latency_median_ms: metric.total_latency_median_ms,
      confirmation_latency_ms_values: metric.confirmation_latency_ms.join(";"),
      confirmation_latency_median_ms: metric.confirmation_latency_median_ms,
    }));
    writeCsv(path.join(temp, "analisis_batch_per_ukuran.csv"), batchMetrics);
    register("analisis_batch_per_ukuran.csv", "analysis", "import_ready");

    const f06Rows = ineligibleRows.filter((row) => row.scenario_id === "F06");
    const runSummary = [
      { domain: "functional", experiment: "manual_single", unit: "credential", total: 1, passed: 1, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "functional", experiment: "automated_first_pass", unit: "credential", total: 29, passed: 28, failed: 1, scr_percent: fullAudit.outcome.automated_first_pass_scr_percent, analysis_role: "final_first_pass" },
      { domain: "functional", experiment: "automated_eventual", unit: "credential", total: 29, passed: 29, failed: 0, scr_percent: 100, analysis_role: "final_with_recovery" },
      { domain: "functional", experiment: "overall_eventual", unit: "credential", total: 30, passed: 30, failed: 0, scr_percent: fullAudit.outcome.eventual_credential_scr_percent, analysis_role: "final_with_recovery" },
      { domain: "functional", experiment: "automated_steps_primary_plus_retry", unit: "step_attempt", total: 207, passed: 206, failed: 1, scr_percent: fullAudit.outcome.automated_step_scr_percent, analysis_role: "final_with_recovery" },
      { domain: "smart_contract", experiment: "batch_mint", unit: "batch", total: 10, passed: 10, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "smart_contract", experiment: "batch_mint", unit: "credential", total: 170, passed: 170, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "functional", experiment: "ineligible_f06", unit: "credential", total: 10, passed: f06Rows.filter((row) => row.status === "pass").length, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "smart_contract", experiment: "duplicate_nina", unit: "transaction", total: 2, passed: duplicateRows.filter((row) => row.status === "pass").length, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "cryptography_ipfs", experiment: "artifact_modification", unit: "artifact", total: 6, passed: tamperRows.filter((row) => row.status === "pass").length, failed: 0, scr_percent: 100, analysis_role: "final" },
      { domain: "verification", experiment: "two_layer_matrix_post_fix", unit: "case", total: matrixRows.length, passed: matrixRows.filter((row) => row.status === "pass").length, failed: matrixRows.filter((row) => row.status !== "pass").length, scr_percent: matrixRows.length ? (matrixRows.filter((row) => row.status === "pass").length / matrixRows.length) * 100 : "", analysis_role: "historical_pre_reset" },
      { domain: "functional", experiment: "duplicate_nim_application", unit: "case", total: duplicateNimRows.length, passed: duplicateNimRows.filter((row) => row.status === "pass").length, failed: duplicateNimRows.filter((row) => row.status !== "pass").length, scr_percent: duplicateNimRows.length ? (duplicateNimRows.filter((row) => row.status === "pass").length / duplicateNimRows.length) * 100 : "", analysis_role: "historical_pre_reset" },
    ];
    writeCsv(path.join(temp, "analisis_ringkasan_run.csv"), runSummary);
    register("analisis_ringkasan_run.csv", "analysis", "import_ready_primary_summary");

    const transactionMap = new Map();
    function addTransaction(row) {
      if (!row.tx_hash || transactionMap.has(row.tx_hash)) return;
      transactionMap.set(row.tx_hash, row);
    }
    addTransaction({ category: "manual_single", experiment_id: "manual_20210001", nim: manual.credential.nim, nina: manual.credential.nina, tx_hash: manual.blockchain.tx_hash, receipt_status: manual.blockchain.receipt_status, gas_used: manual.blockchain.gas_used, block_number: manual.blockchain.block_number, token_start: manual.blockchain.token_id, token_end: manual.blockchain.token_id, credential_count: 1, status: "confirmed" });
    for (const row of functionalRows) addTransaction({ category: "functional_automated", experiment_id: `${row.source_run}_${row.nim}`, nim: row.nim, nina: row.nina, tx_hash: row.tx_hash, receipt_status: row.status === "pass" ? 1 : "", gas_used: row.gas_used, block_number: row.block_number, token_start: row.token_id, token_end: row.token_id, credential_count: 1, status: row.status === "pass" ? "confirmed" : "failed" });
    for (const row of batchRows) addTransaction({ category: "batch_mint", experiment_id: row.batch_id, nim: "", nina: "", tx_hash: row.tx_hash, receipt_status: row.status === "pass" ? 1 : "", gas_used: row.gas_used, block_number: row.block_number, token_start: row.start_token_id, token_end: row.end_token_id, credential_count: row.credential_count, status: row.status === "pass" ? "confirmed" : row.status });
    for (const row of duplicateRows) addTransaction({ category: "duplicate_nina", experiment_id: row.case_id, nim: row.nim, nina: row.duplicate_nina, tx_hash: row.tx_hash, receipt_status: row.receipt_status, gas_used: row.gas_used, block_number: row.block_number, token_start: "", token_end: "", credential_count: 0, status: "reverted_expected" });
    writeCsv(path.join(temp, "analisis_transaksi.csv"), [...transactionMap.values()], ["category", "experiment_id", "nim", "nina", "tx_hash", "receipt_status", "gas_used", "block_number", "token_start", "token_end", "credential_count", "status"]);
    register("analisis_transaksi.csv", "analysis", "import_ready_transactions");

    const latencyValues = functionalRows.map((row) => Number(row.latency_ms)).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const metrics = [
      ["final_state", "students", negativeAudit.final_state.students, "record"],
      ["final_state", "diplomas", negativeAudit.final_state.diplomas, "record"],
      ["final_state", "legitimate_distinct_cids", negativeAudit.final_state.legitimate_cids_distinct, "cid"],
      ["final_state", "pinata_pinned_objects", negativeAudit.final_state.pinata_pinned_objects, "object"],
      ["final_state", "next_token_id", negativeAudit.final_state.next_token_id, "token_id"],
      ["functional", "eventual_credential_scr", fullAudit.outcome.eventual_credential_scr_percent, "percent"],
      ["functional", "automated_first_pass_scr", fullAudit.outcome.automated_first_pass_scr_percent, "percent"],
      ["functional", "automated_step_scr", fullAudit.outcome.automated_step_scr_percent, "percent"],
      ["functional", "positive_latency_p50", percentile(latencyValues, 50), "ms"],
      ["functional", "positive_latency_p95", percentile(latencyValues, 95), "ms"],
      ["batch", "total_gas_used", batchAudit.campaign_result.total_gas_used, "gas"],
      ["batch", "weighted_gas_per_credential", batchAudit.campaign_result.weighted_gas_per_credential, "gas_per_credential"],
      ["tamper", "pins_added", negativeAudit.cases.artifact_modification.pins_added, "object"],
      ["tamper", "cases_detected", negativeAudit.cases.artifact_modification.passed, "artifact"],
    ].map(([domain, metric, value, unit]) => ({ domain, metric, value, unit }));
    writeCsv(path.join(temp, "analisis_metrik_utama.csv"), metrics);
    register("analisis_metrik_utama.csv", "analysis", "import_ready_metrics");

    const mysqlPassword = process.env.MYSQL_PASSWORD || "password";
    const credentialHeaders = ["nim", "name", "major", "student_pddikti_status", "student_status_mesin", "student_blockchain_status", "diploma_number", "nina", "token_id", "tx_hash", "pdf_cid", "metadata_cid", "diploma_blockchain_status", "pddikti_record_status", "pddikti_eligibility", "pisn_nina_status", "sivil_status"];
    const query = `SELECT s.nim,s.name,s.major,s.pddikti_status,s.status_mesin,s.status_blockchain,COALESCE(d.diploma_number,''),COALESCE(d.nina,''),COALESCE(d.token_id,''),COALESCE(d.tx_hash,''),COALESCE(d.ipfs_hash,''),COALESCE(d.ipfs_json_hash,''),COALESCE(d.status_blockchain,''),COALESCE(p.status,''),COALESCE(p.status_eligibilitas,''),COALESCE(i.status,''),COALESCE(v.status,'') FROM siakad_db.students s LEFT JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN kementerian_db.pddikti_mahasiswa p ON p.nim=s.nim LEFT JOIN kementerian_db.pisn_nina_issued i ON i.nim=s.nim LEFT JOIN sivil_db.sivil_nina_registry v ON v.nim=s.nim ORDER BY s.nim`;
    const tsv = execFileSync("docker", ["exec", "ijazah-mysql", "mysql", "-u", "root", `-p${mysqlPassword}`, "-B", "-N", "-e", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const credentialRows = parseTsv(tsv, credentialHeaders);
    if (credentialRows.length !== 212) throw new Error(`Snapshot kredensial berisi ${credentialRows.length} baris, bukan 212`);
    writeCsv(path.join(temp, "analisis_snapshot_212_mahasiswa.csv"), credentialRows, credentialHeaders);
    register("analisis_snapshot_212_mahasiswa.csv", "analysis", "import_ready_cross_system_snapshot");

    generated("catatan_semantik_status.json", `${JSON.stringify({
      recorded_at: new Date().toISOString(),
      supersedes_interpretation_only_in: ["raw_fullflow_final_audit.json", "raw_batch_audit.json"],
      raw_measurements_modified: false,
      rule_siap_terbit: "statusMesin=SIAP_DITERBITKAN, pddiktiStatus=eligible, dan tidak memiliki diploma verified",
      rule_lulus_terbit_ijazah: "memiliki setidaknya satu diploma dengan statusBlockchain=verified",
      interpretation: "Mahasiswa yang telah dicetak sah berada pada filter Lulus Terbit Ijazah walaupun statusMesin tetap SIAP_DITERBITKAN. Kondisi ini bukan kegagalan penerbitan.",
    }, null, 2)}\n`, "documentation", "required_interpretation_note");

    const dictionary = `# Kamus Data Ringkas

## CSV analisis

- \`analisis_ringkasan_run.csv\`: SCR dan hasil per unit eksperimen.
- \`analisis_alur_fungsional.csv\`: seluruh 207 attempt langkah otomatis; kolom
  \`analysis_role\` membedakan first pass dan recovery.
- \`analisis_batch_per_ukuran.csv\`: agregasi gas dan latensi ukuran 5, 10, 25,
  dan 50.
- \`analisis_transaksi.csv\`: transaksi unik yang dikonfirmasi atau direvert.
- \`analisis_metrik_utama.csv\`: metrik utama dalam format panjang
  \`domain,metric,value,unit\`.
- \`analisis_snapshot_212_mahasiswa.csv\`: snapshot akhir lintas SIAKAD,
  PDDikti/PISN, dan SIVIL.
- \`analisis_matriks_verifikasi_pasca_perbaikan.csv\`: 13 keputusan matriks
  verifikasi yang direkam setelah perbaikan SIVIL, sebelum reset final.
- \`analisis_duplikat_nim_aplikasi.csv\`: tiga uji penolakan NIM duplikat pada UI.
- \`analisis_latensi_verifikasi_historis.csv\`: 60 pengamatan V01 mentah sebelum
  reset; sengaja tidak diagregasi karena berasal dari eksekusi yang bertumpang
  tindih di log lama.

## Definisi penting

- \`first_pass\`: hasil eksekusi otomatis utama sebelum pemulihan NIM 20210005.
- \`recovery\`: retry idempoten setelah kegagalan Puppeteer sebelum IPFS/mint.
- \`SCR\`: jumlah unit pass dibagi total unit yang dideklarasikan.
- \`receipt_status=0\`: transaksi masuk blok tetapi direvert; pada duplikat NINA
  kondisi ini adalah hasil yang diharapkan.
- \`SIAP_DITERBITKAN\`: status workflow mahasiswa. Status penerbitan final pada UI
  ditentukan oleh relasi diploma \`statusBlockchain=verified\`.
`;
    generated("KAMUS_DATA.md", dictionary, "documentation", "data_dictionary");

    const readme = `# Paket Analisis Pengujian Final

Paket ini adalah salinan mandiri bukti final tanggal 8–9 Agustus 2026. Log sumber
tidak disunting. Semua CSV memakai UTF-8, pemisah koma, header pada baris pertama,
dan baris baru LF.

## Mulai analisis

1. Impor \`analisis_ringkasan_run.csv\` untuk hasil umum dan SCR.
2. Impor \`analisis_alur_fungsional.csv\` untuk analisis langkah dan latensi.
3. Impor \`analisis_batch_per_ukuran.csv\` dan \`raw_batch_results.csv\` untuk
   gas serta latensi batch.
4. Impor \`analisis_snapshot_212_mahasiswa.csv\` untuk konsistensi lintas sistem.
5. Gunakan berkas berawalan \`raw_\` jika membutuhkan bukti eksekusi asli.

## Cakupan final

- Alur penuh: 1 manual + 29 otomatis; 30/30 selesai setelah satu retry.
- Batch mint: 5x3, 10x3, 25x3, dan 50x1; 170/170 kredensial.
- Tidak eligible F06: 10/10 ditolak dengan HTTP 422 tanpa state kredensial.
- Duplikat NINA: 2/2 direvert dengan receipt 0.
- Modifikasi artefak: 6/6 terdeteksi dan menghasilkan enam pin varian.
- State akhir: 212 mahasiswa, 200 diploma/token/NINA/SIVIL, 406 objek Pinata,
  dan nextTokenId #1201.

## Bukti historis sebelum reset

Matriks SIVIL pasca-perbaikan, uji NIM duplikat di aplikasi, dan V01 tersimpan
sebagai CSV \`analisis_*_historis\` atau diberi peran \`historical_pre_reset\`.
Data tersebut tetap disertakan untuk kelengkapan, tetapi tidak boleh digabung
langsung dengan metrik kampanye kontrak/dataset final tanpa stratifikasi.

## Pengecualian

\`raw_fullflow_development_r1.csv\` dan \`raw_fullflow_startup_failure.json\`
dipertahankan untuk transparansi, tetapi tidak masuk SCR eksperimen final. Run
retry NIM 20210005 masuk analisis eventual, bukan first-pass SCR.

## Integritas

Periksa seluruh berkas dengan \`sha256sum -c checksums.sha256\` dari folder ini.
Lihat \`manifest.csv\` untuk provenance dan peran setiap berkas.
`;
    generated("README.md", readme, "documentation", "entrypoint");

    const bundleInfo = {
      schema_version: 1,
      bundle_id: path.basename(TARGET),
      created_at: new Date().toISOString(),
      source_root: path.relative(ROOT, FINAL),
      flat_directory: true,
      csv_encoding: "UTF-8",
      csv_delimiter: ",",
      raw_logs_modified: false,
      expected_counts: { students: 212, credentials: 200, pinata_objects: 406, next_token_id: 1201 },
      historical_counts: { matrix_post_fix: matrixRows.length, duplicate_nim_application: duplicateNimRows.length, verification_v01_raw: verificationLatencyRows.length },
    };
    generated("bundle_info.json", `${JSON.stringify(bundleInfo, null, 2)}\n`, "documentation", "machine_readable_metadata");

    const manifestRows = registered.sort((a, b) => a.name.localeCompare(b.name)).map((item) => {
      const file = path.join(temp, item.name);
      return { filename: item.name, category: item.category, analysis_role: item.role, source_path: item.source, bytes: fs.statSync(file).size, sha256: sha256(file) };
    });
    writeCsv(path.join(temp, "manifest.csv"), manifestRows, ["filename", "category", "analysis_role", "source_path", "bytes", "sha256"]);

    const checksumFiles = fs.readdirSync(temp).filter((name) => name !== "checksums.sha256").sort();
    const checksumText = checksumFiles.map((name) => `${sha256(path.join(temp, name))}  ${name}`).join("\n");
    fs.writeFileSync(path.join(temp, "checksums.sha256"), `${checksumText}\n`);

    fs.renameSync(temp, TARGET);
    console.log(JSON.stringify({
      target: TARGET,
      files: fs.readdirSync(TARGET).length,
      primary_rows: primaryRows.length,
      retry_rows: retryRows.length,
      functional_attempts: functionalRows.length,
      batch_rows: batchRows.length,
      ineligible_rows: ineligibleRows.length,
      duplicate_rows: duplicateRows.length,
      tamper_rows: tamperRows.length,
      credential_snapshot_rows: credentialRows.length,
      transactions: transactionMap.size,
      historical_log_rows: historicalRows.length,
      matrix_post_fix_rows: matrixRows.length,
      duplicate_nim_application_rows: duplicateNimRows.length,
      verification_v01_rows: verificationLatencyRows.length,
    }, null, 2));
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

try { main(); }
catch (error) { console.error(error.stack || error.message); process.exit(1); }
