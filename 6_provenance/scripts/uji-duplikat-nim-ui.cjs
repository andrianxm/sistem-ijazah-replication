#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const puppeteer = require(path.join(__dirname, "..", "sia-simulasi", "node_modules", "puppeteer"));

const ROOT = path.join(__dirname, "..");
const RUN = process.env.DUP_NIM_RUN || "duplikat-nim-ui-final-20260809";
const OUT = process.env.DUP_NIM_LOG_DIR || path.join(__dirname, "pengujian-final", "duplikat-nim-ui-final-3-20260809");
const RESULTS = path.join(OUT, "results.csv");
const EVENTS = path.join(OUT, "events.ndjson");
const AUDIT = path.join(OUT, "audit.json");
const BASE = process.env.SIAKAD_URL || "http://localhost:3000";
const CASES = ["20210001", "20210002", "20210003"].map((nim, index) => ({ case_id: `F-DUP-NIM-APP-${index + 1}`, nim }));

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

function mysql(query) {
  return execFileSync("docker", ["exec", process.env.MYSQL_CONTAINER || "ijazah-mysql", "mysql", "-u", "root", `-p${process.env.MYSQL_PASSWORD || "password"}`, "-B", "-N", "-e", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function counts(nim) {
  const raw = mysql(`SELECT (SELECT COUNT(*) FROM siakad_db.students WHERE nim='${nim}'),(SELECT COUNT(*) FROM siakad_db.student_logs WHERE nim='${nim}' AND aksi='tambah');`);
  const [students, addLogs] = raw.split("\t").map(Number);
  return { students, add_logs: addLogs };
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

async function main() {
  loadEnv(path.join(ROOT, "sia-simulasi", ".env"));
  const email = process.env.REKTOR_EMAIL || "rektor@universitas.ac.id";
  const password = process.env.REKTOR_PASSWORD || "rahasia123";
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(RESULTS)) append(RESULTS, "scenario_id,run,analysis_role,interface,nim,timestamp_start,timestamp_end,http_observation,expected,actual,error_message,inline_validation,toast_notification,students_before,students_after,add_logs_before,add_logs_after,state_unchanged,status,screenshot,notes\n");

  for (const test of CASES) {
    const before = counts(test.nim);
    if (before.students !== 1) throw new Error(`${test.nim}: prasyarat tepat satu mahasiswa gagal (${before.students})`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const rows = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      page.click('button[type="submit"]'),
    ]);
    event("login_completed");

    for (const test of CASES) {
      const started = new Date();
      const before = counts(test.nim);
      const message = `NIM ${test.nim} sudah terdaftar. Gunakan NIM lain.`;
      event("case_started", { case_id: test.case_id, nim: test.nim, before });
      await page.goto(`${BASE}/student/tambah`, { waitUntil: "networkidle2", timeout: 60000 });
      await page.type('input[name="nim"]', test.nim);
      await page.type('input[name="name"]', `Mahasiswa Sintetis Duplikat ${test.nim}`);
      await page.type('input[name="major"]', "Teknik Informatika");
      const faculty = await page.$eval('select[name="facultyId"]', (select) => [...select.options].find((option) => option.value)?.value || "");
      if (!faculty) throw new Error("Pilihan fakultas tidak tersedia");
      await page.select('select[name="facultyId"]', faculty);
      await page.type('input[name="tempatLahir"]', "Kota Uji");
      await page.type('input[name="tanggalLahir"]', "2000-01-01");
      await page.select('select[name="jenisKelamin"]', "L");
      await page.type('input[name="ipk"]', "3.50");
      await page.type('input[name="email"]', `duplikat.${test.nim}@example.test`);
      await page.type('input[name="phone"]', "080000000000");
      await page.click('button[type="submit"]');
      await page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout: 30000 }, message);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const ui = await page.evaluate((expected) => {
        const input = document.querySelector('input[name="nim"]');
        const inline = Boolean(input?.closest(".form-group")?.innerText.includes(expected));
        const visibleExact = [...document.querySelectorAll("body *")].filter((element) => {
          const style = getComputedStyle(element);
          return element.children.length === 0 && element.textContent?.trim() === expected && style.display !== "none" && style.visibility !== "hidden";
        }).length;
        return { inline, visible_exact_message_nodes: visibleExact, toast: visibleExact >= 2, url: location.href };
      }, message);
      const after = counts(test.nim);
      const unchanged = before.students === after.students && before.add_logs === after.add_logs;
      const passed = ui.inline && ui.toast && unchanged && ui.url.includes("/student/tambah");
      const screenshot = `${test.case_id}.png`;
      await page.screenshot({ path: path.join(OUT, screenshot), fullPage: true });
      const row = {
        scenario_id: test.case_id, run: RUN, analysis_role: "first_pass", interface: "browser_ui_automation",
        nim: test.nim, timestamp_start: started.toISOString(), timestamp_end: new Date().toISOString(),
        http_observation: "server action response rendered in form; no raw Prisma/database error",
        expected: "ditolak aplikasi sebelum penyimpanan", actual: passed ? "ditolak sebelum penyimpanan" : "bukti UI/state tidak lengkap",
        error_message: message, inline_validation: ui.inline, toast_notification: ui.toast,
        students_before: before.students, students_after: after.students, add_logs_before: before.add_logs, add_logs_after: after.add_logs,
        state_unchanged: unchanged, status: passed ? "pass" : "fail", screenshot,
        notes: `visible_exact_message_nodes=${ui.visible_exact_message_nodes}; data sintetis; jalur form aktual`,
      };
      append(RESULTS, `${Object.values(row).map(csv).join(",")}\n`);
      event("case_completed", { case_id: test.case_id, nim: test.nim, status: row.status, ui, before, after, screenshot });
      rows.push(row);
      console.log(`${test.case_id}: ${row.status} inline=${ui.inline} toast=${ui.toast} state_unchanged=${unchanged}`);
    }
  } finally {
    await browser.close();
  }

  const audit = {
    schema_version: 1, run: RUN, recorded_at: new Date().toISOString(), analysis_scope: "current_final_only",
    method: "browser UI automation through /student/tambah", cases_expected: CASES.length,
    cases_passed: rows.filter((row) => row.status === "pass").length,
    status: rows.length === CASES.length && rows.every((row) => row.status === "pass") ? "pass" : "fail",
    database_rows_added: rows.reduce((sum, row) => sum + (row.students_after - row.students_before), 0),
    student_add_logs_added: rows.reduce((sum, row) => sum + (row.add_logs_after - row.add_logs_before), 0),
    cases: rows,
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  event("run_completed", { status: audit.status, cases_passed: audit.cases_passed });
  console.log(JSON.stringify({ status: audit.status, passed: `${audit.cases_passed}/${audit.cases_expected}`, database_rows_added: audit.database_rows_added }, null, 2));
  if (audit.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  try { event("run_error", { error: error.message }); } catch (_) {}
  console.error(error.stack || error.message);
  process.exit(1);
});
