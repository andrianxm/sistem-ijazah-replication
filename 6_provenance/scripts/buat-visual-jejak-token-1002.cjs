#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function resolvePuppeteer() {
  const candidates = [
    path.join(__dirname, "..", "sia-simulasi", "node_modules", "puppeteer"),
    path.join(__dirname, "..", "..", "..", "..", "sia-simulasi", "node_modules", "puppeteer"),
  ];
  const modulePath = process.env.PUPPETEER_MODULE || candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) throw new Error("Modul Puppeteer tidak ditemukan; set PUPPETEER_MODULE ke direktori modul Puppeteer");
  return require(modulePath);
}

const packagedCore = path.join(__dirname, "..");
const CORE = process.env.CORE_ANALYSIS_DIR || (fs.existsSync(path.join(packagedCore, "03_alur_fungsional_207_attempt.csv"))
  ? packagedCore
  : path.join(__dirname, "pengujian-final", "analisis-inti-final"));
const ANALYSIS = path.join(CORE, "03_alur_fungsional_207_attempt.csv");
const RAW = path.join(CORE, "raw", "01-functional", "automated-primary-results.csv");
const OUT = path.join(CORE, "visual");
const HTML = path.join(OUT, "07-jejak-end-to-end-token-1002.html");
const PNG = path.join(OUT, "07-jejak-end-to-end-token-1002.png");
const PAPER_HTML = path.join(OUT, "08-jejak-token-1002-paper-minimal.html");
const PAPER_PNG = path.join(OUT, "08-jejak-token-1002-paper-minimal.png");

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
  return records.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function short(value, start = 14, end = 10) {
  const text = String(value || "");
  return text.length > start + end + 3 ? `${text.slice(0, start)}…${text.slice(-end)}` : text;
}

function printTerminalTrace(rows, stageInfo, elapsed, analysisHash, rawHash) {
  const mint = rows.find((row) => row.scenario_id === "F07");
  const verify = rows.find((row) => row.scenario_id === "F08");
  if (!process.argv.includes("--terminal-detail")) {
    console.log(`Run       : ${rows[0].source_run} (${rows[0].analysis_role})`);
    console.log(`Mahasiswa : ${rows[0].student_name} | NIM ${rows[0].nim}`);
    console.log(`NINA      : ${rows.find((row) => row.nina)?.nina}`);
    console.log(`Waktu     : ${rows[0].timestamp_start} → ${rows.at(-1).timestamp_end}`);
    console.log(`Wall-clock: ${elapsed.toLocaleString("id-ID")} ms | Tahap: 7/7 PASS`);
    console.log("");
    console.log(`Token     : #${mint.token_id}`);
    console.log(`CID       : ${mint.cid}`);
    console.log(`TxHash    : ${mint.tx_hash}`);
    console.log(`Verifikasi: ${verify.final_verification} (${verify.verification_mode})`);
    console.log("Kontrak   : 0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54");
    console.log("Gateway   : plum-eldest-tortoise-172.mypinata.cloud");
    return;
  }

  const color = process.stdout.isTTY && !process.argv.includes("--no-color");
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const divider = "─".repeat(112);
  const evidence = (row) => {
    switch (row.scenario_id) {
      case "F01": return `Status SIA: ${row.sia_status || "-"}`;
      case "F02": return `Status eligible: ${row.mock_pisn_status || row.actual}`;
      case "F03": return `NINA: ${row.nina} | reservation_id: ${row.reservation_id}`;
      case "F04": return row.notes.replace(/^.*?pdf=/, "PDF: ");
      case "F05": return `CID: ${row.cid}`;
      case "F07": return `Token: #${row.token_id}\n     TxHash: ${row.tx_hash}`;
      case "F08": return `Keputusan: ${row.final_verification.toUpperCase()} | mode: ${row.verification_mode}\n     ${row.notes.replace(/^.*?sivil=/, "URL SIVIL: ")}`;
      default: return "";
    }
  };

  console.log(paint("1;31", "JEJAK END-TO-END KREDENSIAL OTOMATIS — TOKEN #1002"));
  console.log(divider);
  console.log(`Run       : ${rows[0].source_run} (${rows[0].analysis_role})`);
  console.log(`Mahasiswa : ${rows[0].student_name} | NIM ${rows[0].nim}`);
  console.log(`NINA      : ${rows.find((row) => row.nina)?.nina}`);
  console.log(`Waktu     : ${rows[0].timestamp_start} → ${rows.at(-1).timestamp_end}`);
  console.log(`Wall-clock: ${elapsed.toLocaleString("id-ID")} ms | Tahap: ${paint("1;32", "7/7 PASS")}`);
  console.log(divider);

  rows.forEach((row, index) => {
    const [title, system] = stageInfo[row.scenario_id];
    const latency = Number(row.latency_ms);
    const resumeMark = latency === 0 ? " *resume" : "";
    console.log(`${String(index + 1).padStart(2, "0")}. ${paint("1;32", "[PASS]")} ${paint("1", row.scenario_id)} ${title} — ${system} | ${latency.toLocaleString("id-ID")} ms${resumeMark}`);
    console.log(`    ${row.timestamp_start} → ${row.timestamp_end}`);
    console.log(`    Expected: ${row.expected}`);
    console.log(`    Actual  : ${row.actual}`);
    console.log(`    Bukti   : ${evidence(row)}`);
    console.log(`    Notes   : ${row.notes}`);
    if (index < rows.length - 1) console.log("");
  });

  console.log(divider);
  console.log(paint("1;32", "HASIL AKHIR: VALID — registri aktif dan token blockchain aktif"));
  console.log(`Token     : #${mint.token_id}`);
  console.log(`CID       : ${mint.cid}`);
  console.log(`TxHash    : ${mint.tx_hash}`);
  console.log(`Verifikasi: ${verify.final_verification} (${verify.verification_mode})`);
  console.log(`Kontrak   : 0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54`);
  console.log(`Gateway   : plum-eldest-tortoise-172.mypinata.cloud`);
  console.log(divider);
  console.log(`Sumber analisis SHA-256: ${analysisHash}`);
  console.log(`Sumber raw      SHA-256: ${rawHash}`);
  console.log("* F01 dan F02 meneruskan state yang tersedia; 0 ms bukan latensi jaringan.");
}

async function main() {
  const rows = parseCsv(ANALYSIS).filter((row) => row.nim === "20210002" && row.source_run === "fullflow_primary_r2");
  const expectedStages = ["F01", "F02", "F03", "F04", "F05", "F07", "F08"];
  if (rows.length !== expectedStages.length || expectedStages.some((stage, index) => rows[index]?.scenario_id !== stage)) {
    throw new Error(`Jejak token #1002 tidak lengkap/berurutan: ${rows.map((row) => row.scenario_id).join(",")}`);
  }
  if (!rows.every((row) => row.status === "pass")) throw new Error("Jejak token #1002 mengandung langkah non-pass");

  const byStage = Object.fromEntries(rows.map((row) => [row.scenario_id, row]));
  const mint = byStage.F07, verification = byStage.F08, ipfs = byStage.F05;
  if (mint.token_id !== "1002" || verification.final_verification !== "valid") throw new Error("Token atau hasil verifikasi akhir tidak sesuai");
  const elapsed = new Date(verification.timestamp_end).getTime() - new Date(rows[0].timestamp_start).getTime();
  const stageInfo = {
    F01: ["Lapor Data", "PDDikti", "Data sudah tercatat", "resume"],
    F02: ["Uji Eligible", "PDDikti", "Status eligible", "resume"],
    F03: ["Reservasi NINA", "PISN", byStage.F03.nina, "lookup"],
    F04: ["Bentuk PDF", "SIA", "PDF ijazah terbentuk", "process"],
    F05: ["Enkripsi & Unggah", "IPFS / Pinata", short(ipfs.cid), "external"],
    F07: ["Mint Token", "Polygon Amoy", `Token #${mint.token_id}`, "chain"],
    F08: ["Verifikasi Dua Lapis", "SIVIL", "VALID", "verify"],
  };
  if (process.argv.includes("--terminal") || process.argv.includes("--terminal-detail")) {
    printTerminalTrace(rows, stageInfo, elapsed, sha256(ANALYSIS), sha256(RAW));
    return;
  }
  const stageRows = rows.map((row, index) => {
    const [title, system, result, kind] = stageInfo[row.scenario_id];
    const latency = Number(row.latency_ms);
    const width = Math.max(4, Math.round(latency / 90));
    return `<div class="step ${kind}">
      <div class="rail"><span class="dot">${index + 1}</span>${index < rows.length - 1 ? '<span class="line"></span>' : ''}</div>
      <div class="step-main"><div class="step-top"><span class="id">${row.scenario_id}</span><h3>${esc(title)}</h3><span class="system">${esc(system)}</span><span class="pass">PASS</span></div>
      <div class="step-bottom"><span class="result">${esc(result)}</span><div class="latency"><span style="width:${width}px"></span><strong>${latency.toLocaleString("id-ID")} ms</strong></div><time>${esc(row.timestamp_start.slice(11, 23))} → ${esc(row.timestamp_end.slice(11, 23))}</time></div></div>
    </div>`;
  }).join("");

  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Jejak End-to-End Token #1002</title><style>
  *{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#17212b;font-family:Inter,Arial,sans-serif}.page{width:1600px;min-height:1120px;margin:auto;background:#fff;padding:48px 62px 40px}
  .eyebrow{color:#8b0000;font-size:14px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.head{display:flex;justify-content:space-between;gap:32px;align-items:flex-start}.head h1{font-size:40px;line-height:1.08;margin:9px 0 10px;color:#270303}.subtitle{font-size:17px;color:#637083}.badge{padding:13px 20px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:999px;font-size:17px;font-weight:850;white-space:nowrap;margin-top:20px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.card{border:1px solid #e0e5ea;border-radius:14px;background:#fafbfc;padding:17px 19px}.card .v{font-weight:850;font-size:22px;color:#5d0000}.card .k{font-size:12px;color:#6b7788;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}.card code{font-size:13px}
  .body{display:grid;grid-template-columns:1.3fr .7fr;gap:28px}.panel{border:1px solid #dfe4e9;border-radius:16px;padding:22px;background:#fff}.panel h2{font-size:21px;margin:0 0 17px;color:#330404}.step{display:flex;gap:14px;min-height:83px}.rail{width:34px;display:flex;flex-direction:column;align-items:center}.dot{display:flex;align-items:center;justify-content:center;width:31px;height:31px;border-radius:50%;background:#800000;color:#fff;font-weight:850;font-size:13px}.line{width:3px;flex:1;background:#eadada;margin:4px 0}.step-main{flex:1;padding-bottom:12px}.step-top{display:flex;align-items:center;gap:10px}.id{font-family:ui-monospace,monospace;font-size:12px;color:#800000;background:#f9e8e8;padding:3px 7px;border-radius:6px}.step h3{margin:0;font-size:16px}.system{font-size:12px;color:#5f6d7b}.pass{margin-left:auto;font-size:11px;font-weight:850;color:#166534;background:#dcfce7;padding:4px 9px;border-radius:999px}.step-bottom{display:grid;grid-template-columns:1fr 165px 190px;gap:10px;align-items:center;margin-top:8px;font-size:12px;color:#6a7684}.result{font-weight:700;color:#334155}.latency{display:flex;gap:8px;align-items:center}.latency span{display:block;height:7px;max-width:105px;background:#b91c1c;border-radius:99px}.latency strong{color:#4b5563;white-space:nowrap}time{font-family:ui-monospace,monospace;font-size:11px}
  .facts{display:grid;gap:12px}.fact{padding:13px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px}.fact .label{font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.07em;margin-bottom:5px}.fact .value{font-size:14px;font-weight:750;word-break:break-all}.fact code{font-size:11px}.callout{margin-top:15px;padding:14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;color:#9a3412;font-size:12px;line-height:1.45}.integrity{margin-top:16px;padding-top:15px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b}.integrity code{display:block;margin-top:4px;word-break:break-all;color:#475569}
  .foot{display:flex;justify-content:space-between;gap:20px;margin-top:24px;padding-top:16px;border-top:1px solid #dfe4e9;font-size:11px;color:#64748b}.foot strong{color:#334155}
  </style></head><body><main class="page">
  <div class="head"><div><div class="eyebrow">Lampiran Pengujian Final · Integrasi Fungsional</div><h1>Jejak End-to-End Kredensial Otomatis<br>Token #1002</h1><div class="subtitle">Run fullflow_primary_r2 · 8 Agustus 2026 · Seluruh keluaran berasal dari log current-final</div></div><div class="badge">✓ 7/7 TAHAP PASS</div></div>
  <section class="cards"><div class="card"><div class="k">Mahasiswa</div><div class="v">${esc(mint.student_name)}</div><code>NIM ${mint.nim}</code></div><div class="card"><div class="k">Nomor NINA</div><div class="v" style="font-size:19px">${mint.nina}</div><code>reservasi aktif</code></div><div class="card"><div class="k">Token</div><div class="v">#${mint.token_id}</div><code>Polygon Amoy 80002</code></div><div class="card"><div class="k">Elapsed wall-clock</div><div class="v">${elapsed.toLocaleString("id-ID")} ms</div><code>${rows[0].timestamp_start.slice(11,19)}–${verification.timestamp_end.slice(11,19)} UTC</code></div></section>
  <div class="body"><section class="panel"><h2>Urutan eksekusi aktual</h2>${stageRows}</section><aside class="panel"><h2>Identitas dan bukti transaksi</h2><div class="facts">
    <div class="fact"><div class="label">Keputusan akhir SIVIL</div><div class="value" style="color:#166534">VALID · mode live</div></div>
    <div class="fact"><div class="label">CID artefak terenkripsi</div><div class="value"><code>${esc(ipfs.cid)}</code></div></div>
    <div class="fact"><div class="label">TxHash mint</div><div class="value"><code>${esc(mint.tx_hash)}</code></div></div>
    <div class="fact"><div class="label">Status registri / blockchain</div><div class="value">aktif / aktif</div></div>
    <div class="fact"><div class="label">URL verifikasi yang dicatat</div><div class="value"><code>nina=${esc(mint.nina)}&amp;nama=${encodeURIComponent(mint.student_name)}</code></div></div>
  </div><div class="callout"><strong>Catatan pembacaan latensi.</strong> F01 dan F02 bernilai 0 ms karena runner meneruskan state yang sudah tersedia (<em>resume=already_reported</em> dan <em>already_eligible</em>), bukan karena operasi jaringan memiliki latensi nol. F03 juga menggunakan NINA yang telah tersedia dan mencatat waktu lookup 17 ms.</div>
  <div class="integrity">Sumber analisis: <code>03_alur_fungsional_207_attempt.csv<br>SHA-256 ${sha256(ANALYSIS)}</code>Sumber mentah: <code>raw/01-functional/automated-primary-results.csv<br>SHA-256 ${sha256(RAW)}</code></div></aside></div>
  <div class="foot"><span><strong>Kontrak:</strong> 0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54</span><span><strong>Gateway:</strong> plum-eldest-tortoise-172.mypinata.cloud</span><span><strong>Hasil:</strong> credential verified</span></div>
  </main></body></html>`;

  const compactStages = rows.map((row, index) => {
    const [title, system] = stageInfo[row.scenario_id];
    return `<div class="paper-step"><div class="paper-dot">${index + 1}</div><span class="paper-id">${row.scenario_id}</span><strong>${esc(title)}</strong><small>${esc(system)}</small><b>${Number(row.latency_ms).toLocaleString("id-ID")} ms${Number(row.latency_ms) === 0 ? "*" : ""}</b></div>`;
  }).join("");
  const paperHtml = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Jejak Token #1002 — Versi Paper</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#171717;font-family:Arial,Helvetica,sans-serif}.sheet{width:1600px;height:470px;padding:38px 48px 20px;background:#fff}.top{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2px solid #6f0000;padding-bottom:17px}.kicker{font-size:14px;font-weight:700;letter-spacing:.1em;color:#700000;text-transform:uppercase}.top h1{font-size:31px;line-height:1.08;margin:6px 0 7px}.meta{font-size:16px;color:#4b5563}.result{border:1px solid #15803d;color:#166534;border-radius:8px;padding:11px 16px;font-size:17px;font-weight:700;white-space:nowrap}.flow{position:relative;display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin:35px 0 30px}.flow:before{content:"";position:absolute;height:3px;background:#d5d5d5;left:7%;right:7%;top:18px}.paper-step{position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;min-width:0}.paper-dot{z-index:1;width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#760000;color:#fff;font-weight:700;border:4px solid #fff;outline:1px solid #760000}.paper-id{margin-top:12px;font-family:monospace;font-size:12px;color:#760000}.paper-step strong{font-size:15px;margin-top:4px}.paper-step small{font-size:12px;color:#6b7280;margin-top:3px}.paper-step b{font-size:14px;margin-top:8px;color:#262626}.evidence{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:13px}.box{border:1px solid #d1d5db;border-radius:7px;padding:13px 16px;min-width:0}.box span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin-bottom:5px}.box strong{font-size:15px}.box code{font-size:12px;white-space:nowrap}.valid{color:#166534}.note{display:flex;justify-content:space-between;gap:20px;margin-top:17px;padding-top:13px;border-top:1px solid #d1d5db;font-size:11px;color:#5f6670}.note span:last-child{text-align:right}.note strong{color:#30343a}
  </style></head><body><main class="sheet"><header class="top"><div><div class="kicker">Integrasi fungsional · bukti current-final</div><h1>Jejak penerbitan otomatis — Token #1002</h1><div class="meta">NIM ${esc(mint.nim)} · NINA ${esc(mint.nina)} · Polygon Amoy (chain 80002)</div></div><div class="result">7/7 PASS · ${elapsed.toLocaleString("id-ID")} ms</div></header>
  <section class="flow">${compactStages}</section>
  <section class="evidence"><div class="box"><span>Artefak terenkripsi</span><code>CID ${esc(short(ipfs.cid, 20, 12))}</code></div><div class="box"><span>Transaksi mint</span><code>${esc(short(mint.tx_hash, 18, 12))}</code></div><div class="box"><span>Keputusan dua lapis</span><strong class="valid">Registri aktif · Blockchain aktif · VALID</strong></div></section>
  <footer class="note"><span><strong>* F01–F02:</strong> state dilanjutkan oleh mekanisme resume; 0 ms bukan latensi jaringan.</span><span>Sumber: 03_alur_fungsional_207_attempt.csv · run <strong>fullflow_primary_r2</strong></span></footer></main></body></html>`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, html);
  fs.writeFileSync(PAPER_HTML, paperHtml);
  const puppeteer = resolvePuppeteer();
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(), args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1120, deviceScaleFactor: 1 });
    await page.goto(`file://${HTML}`, { waitUntil: "load" });
    await page.screenshot({ path: PNG, fullPage: true });
    const paperPage = await browser.newPage();
    await paperPage.setViewport({ width: 1600, height: 470, deviceScaleFactor: 1 });
    await paperPage.goto(`file://${PAPER_HTML}`, { waitUntil: "load" });
    await paperPage.screenshot({ path: PAPER_PNG, fullPage: true });
  } finally { await browser.close(); }
  console.log(JSON.stringify({ status: "pass", html: HTML, png: PNG, paper_html: PAPER_HTML, paper_png: PAPER_PNG, rows: rows.length, nim: mint.nim, nina: mint.nina, token_id: mint.token_id, elapsed_ms: elapsed, final_verification: verification.final_verification }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
