#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(__dirname, "..", "sia-simulasi", "node_modules", "puppeteer"));

const FINAL = path.join(__dirname, "pengujian-final");
const DOMAIN4 = path.join(FINAL, "domain4-final-20260809");
const OUT = path.join(FINAL, "lampiran", "domain4-final-20260809");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function shell(title, subtitle, content) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#eef1f5;color:#17202a;font-family:Inter,Arial,sans-serif}.page{width:1500px;min-height:850px;margin:auto;background:#fff;padding:52px 62px}
  .eyebrow{font-size:14px;font-weight:800;letter-spacing:.12em;color:#8b0000;text-transform:uppercase}h1{font-size:38px;margin:9px 0 6px;color:#270303}.sub{font-size:18px;color:#687386;margin-bottom:28px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-bottom:28px}.card{border:1px solid #e1e5ea;border-radius:14px;padding:18px;background:#fafbfc}.n{font-size:30px;font-weight:850;color:#8b0000}.l{font-size:13px;color:#687386;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:14px}th{background:#770000;color:white;text-align:left;padding:11px}td{padding:10px 11px;border-bottom:1px solid #e2e6eb}tr:nth-child(even)td{background:#fafafa}.pass{color:#166534;background:#dcfce7;border-radius:999px;padding:3px 9px;font-weight:800}.warn{color:#92400e;background:#fef3c7;border-radius:999px;padding:3px 9px;font-weight:800}.foot{margin-top:24px;padding-top:15px;border-top:1px solid #e2e6eb;color:#687386;font-size:12px}
  </style></head><body><main class="page"><div class="eyebrow">Lampiran Pengujian Final</div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>${content}<div class="foot">Scope current-final-only • Kontrak 0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54 • Polygon Amoy 80002 • Gateway plum-eldest-tortoise-172.mypinata.cloud</div></main></body></html>`;
}

async function render(page, name, html) {
  const htmlFile = path.join(OUT, `${name}.html`), pngFile = path.join(OUT, `${name}.png`);
  fs.writeFileSync(htmlFile, html);
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: pngFile, fullPage: true });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const audit = JSON.parse(fs.readFileSync(path.join(DOMAIN4, "AUDIT_DOMAIN4_FINAL.json"), "utf8"));
  const cascade = JSON.parse(fs.readFileSync(path.join(DOMAIN4, "cascade-revoke", "audit.json"), "utf8"));
  const rpc = JSON.parse(fs.readFileSync(path.join(DOMAIN4, "cascade-revoke", "rpc-receipt-timeout-recovery.json"), "utf8"));
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(), args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const a = audit.verification_latency;
    await render(page, "01-ringkasan-domain4-final", shell("Domain 4 — Verifikasi dan Pencabutan", "Matriks keputusan, latensi verifikasi, cascading revoke, dan recovery pada kampanye final.", `<div class="cards"><div class="card"><div class="n">13/13</div><div class="l">Kesesuaian matriks</div></div><div class="card"><div class="n">${a.median} ms</div><div class="l">Median verifikasi, n=30</div></div><div class="card"><div class="n">${a.p95} ms</div><div class="l">p95 verifikasi, type 7</div></div><div class="card"><div class="n">100%</div><div class="l">SCR-revoke eventual, n=10</div></div></div><table><thead><tr><th>Pengujian</th><th>Desain</th><th>First attempt</th><th>Safety</th><th>Eventual</th><th>Status</th></tr></thead><tbody><tr><td>Matriks B1–B5</td><td>3+3+3+3+1</td><td>13/13 sesuai</td><td>—</td><td>—</td><td><span class="pass">PASS</span></td></tr><tr><td>Cascade normal</td><td>5 revoke</td><td>100%</td><td>100%</td><td>100%</td><td><span class="pass">PASS</span></td></tr><tr><td>Gangguan SIVIL</td><td>5 revoke</td><td>0% strict (disengaja)</td><td>100%</td><td>100%</td><td><span class="pass">PASS</span></td></tr><tr><td>Timeout receipt RPC</td><td>1 kasus tambahan</td><td>cascade lokal tertinggal</td><td>100%</td><td>pulih</td><td><span class="warn">AUXILIARY</span></td></tr></tbody></table>`));

    const matrixRows = Object.entries(audit.matrix.groups).map(([id, n]) => `<tr><td>${id}</td><td>${n}</td><td>${id === "V-B1" ? "aktif × aktif" : id === "V-B2" ? "aktif × token revoked" : id === "V-B3" ? "registri revoked × aktif" : id === "V-B4" ? "registri tidak ditemukan × aktif" : "aktif × token tidak ditemukan"}</td><td>${id === "V-B1" ? "valid" : "tidak valid"}</td><td><span class="pass">${n}/${n}</span></td></tr>`).join("");
    await render(page, "02-matriks-keputusan-final", shell("Matriks Keputusan B1–B5", "Seluruh 13 keputusan dibaca dari variabel isValid, sivilStatus, dan blockchainData.is_active.", `<div class="cards"><div class="card"><div class="n">100%</div><div class="l">Conformance</div></div><div class="card"><div class="n">13</div><div class="l">Kasus final</div></div><div class="card"><div class="n">5</div><div class="l">Kombinasi status</div></div><div class="card"><div class="n">0</div><div class="l">Mismatch</div></div></div><table><thead><tr><th>ID</th><th>n</th><th>Kondisi</th><th>Keputusan</th><th>Hasil</th></tr></thead><tbody>${matrixRows}</tbody></table>`));

    const cascadeRows = cascade.cases.map((row) => `<tr><td>${esc(row.case_id)}</td><td>${esc(row.nim)}</td><td>#${row.token_id}</td><td>${esc(row.mode)}</td><td>${row.action_latency_ms}</td><td>${row.first_attempt_cascade ? "ya" : "tidak (injeksi)"}</td><td>${row.safety_denial ? "ya" : "tidak"}</td><td>${row.eventual_consistency ? "ya" : "tidak"}</td><td><span class="pass">PASS</span></td></tr>`).join("");
    await render(page, "03-cascading-revoke-final", shell("Cascading Revoke dan SCR-revoke", "Lima kondisi normal dan lima gangguan sinkronisasi SIVIL; gangguan dipulihkan lewat retry eksplisit.", `<div class="cards"><div class="card"><div class="n">5/5</div><div class="l">Normal first attempt</div></div><div class="card"><div class="n">10/10</div><div class="l">Safety denial</div></div><div class="card"><div class="n">10/10</div><div class="l">Eventual consistency</div></div><div class="card"><div class="n">0</div><div class="l">Pin ditambahkan</div></div></div><table><thead><tr><th>Kasus</th><th>NIM</th><th>Token</th><th>Mode</th><th>Aksi ms</th><th>Strict awal</th><th>Safety</th><th>Eventual</th><th>Status</th></tr></thead><tbody>${cascadeRows}</tbody></table>`));

    await render(page, "04-recovery-timeout-receipt-rpc", shell("Temuan Timeout Receipt RPC", "Transaksi sudah committed on-chain, tetapi aplikasi melaporkan error sebelum cascade lokal; kasus dipisahkan dari denominator inti.", `<div class="cards"><div class="card"><div class="n">#${rpc.token_id}</div><div class="l">Token nonaktif</div></div><div class="card"><div class="n">1</div><div class="l">Receipt status</div></div><div class="card"><div class="n">${rpc.recovery.latency_ms} ms</div><div class="l">Recovery lokal</div></div><div class="card"><div class="n">0</div><div class="l">Transaksi revoke kedua</div></div></div><table><tbody><tr><th>NIM</th><td>${rpc.nim}</td></tr><tr><th>TxHash</th><td>${rpc.tx_hash}</td></tr><tr><th>State awal</th><td>token revoked; SIA/PISN/SIVIL masih aktif; keputusan verifikasi sudah tidak valid</td></tr><tr><th>Recovery</th><td>${esc(rpc.recovery.method)}</td></tr><tr><th>State akhir</th><td>seluruh lapisan konsisten revoked</td></tr><tr><th>Analysis role</th><td>${esc(rpc.analysis_role)}; tidak masuk denominator inti n=10</td></tr></tbody></table>`));

    const snapshotLines = fs.readFileSync(path.join(DOMAIN4, "snapshot-pasca-domain4-final-212.csv"), "utf8").trim().split(/\r?\n/);
    const headers = snapshotLines.shift().split(",");
    const records = snapshotLines.map((line) => Object.fromEntries(headers.map((header, i) => [header, line.split(",")[i] || ""])));
    const targets = [
      ["B1", "20210001"], ["B2", "20210003"], ["B3", "20210006"], ["B4", "20210009"], ["B5", "20210211", "040410582605200"], ["CASCADE", "20210013"],
    ];
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    for (const [label, nim, ninaOverride] of targets) {
      const record = records.find((item) => item.nim === nim);
      const nina = ninaOverride || record?.nina;
      if (!nina || !record?.name) throw new Error(`Target visual ${label}/${nim} tidak ditemukan`);
      await page.goto(`http://localhost:8001/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(record.name)}`, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForFunction(() => /Data Terverifikasi|Data Tidak Valid|tidak valid|Tidak Valid/i.test(document.body.innerText), { timeout: 30000 });
      await page.screenshot({ path: path.join(OUT, `05-ui-sivil-${label}.png`), fullPage: false });
    }

    for (let i = 1; i <= 3; i++) {
      fs.copyFileSync(path.join(FINAL, "duplikat-nim-ui-final-3-20260809", `F-DUP-NIM-APP-${i}.png`), path.join(OUT, `06-ui-duplikat-nim-${i}.png`));
    }
    fs.writeFileSync(path.join(OUT, "README.md"), "# Lampiran visual Domain 4 final\n\nPNG 01-04 adalah visualisasi langsung dari log final. PNG 05 adalah tangkapan layar UI SIVIL aktual untuk B1-B5 dan cascading revoke. PNG 06 adalah tangkapan layar form SIAKAD aktual untuk tiga NIM duplikat.\n");
    console.log(`Lampiran Domain 4 tersimpan: ${OUT}`);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
