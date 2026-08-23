#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SOURCE = path.join(__dirname, "pengujian-final", "paket-analisis-final-20260809");
const DOMAIN4 = path.join(__dirname, "pengujian-final", "domain4-final-20260809");
const DUPLICATE_NIM = path.join(__dirname, "pengujian-final", "duplikat-nim-ui-final-3-20260809");
const TARGET = process.env.CORE_ANALYSIS_DIR || path.join(__dirname, "pengujian-final", "analisis-inti-final");

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8"), records = [];
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
  return {
    headers,
    rows: records.filter((values) => values.some((value) => value !== "")).map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
    ),
  };
}

function writeCsv(file, headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  if (fs.existsSync(TARGET)) throw new Error(`Folder tujuan sudah ada: ${TARGET}`);
  fs.mkdirSync(TARGET, { recursive: true });

  const files = [
    ["analisis_metrik_utama.csv", "02_metrik_utama.csv", "final", "metrik utama format panjang"],
    ["analisis_alur_fungsional.csv", "03_alur_fungsional_207_attempt.csv", "final", "207 attempt langkah first pass dan recovery"],
    ["raw_batch_results.csv", "04_batch_detail_10_run.csv", "final", "10 transaksi batch ukuran 5, 10, 25, dan 50"],
    ["analisis_batch_per_ukuran.csv", "05_batch_agregat_per_ukuran.csv", "final", "agregat gas dan latensi per ukuran batch"],
    ["raw_duplicate_nina_results.csv", "07_duplikat_nina_2_kasus.csv", "final", "dua transaksi duplikat NINA yang direvert"],
    ["raw_tamper_results.csv", "08_modifikasi_artefak_6_kasus.csv", "final", "enam modifikasi PDF dan metadata"],
    ["analisis_transaksi.csv", "09_transaksi_42_unik.csv", "final", "transaksi unik alur tunggal, otomatis, batch, dan duplikat"],
    ["analisis_snapshot_212_mahasiswa.csv", "10_snapshot_212_mahasiswa.csv", "final", "snapshot lintas SIAKAD, PDDikti/PISN, dan SIVIL"],
    [path.join(DOMAIN4, "latensi-verifikasi-final-30.csv"), "11_latensi_verifikasi_final_30.csv", "final", "30 verifikasi live sebelum mutasi matriks"],
    [path.join(DOMAIN4, "matriks-keputusan-final-13.csv"), "12_matriks_keputusan_final_13.csv", "final", "13 keputusan B1-B5 pada detektor final"],
    [path.join(DOMAIN4, "setup-matriks-final-10.csv"), "13_setup_matriks_final_10.csv", "final", "10 pembentukan state B2-B5 tanpa pin baru"],
    [path.join(DOMAIN4, "cascade-revoke", "results.csv"), "14_cascading_revoke_final_10.csv", "final", "5 revoke normal dan 5 gangguan sinkronisasi SIVIL"],
    [path.join(DOMAIN4, "recovery-timeout-rpc-final-1.csv"), "15_recovery_timeout_rpc_final_1.csv", "final_auxiliary", "commit on-chain sukses saat pembacaan receipt timeout; recovery dipisahkan"],
    [path.join(DUPLICATE_NIM, "results.csv"), "16_duplikat_nim_ui_final_3.csv", "final", "tiga penolakan NIM duplikat lewat form aktual"],
    [path.join(DOMAIN4, "metrik-domain4-final.csv"), "17_metrik_domain4_final.csv", "final", "statistik matriks, latensi, cascading revoke, dan recovery"],
    [path.join(DOMAIN4, "snapshot-pasca-domain4-final-212.csv"), "18_snapshot_pasca_domain4_final_212.csv", "final", "snapshot lintas sistem setelah mutasi Domain 4"],
    [path.join(DOMAIN4, "transaksi-revoke-final-14.csv"), "19_transaksi_revoke_final_14.csv", "final", "14 receipt revoke unik dari matriks, cascade inti, dan kasus auxiliary"],
  ];

  const manifest = [];
  for (const [sourceName, targetName, scope, purpose] of files) {
    const source = path.isAbsolute(sourceName) ? sourceName : path.join(SOURCE, sourceName);
    const target = path.join(TARGET, targetName);
    fs.copyFileSync(source, target);
    const parsed = parseCsv(target);
    manifest.push({ filename: targetName, scope, rows: parsed.rows.length, columns: parsed.headers.length, purpose });
  }

  const summary = parseCsv(path.join(SOURCE, "analisis_ringkasan_run.csv"));
  const finalSummary = summary.rows.filter((row) => row.analysis_role !== "historical_pre_reset");
  finalSummary.push(
    { domain: "verification", experiment: "latency_final", unit: "verification", total: 30, passed: 30, failed: 0, scr_percent: 100, analysis_role: "final" },
    { domain: "verification", experiment: "matrix_B1_B5", unit: "decision", total: 13, passed: 13, failed: 0, scr_percent: 100, analysis_role: "final" },
    { domain: "revoke", experiment: "cascade_normal_first_attempt", unit: "credential", total: 5, passed: 5, failed: 0, scr_percent: 100, analysis_role: "final_first_pass" },
    { domain: "revoke", experiment: "cascade_with_sivil_outage_first_attempt", unit: "credential", total: 5, passed: 0, failed: 5, scr_percent: 0, analysis_role: "final_expected_injected_failure" },
    { domain: "revoke", experiment: "cascade_all_eventual", unit: "credential", total: 10, passed: 10, failed: 0, scr_percent: 100, analysis_role: "final_with_recovery" },
    { domain: "revoke", experiment: "rpc_receipt_timeout_recovery", unit: "credential", total: 1, passed: 1, failed: 0, scr_percent: 100, analysis_role: "final_auxiliary_excluded_from_core" },
    { domain: "application", experiment: "duplicate_nim_ui", unit: "form_submission", total: 3, passed: 3, failed: 0, scr_percent: 100, analysis_role: "final" },
  );
  const summaryName = "01_ringkasan_hasil.csv";
  writeCsv(path.join(TARGET, summaryName), summary.headers, finalSummary);
  manifest.unshift({ filename: summaryName, scope: "final", rows: finalSummary.length, columns: summary.headers.length, purpose: "ringkasan seluruh domain final untuk SCR dan status akhir" });

  const ineligible = parseCsv(path.join(SOURCE, "raw_ineligible_results.csv"));
  const f06 = ineligible.rows.filter((row) => row.scenario_id === "F06");
  const f06Name = "06_tidak_eligible_f06_10_kasus.csv";
  writeCsv(path.join(TARGET, f06Name), ineligible.headers, f06);
  manifest.splice(5, 0, { filename: f06Name, scope: "final", rows: f06.length, columns: ineligible.headers.length, purpose: "10 penolakan HTTP 422 tanpa reservasi lokal" });

  writeCsv(path.join(TARGET, "MANIFEST.csv"), ["filename", "scope", "rows", "columns", "purpose"], manifest);

  const dictionary = `# Petunjuk Analisis Inti

Folder ini hanya berisi tabel yang digunakan untuk perhitungan. Tidak ada
checkpoint, event journal, gambar, preflight, atau run pengembangan.

## Urutan yang disarankan

1. Mulai dari \`01_ringkasan_hasil.csv\`.
2. Gunakan \`03_alur_fungsional_207_attempt.csv\` untuk SCR langkah dan latensi.
3. Gunakan \`04_batch_detail_10_run.csv\` untuk statistik per repetisi dan
   \`05_batch_agregat_per_ukuran.csv\` untuk ringkasan ukuran batch.
4. Gunakan file 06–08 dan 16 untuk pengujian negatif.
5. Gunakan file 11–17 untuk latensi, matriks keputusan, dan SCR-revoke.
6. Bandingkan \`10_snapshot_212_mahasiswa.csv\` (setelah penerbitan) dengan
   \`18_snapshot_pasca_domain4_final_212.csv\` (setelah mutasi Domain 4).
7. Gunakan file 19 untuk receipt dan gas seluruh transaksi revoke final.

## Aturan perhitungan

- \`analysis_role=final_first_pass\` dipakai untuk SCR first pass.
- \`analysis_role=final_with_recovery\` dipakai untuk SCR eventual.
- Receipt 0 pada duplikat NINA adalah PASS karena transaksi memang diharapkan
  direvert.
- Kelompok gangguan SIVIL memiliki strict first-attempt 0/5 secara disengaja;
  metrik keselamatan dan SCR-revoke eventual masing-masing 10/10.
- Kasus timeout receipt RPC pada file 15 adalah auxiliary dan tidak masuk
  denominator inti cascading revoke n=10.
- Mahasiswa pada filter Lulus Terbit Ijazah ditentukan oleh diploma
  \`statusBlockchain=verified\`; \`statusMesin=SIAP_DITERBITKAN\` bukan kegagalan.

## Batas cakupan

Folder ini hanya memuat kampanye kontrak dan dataset final. Matriks verifikasi,
uji NIM duplikat aplikasi, serta V01 yang lama tetap dikecualikan; file 11–19
berasal dari pengujian ulang current-final dengan run marker baru.

Semua CSV memakai UTF-8, delimiter koma, dan header pada baris pertama.
`;
  fs.writeFileSync(path.join(TARGET, "README.md"), dictionary);

  fs.writeFileSync(path.join(TARGET, "PROVENANCE_FINAL.json"), `${JSON.stringify({
    schema_version: 1,
    scope: "final_only",
    chain_id: 80002,
    contract_address: "0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54",
    gateway: "plum-eldest-tortoise-172.mypinata.cloud",
    dataset: { students: 212, issued_credentials: 200, token_range: "1001-1200", pinata_objects: 406, b5_unminted_nina: "040410582605200" },
    included: ["single-manual-20260809", "fullflow-auto29-r2-20260809", "fullflow-auto29-retry-nim05-20260809", "batchmint-final-170-20260809", "ineligible-final-10-20260809", "duplikat-nina-final-2-20260809", "modifikasi-artefak-final-6-20260809", "latensi-final", "matriks-final", "cascading-revoke-final-20260809", "duplikat-nim-ui-final-20260809"],
    excluded_pre_reset: ["experiment_logs.csv", "pasca-perbaikan-sivil", "historical F-DUP-NIM-APP", "historical V01"],
    auxiliary_excluded_from_core_denominator: ["rpc_receipt_timeout_recovery NIM 20210014"],
    historical_data_present: false
  }, null, 2)}\n`);

  const names = fs.readdirSync(TARGET).filter((name) => name !== "checksums.sha256").sort();
  fs.writeFileSync(path.join(TARGET, "checksums.sha256"), `${names.map((name) => `${sha256(path.join(TARGET, name))}  ${name}`).join("\n")}\n`);
  console.log(JSON.stringify({ target: TARGET, files: fs.readdirSync(TARGET).length, datasets: manifest.length, f06_rows: f06.length }, null, 2));
}

try { main(); }
catch (error) { console.error(error.stack || error.message); process.exit(1); }
