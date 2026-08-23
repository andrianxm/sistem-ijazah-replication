#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const FINAL = path.join(__dirname, "pengujian-final");
const CORE = process.env.CORE_SOURCE_DIR || path.join(FINAL, "analisis-inti-final");
const TARGET = process.env.COMPLETE_CORE_DIR || path.join(FINAL, "analisis-inti-final-utuh-staging");
const CONTRACT = "0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54";
const GATEWAY = "plum-eldest-tortoise-172.mypinata.cloud";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, headers, rows) {
  fs.writeFileSync(file, `${[headers.join(","), ...rows.map((row) => headers.map((header) => csv(row[header])).join(","))].join("\n")}\n`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Sumber tidak ditemukan: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyTree(source, destination) {
  for (const file of walk(source)) copyFile(file, path.join(destination, path.relative(source, file)));
}

function main() {
  if (!fs.existsSync(CORE)) throw new Error(`Folder inti tidak ditemukan: ${CORE}`);
  if (fs.existsSync(TARGET)) throw new Error(`Folder staging sudah ada: ${TARGET}`);
  fs.mkdirSync(TARGET, { recursive: true });

  // Pertahankan seluruh tabel analisis, manifest, provenance, dan README yang
  // sudah diaudit. Checksum dibangun ulang setelah raw/visual/scripts ditambah.
  for (const file of walk(CORE)) {
    if (path.basename(file) === "checksums.sha256") continue;
    copyFile(file, path.join(TARGET, path.relative(CORE, file)));
  }

  const selected = [
    // Baseline final membuktikan dataset, kontrak, gateway, dan state nol awal.
    ["00-baseline", "baseline", "current_final_preflight", "pengujian/experiment_logs/baseline-final-20260809/baseline.json", "raw/00-baseline/baseline.json"],
    ["00-baseline", "baseline", "current_final_preflight", "pengujian/experiment_logs/baseline-final-20260809/run.json", "raw/00-baseline/run.json"],
    ["00-baseline", "baseline", "current_final_preflight", "pengujian/experiment_logs/baseline-final-20260809/events.ndjson", "raw/00-baseline/events.ndjson"],
    ["00-baseline", "baseline", "current_final_preflight", "pengujian/experiment_logs/baseline-final-20260809/results.csv", "raw/00-baseline/results.csv"],
    ["00-baseline", "baseline", "current_final_preflight", "pengujian/experiment_logs/baseline-final-20260809/checkpoint.json", "raw/00-baseline/checkpoint.json"],

    // Alur fungsional final: manual #1001, 29 otomatis, retry NIM05, audit akhir.
    ["01-functional", "single-manual-20260809", "final", "pengujian/experiment_logs/single-manual-20260809/audit.json", "raw/01-functional/manual-single-audit.json"],
    ["01-functional", "fullflow-auto29-r2-20260809", "final_first_pass", "pengujian/experiment_logs/fullflow-auto29-r2-20260809/results.csv", "raw/01-functional/automated-primary-results.csv"],
    ["01-functional", "fullflow-auto29-retry-nim05-20260809", "final_recovery", "pengujian/experiment_logs/fullflow-auto29-retry-nim05-20260809/results.csv", "raw/01-functional/automated-retry-nim05-results.csv"],
    ["01-functional", "fullflow-auto29-final-20260809", "final_audit", "pengujian/experiment_logs/fullflow-auto29-final-20260809/audit.json", "raw/01-functional/automated-final-audit.json"],
    ["01-functional", "fullflow-auto29-startup-failure-20260809", "current_final_failure_evidence", "pengujian/experiment_logs/fullflow-auto29-startup-failure-20260809.json", "raw/01-functional/startup-failure-before-state-change.json"],

    // Batch mint aktual 5x3, 10x3, 25x3, 50x1.
    ["02-batch", "batchmint-final-170-20260809", "final", "pengujian/pengujian-final/batchmint-final-170-20260809/run.json", "raw/02-batch/run.json"],
    ["02-batch", "batchmint-final-170-20260809", "final_append_only", "pengujian/pengujian-final/batchmint-final-170-20260809/events.ndjson", "raw/02-batch/events.ndjson"],
    ["02-batch", "batchmint-final-170-20260809", "final_checkpoint", "pengujian/pengujian-final/batchmint-final-170-20260809/checkpoint.json", "raw/02-batch/checkpoint.json"],
    ["02-batch", "batchmint-final-170-20260809", "final_results", "pengujian/pengujian-final/batchmint-final-170-20260809/results.csv", "raw/02-batch/results.csv"],
    ["02-batch", "batchmint-final-170-20260809", "final_audit", "pengujian/pengujian-final/batchmint-final-170-20260809/audit.json", "raw/02-batch/audit.json"],

    ["03-f06", "ineligible-final-10-20260809", "final_results", "pengujian/pengujian-final/ineligible-final-10-20260809/results.csv", "raw/03-f06/results.csv"],

    ["04-duplicate-nina", "duplikat-nina-final-2-20260809", "final_results", "pengujian/pengujian-final/duplikat-nina-final-2-20260809/results.csv", "raw/04-duplicate-nina/results.csv"],
    ["04-duplicate-nina", "duplikat-nina-final-2-20260809", "final_append_only", "pengujian/pengujian-final/duplikat-nina-final-2-20260809/events.ndjson", "raw/04-duplicate-nina/events.ndjson"],
    ["04-duplicate-nina", "duplikat-nina-final-2-20260809", "final_checkpoint", "pengujian/pengujian-final/duplikat-nina-final-2-20260809/checkpoint.json", "raw/04-duplicate-nina/checkpoint.json"],

    ["05-tamper", "modifikasi-artefak-final-6-20260809", "final_results", "pengujian/pengujian-final/modifikasi-artefak-final-6-20260809/results.csv", "raw/05-tamper/results.csv"],
    ["05-tamper", "modifikasi-artefak-final-6-20260809", "final_append_only", "pengujian/pengujian-final/modifikasi-artefak-final-6-20260809/events.ndjson", "raw/05-tamper/events.ndjson"],
    ["05-tamper", "modifikasi-artefak-final-6-20260809", "final_checkpoint", "pengujian/pengujian-final/modifikasi-artefak-final-6-20260809/checkpoint.json", "raw/05-tamper/checkpoint.json"],
    ["05-tamper", "modifikasi-artefak-final-6-20260809", "final_audit", "pengujian/pengujian-final/modifikasi-artefak-final-6-20260809/audit.json", "raw/05-tamper/audit.json"],

    // Domain 4: file results gabungan adalah log langsung 30 latency + 10 setup + 13 matrix.
    ["06-domain4", "latensi-final+matriks-final", "final_append_only", "pengujian/pengujian-final/domain4-final-20260809/results.csv", "raw/06-domain4/matrix-latency-results.csv"],
    ["06-domain4", "domain4-final-20260809", "final_audit", "pengujian/pengujian-final/domain4-final-20260809/AUDIT_DOMAIN4_FINAL.json", "raw/06-domain4/audit-domain4.json"],
    ["06-domain4", "domain4-final-20260809", "final_state_audit", "pengujian/pengujian-final/domain4-final-20260809/AUDIT_STATE_PASCA_DOMAIN4.json", "raw/06-domain4/audit-state-post-domain4.json"],
    ["06-domain4", "cascading-revoke-final-20260809", "final_results", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/results.csv", "raw/06-domain4/cascade/results.csv"],
    ["06-domain4", "cascading-revoke-final-20260809", "final_append_only", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/events.ndjson", "raw/06-domain4/cascade/events.ndjson"],
    ["06-domain4", "cascading-revoke-final-20260809", "final_checkpoint", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/checkpoint.json", "raw/06-domain4/cascade/checkpoint.json"],
    ["06-domain4", "cascading-revoke-final-20260809", "final_audit", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/audit.json", "raw/06-domain4/cascade/audit.json"],
    ["06-domain4", "rpc-receipt-timeout-recovery", "final_auxiliary_append_only", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/recovery-events.ndjson", "raw/06-domain4/cascade/recovery-events.ndjson"],
    ["06-domain4", "rpc-receipt-timeout-recovery", "final_auxiliary_excluded_from_core", "pengujian/pengujian-final/domain4-final-20260809/cascade-revoke/rpc-receipt-timeout-recovery.json", "raw/06-domain4/cascade/rpc-receipt-timeout-recovery.json"],

    ["07-duplicate-nim-ui", "duplikat-nim-ui-final-20260809", "final_results", "pengujian/pengujian-final/duplikat-nim-ui-final-3-20260809/results.csv", "raw/07-duplicate-nim-ui/results.csv"],
    ["07-duplicate-nim-ui", "duplikat-nim-ui-final-20260809", "final_append_only", "pengujian/pengujian-final/duplikat-nim-ui-final-3-20260809/events.ndjson", "raw/07-duplicate-nim-ui/events.ndjson"],
    ["07-duplicate-nim-ui", "duplikat-nim-ui-final-20260809", "final_audit", "pengujian/pengujian-final/duplikat-nim-ui-final-3-20260809/audit.json", "raw/07-duplicate-nim-ui/audit.json"],

    ["08-negative-audit", "negative-final-20260809", "final_combined_audit", "pengujian/pengujian-final/audit-negatif-final-20260809.json", "raw/08-negative-audit/audit.json"],

    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_metadata", "pengujian/pengujian-final/smart-contract-negative-final-20260810/run.json", "raw/09-smart-contract-negative/run.json"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_append_only", "pengujian/pengujian-final/smart-contract-negative-final-20260810/events.ndjson", "raw/09-smart-contract-negative/events.ndjson"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_checkpoint", "pengujian/pengujian-final/smart-contract-negative-final-20260810/checkpoint.json", "raw/09-smart-contract-negative/checkpoint.json"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_results", "pengujian/pengujian-final/smart-contract-negative-final-20260810/results.csv", "raw/09-smart-contract-negative/results.csv"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_audit", "pengujian/pengujian-final/smart-contract-negative-final-20260810/audit.json", "raw/09-smart-contract-negative/audit.json"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_receipt_rbac", "pengujian/pengujian-final/smart-contract-negative-final-20260810/receipts/SC-RBAC-01.json", "raw/09-smart-contract-negative/receipts/SC-RBAC-01.json"],
    ["09-smart-contract-negative", "smart-contract-negative-final-20260810", "final_receipt_transfer", "pengujian/pengujian-final/smart-contract-negative-final-20260810/receipts/SC-TRANSFER-01.json", "raw/09-smart-contract-negative/receipts/SC-TRANSFER-01.json"],
  ];

  const rawManifest = [];
  for (const [category, run, role, sourceRelative, destinationRelative] of selected) {
    const source = path.join(ROOT, sourceRelative);
    const destination = path.join(TARGET, destinationRelative);
    copyFile(source, destination);
    const sourceHash = sha256(source), packagedHash = sha256(destination);
    if (sourceHash !== packagedHash) throw new Error(`Copy raw berubah: ${sourceRelative}`);
    rawManifest.push({ category, run, analysis_role: role, source_path: sourceRelative, packaged_path: destinationRelative, bytes: fs.statSync(source).size, sha256_source: sourceHash, sha256_packaged: packagedHash, byte_identical: true });
  }
  writeCsv(path.join(TARGET, "RAW_MANIFEST.csv"), ["category", "run", "analysis_role", "source_path", "packaged_path", "bytes", "sha256_source", "sha256_packaged", "byte_identical"], rawManifest);

  // Lampiran final tidak memuat paket historis; hanya visual kampanye current-final.
  copyTree(path.join(FINAL, "lampiran"), path.join(TARGET, "visual"));

  const scripts = [
    "uji-e2e.cjs", "uji-batch-mint.cjs", "uji-duplikat-nina.cjs", "uji-modifikasi-artefak.cjs",
    "uji-matriks.cjs", "uji-cascading-revoke.cjs", "rekonsiliasi-revoke-rpc.cjs", "uji-duplikat-nim-ui.cjs",
    "buat-paket-analisis-final.cjs", "buat-analisis-inti-final.cjs", "buat-ringkasan-domain4-final.cjs",
    "ambil-lampiran-final.cjs", "ambil-lampiran-domain4-final.cjs", "buat-paket-inti-utuh-final.cjs",
    "buat-visual-jejak-token-1002.cjs",
    "uji-rbac-transfer.cjs",
  ];
  for (const name of scripts) copyFile(path.join(__dirname, name), path.join(TARGET, "scripts", name));

  const rawText = walk(path.join(TARGET, "raw")).filter((file) => /\.(csv|json|ndjson|txt|md)$/i.test(file)).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const forbidden = [
    "run=pasca-perbaikan-sivil", "run=detektor-diperbaiki", "historical_pre_reset",
    "run=alur-penuh-auto29-r1-20260809", '"execution_id":"batchmint-final-20260809"',
    "blue-magic-swallow-569.mypinata.cloud",
  ];
  const foundForbidden = forbidden.filter((marker) => rawText.includes(marker));
  if (foundForbidden.length) throw new Error(`Marker lama ditemukan di raw: ${foundForbidden.join(", ")}`);
  const forbiddenSourcePaths = ["experiment_logs.csv", "fullflow-auto29-r1-20260809", "paket-analisis-final-20260809"];
  const selectedForbiddenSources = rawManifest.filter((row) => forbiddenSourcePaths.some((marker) => row.source_path.includes(marker)));
  if (selectedForbiddenSources.length) throw new Error(`Sumber lama masuk whitelist: ${selectedForbiddenSources.map((row) => row.source_path).join(", ")}`);
  const jwtPattern = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
  if (jwtPattern.test(rawText)) throw new Error("Token JWT terdeteksi di paket raw");
  if (!rawText.includes(CONTRACT) || !rawText.includes(GATEWAY)) throw new Error("Bukti kontrak/gateway final tidak ditemukan di raw");

  const provenanceFile = path.join(TARGET, "PROVENANCE_FINAL.json");
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  provenance.package_type = "self_contained_analysis_and_raw_evidence";
  provenance.package_generated_at = new Date().toISOString();
  provenance.layout = { analysis_csv: "01-20 CSV at package root", raw_logs: "raw/", visual_evidence: "visual/", reproduction_scripts: "scripts/" };
  provenance.raw_files = rawManifest.length;
  provenance.raw_copy_policy = "explicit current-final whitelist; byte-identical copy; source and packaged SHA-256 recorded";
  provenance.raw_forbidden_markers_checked = forbidden;
  provenance.secrets_check = "no .env copied; no JWT-shaped token detected";
  provenance.excluded_sources = [
    "pengujian/experiment_logs.csv",
    "pengujian/experiment_logs/fullflow-auto29-r1-20260809/",
    "pengujian/pengujian-final/paket-analisis-final-20260809/",
    "all pre-reset matrix, V01, and edited/development runs not present in explicit whitelist",
  ];
  provenance.historical_data_present = false;
  fs.writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`);

  const readmeFile = path.join(TARGET, "README.md");
  if (!fs.readFileSync(readmeFile, "utf8").includes("## Paket mandiri lengkap")) fs.appendFileSync(readmeFile, `
## Paket mandiri lengkap

Folder ini sekarang merupakan satu-satunya folder yang diperlukan untuk
analisis dan audit pengujian final:

- \`01_...csv\` sampai \`20_...csv\`: tabel siap hitung dan siap impor.
- \`raw/\`: 43 file sumber mentah current-final yang disalin byte-for-byte.
- \`RAW_MANIFEST.csv\`: pemetaan sumber → salinan beserta dua SHA-256.
- \`visual/\`: lampiran UI dan visualisasi hasil final.
- \`scripts/\`: skrip pengujian, recovery, builder, dan reproduksi visual.
- \`security-static/\`: sumber, settings, laporan Slither, dan versi toolchain.
- \`FILE_MANIFEST.csv\`: daftar seluruh berkas di dalam paket.
- \`checksums.sha256\`: checksum seluruh isi paket kecuali file checksum itu sendiri.

### Aturan penggunaan raw

Gunakan \`analysis_role\` pada \`RAW_MANIFEST.csv\`. Kegagalan startup dan
recovery timeout receipt adalah bukti dari kampanye final, bukan data lama.
Keduanya disertakan agar audit tidak hanya berisi kasus sukses, tetapi tidak
dimasukkan ke denominator inti kecuali dinyatakan eksplisit pada file analisis.

Paket historis \`paket-analisis-final-20260809/\`, log global
\`experiment_logs.csv\`, dan run pengembangan \`fullflow-auto29-r1\` tidak ada
di dalam folder ini.
`);

  // FILE_MANIFEST dibuat setelah seluruh konten selain checksum tersedia.
  const beforeManifest = walk(TARGET).filter((file) => !["checksums.sha256", "FILE_MANIFEST.csv"].includes(path.basename(file)));
  const fileRows = beforeManifest.map((file) => ({ path: path.relative(TARGET, file), category: path.relative(TARGET, file).split(path.sep)[0], bytes: fs.statSync(file).size, sha256: sha256(file) })).sort((a, b) => a.path.localeCompare(b.path));
  writeCsv(path.join(TARGET, "FILE_MANIFEST.csv"), ["path", "category", "bytes", "sha256"], fileRows);

  const allFiles = walk(TARGET).filter((file) => path.basename(file) !== "checksums.sha256").sort((a, b) => path.relative(TARGET, a).localeCompare(path.relative(TARGET, b)));
  fs.writeFileSync(path.join(TARGET, "checksums.sha256"), `${allFiles.map((file) => `${sha256(file)}  ${path.relative(TARGET, file)}`).join("\n")}\n`);

  const audit = {
    status: "pass", target: TARGET, analysis_csv_files: fs.readdirSync(TARGET).filter((name) => /^\d{2}_.*\.csv$/.test(name)).length,
    raw_files: rawManifest.length, visual_files: walk(path.join(TARGET, "visual")).length,
    script_files: walk(path.join(TARGET, "scripts")).length, total_files: walk(TARGET).length,
    contract_address: CONTRACT, gateway: GATEWAY, historical_data_present: false,
    forbidden_markers_found: foundForbidden, jwt_detected: false,
  };
  console.log(JSON.stringify(audit, null, 2));
}

try { main(); }
catch (error) { console.error(error.stack || error.message); process.exit(1); }
