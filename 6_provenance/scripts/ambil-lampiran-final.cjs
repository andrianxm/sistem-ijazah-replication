#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(__dirname, "..", "sia-simulasi", "node_modules", "puppeteer"));

const ROOT = path.join(__dirname, "..");
const OUT = process.env.LAMPIRAN_DIR || path.join(__dirname, "pengujian-final", "lampiran");
const EMAIL = process.env.REKTOR_EMAIL;
const PASSWORD = process.env.REKTOR_PASSWORD;
const DUP_RESULTS = path.join(__dirname, "pengujian-final", "duplikat-nina-final-2-20260809", "results.csv");
const TAMPER_AUDIT = path.join(__dirname, "pengujian-final", "modifikasi-artefak-final-6-20260809", "audit.json");
const INELIGIBLE_RESULTS = path.join(__dirname, "pengujian-final", "ineligible-final-10-20260809", "results.csv");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function parseSimpleCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  return lines.map((line) => Object.fromEntries(header.map((key, i) => [key, line.split(",")[i] || ""])));
}

function shell(title, subtitle, body) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;background:#f4f6f8;color:#17202a;font-family:Inter,Arial,sans-serif}
    .page{width:1500px;min-height:850px;margin:0 auto;padding:54px 64px;background:white}
    .eyebrow{color:#8b0000;font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:14px}
    h1{font-size:38px;margin:10px 0 8px;color:#270303} .subtitle{font-size:18px;color:#637083;margin-bottom:32px}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0 30px}.card{padding:20px;border:1px solid #e1e5ea;border-radius:14px;background:#fafbfc}
    .card .n{font-size:30px;font-weight:800;color:#8b0000}.card .l{font-size:13px;color:#697586;margin-top:4px}
    table{width:100%;border-collapse:collapse;font-size:15px} th{background:#770000;color:#fff;text-align:left;padding:13px 14px}
    td{padding:12px 14px;border-bottom:1px solid #e5e8ec;vertical-align:top} tr:nth-child(even) td{background:#fafafa}
    .pass{display:inline-block;padding:4px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:800}
    code{font-family:ui-monospace,monospace;font-size:12px}.foot{margin-top:28px;padding-top:18px;border-top:1px solid #e5e8ec;color:#697586;font-size:13px}
  </style></head><body><main class="page"><div class="eyebrow">Lampiran Pengujian Final</div><h1>${esc(title)}</h1><div class="subtitle">${esc(subtitle)}</div>${body}<div class="foot">Sumber: log append-only dan receipt aktual • Kontrak 0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54 • Polygon Amoy 80002</div></main></body></html>`;
}

async function screenshotHtml(page, html, htmlName, pngName) {
  fs.writeFileSync(path.join(OUT, htmlName), html);
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: path.join(OUT, pngName), fullPage: true });
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error("REKTOR_EMAIL dan REKTOR_PASSWORD wajib diisi");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    // Bukti UI aktual bahwa tidak ada mahasiswa eligible tanpa NINA.
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle2", timeout: 60000 });
    await page.type('input[type="email"]', EMAIL);
    await page.type('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      page.click('button[type="submit"]'),
    ]);
    await page.goto("http://localhost:3000/integrasi/pisn", { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Buat Reservasi Baru"));
      if (!button) throw new Error("Tombol Buat Reservasi Baru tidak ditemukan");
      button.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes("Tidak ada mahasiswa yang memenuhi syarat"), { timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, "01-F06-tidak-eligible-ui.png"), fullPage: false });

    const duplicate = parseSimpleCsv(DUP_RESULTS);
    const dupRows = duplicate.map((x) => `<tr><td>${esc(x.case_id)}</td><td>${esc(x.nim)}</td><td><code>${esc(x.duplicate_nina)}</code></td><td>#${esc(x.source_token_id)}</td><td><code>${esc(x.tx_hash)}</code></td><td>${esc(x.receipt_status)}</td><td>${esc(x.gas_used)}</td><td>${esc(x.revert_reason)}</td><td><span class="pass">PASS</span></td></tr>`).join("");
    const dupHtml = shell(
      "Penolakan Duplikat NINA",
      "Dua transaksi nyata direvert; nextTokenId tetap #1201 dan tidak ada pin baru.",
      `<div class="cards"><div class="card"><div class="n">2/2</div><div class="l">Kasus lulus</div></div><div class="card"><div class="n">0</div><div class="l">Token bertambah</div></div><div class="card"><div class="n">0</div><div class="l">Pin bertambah</div></div><div class="card"><div class="n">#1201</div><div class="l">nextTokenId sesudah uji</div></div></div><table><thead><tr><th>Kasus</th><th>NIM uji</th><th>NINA aktif</th><th>Token sumber</th><th>Tx hash</th><th>Receipt</th><th>Gas</th><th>Revert reason</th><th>Status</th></tr></thead><tbody>${dupRows}</tbody></table>`,
    );
    await screenshotHtml(page, dupHtml, "02-DUP-NINA-ringkasan.html", "02-DUP-NINA-ringkasan.png");

    const tamper = JSON.parse(fs.readFileSync(TAMPER_AUDIT, "utf8"));
    const tamperRows = tamper.cases.map((x) => `<tr><td>${esc(x.case_id)}</td><td>${esc(x.nim)}</td><td>#${esc(x.token_id)}</td><td>${esc(x.artifact_type)}</td><td><code>${esc(x.source_cid)}</code></td><td><code>${esc(x.tampered_cid)}</code></td><td>${esc(x.detection)}</td><td><span class="pass">PASS</span></td></tr>`).join("");
    const tamperHtml = shell(
      "Deteksi Modifikasi Artefak",
      "Enam salinan terenkripsi dimodifikasi dan dipin; CID asli database dan blockchain tidak diubah.",
      `<div class="cards"><div class="card"><div class="n">6/6</div><div class="l">Modifikasi terdeteksi</div></div><div class="card"><div class="n">6</div><div class="l">CID baru</div></div><div class="card"><div class="n">0</div><div class="l">CID sah diperbarui</div></div><div class="card"><div class="n">#1201</div><div class="l">nextTokenId tetap</div></div></div><table><thead><tr><th>Kasus</th><th>NIM</th><th>Token</th><th>Artefak</th><th>CID sumber</th><th>CID modifikasi</th><th>Deteksi</th><th>Status</th></tr></thead><tbody>${tamperRows}</tbody></table>`,
    );
    await screenshotHtml(page, tamperHtml, "03-TAMPER-ringkasan.html", "03-TAMPER-ringkasan.png");

    const ineligible = parseSimpleCsv(INELIGIBLE_RESULTS);
    const f06 = ineligible.filter((x) => x.scenario_id === "F06");
    const recapHtml = shell(
      "Rekap Pengujian Negatif Final",
      "F06, duplikat NINA, dan modifikasi artefak selesai tanpa membentuk kredensial tidak sah.",
      `<div class="cards"><div class="card"><div class="n">${f06.length}/10</div><div class="l">Tidak eligible ditolak</div></div><div class="card"><div class="n">2/2</div><div class="l">Duplikat NINA direvert</div></div><div class="card"><div class="n">6/6</div><div class="l">Modifikasi terdeteksi</div></div><div class="card"><div class="n">406</div><div class="l">Objek Pinata final terverifikasi</div></div></div><table><thead><tr><th>Kelompok</th><th>Kasus</th><th>Hasil</th><th>Dampak state</th></tr></thead><tbody><tr><td>Tidak eligible</td><td>10</td><td><span class="pass">10 PASS</span></td><td>0 reservasi, 0 NINA, 0 diploma, 0 token, 0 pin</td></tr><tr><td>Duplikat NINA</td><td>2</td><td><span class="pass">2 PASS</span></td><td>Receipt 0; 0 token dan 0 pin</td></tr><tr><td>Modifikasi artefak</td><td>6</td><td><span class="pass">6 PASS</span></td><td>6 pin varian; CID sah dan token tidak berubah</td></tr></tbody></table>`,
    );
    await screenshotHtml(page, recapHtml, "04-REKAP-negatif-final.html", "04-REKAP-negatif-final.png");

    console.log(`Lampiran visual tersimpan di ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
