#!/usr/bin/env node
"use strict";

// ===========================================================================
//  UJI VERIFIKASI SAAT RPC TIDAK TERSEDIA — FAIL-CLOSED LAPIS BLOCKCHAIN
// ===========================================================================
//
//  Subbab 2.2 menyatakan bahwa jalur RPC yang tidak tersedia menghasilkan
//  lapis blockchain "tidak terverifikasi" dan keputusan gabungan negatif,
//  tetapi tak satu pun dari 30 eksekusi pada berkas 11 memasuki jalur itu.
//  Skrip ini menguji jalur tersebut secara terkendali:
//
//      registri SIVIL POSITIF (aktif), rantai TIDAK TERVERIFIKASI karena RPC
//      tidak terjangkau  ->  keputusan gabungan wajib NEGATIF.
//
//  LETAK RPC. Portal SIVIL tidak memanggil RPC sendiri. VerifikasiController::
//  verifyBlockchain() meneruskan lapis blockchain ke endpoint SIAKAD
//  GET /api/verify-nina, dan endpoint itulah yang membaca kontrak memakai
//  process.env.POLYGON_RPC_URL milik kontainer SIAKAD. Variabel
//  POLYGON_RPC_URL pada kontainer SIVIL tidak dipakai oleh alur verifikasi.
//  Karena itu RPC yang dibuat tidak terjangkau adalah RPC milik jalur tersebut.
//
//  INJEKSI, cara (a): kontainer SIAKAD asli dihentikan (tidak dihapus), lalu
//  kontainer pengganti dijalankan dari image yang SAMA, dengan env, volume,
//  jaringan, alias "siakad", dan port yang SAMA; satu-satunya perbedaan adalah
//  POLYGON_RPC_URL=http://127.0.0.1:1 (koneksi ditolak). Setelah eksperimen,
//  kontainer pengganti dihapus dan kontainer asli dijalankan kembali, sehingga
//  konfigurasi yang dipulihkan identik byte-per-byte dengan sebelum uji.
//
//  Skrip ini TIDAK menerbitkan kredensial, TIDAK mencabut apa pun, TIDAK
//  mengunggah artefak, dan TIDAK mengirim transaksi. Tidak ada private key
//  yang dibaca. Nonce wallet penerbit dibaca sebelum dan sesudah sebagai bukti.
//
//  Variabel lingkungan:
//      MYSQL_PWD            WAJIB, kata sandi root MySQL (diteruskan ke
//                           docker exec lewat env, tidak lewat argv)
//      MYSQL_CONTAINER      bawaan ijazah-mysql
//      SIAKAD_CONTAINER     bawaan ijazah-siakad
//      SIVIL_URL            bawaan http://localhost:8001
//      SIAKAD_URL           bawaan http://localhost:3000
//      POLYGON_RPC_URL      RPC baca untuk prapemeriksaan (bawaan drpc publik)
//      RPC_UNAVAIL_CANDIDATES  daftar NIM, dipakai berurutan
//
//  Jalankan dari akar paket replikasi:
//      node 5_test_scripts/uji-rpc-unavailable.cjs
// ===========================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RUN = process.env.RPC_UNAVAIL_RUN || "rpc-unavailable-final";
const OUT = process.env.RPC_UNAVAIL_LOG_DIR || path.join(ROOT, "6_provenance", "raw", "10-rpc-unavailable");
const RESULTS = path.join(ROOT, "3_raw_measurements", "22_rpc_unavailable_final_5.csv");
const EVENTS = path.join(OUT, "events.ndjson");
const AUDIT = path.join(OUT, "audit.json");
const HTML_DIR = path.join(OUT, "portal-html");

const SIVIL = process.env.SIVIL_URL || "http://localhost:8001";
const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const MYSQL = process.env.MYSQL_CONTAINER || "ijazah-mysql";
const SIAKAD_CONTAINER = process.env.SIAKAD_CONTAINER || "ijazah-siakad";
const TEMP_CONTAINER = `${SIAKAD_CONTAINER}-rpcunavail`;
const UNREACHABLE_RPC = "http://127.0.0.1:1";
const INJECTION_METHOD = `a_unreachable_endpoint (SIAKAD /api/verify-nina POLYGON_RPC_URL=${UNREACHABLE_RPC})`;

const CONTRACT = "0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54";
const ISSUER = "0x80EBA46e25Ed50c09a20E90f7C398bf5aeAe3566";
const READ_RPCS = [process.env.POLYGON_RPC_URL || "https://polygon-amoy.drpc.org", "https://80002.rpc.thirdweb.com"];

// Kandidat: kredensial pertama yang belum pernah dipakai pada uji verifikasi,
// revoke, atau modifikasi (berkas 06-08, 11-16, 19-21) pada atau sesudah token
// 1040, 1080, 1120, 1160, 1200. Lima sisanya cadangan.
const CANDIDATES = (process.env.RPC_UNAVAIL_CANDIDATES
  || "20210040,20210080,20210120,20210160,20210200,20210041,20210081,20210121,20210161,20210199")
  .split(",").map((x) => x.trim()).filter(Boolean);
const TARGET = 5;

const HEADER = "run_id,scenario_id,domain,kelompok,timestamp_start,timestamp_end,latency_ms,status,expected,actual,http_status,error_message,nim,nina,student_name,reservation_id,cid,file_size_bytes,tx_hash,block_number,block_timestamp,token_id,gas_limit,gas_used,revert_reason,registry_status,blockchain_status,sia_status,mock_pisn_status,final_verification,verification_mode,notes,post_restore_verification,rpc_injection_method";
const EXPECTED = "tidak valid (blockchain tidak terverifikasi)";

// ---------------------------------------------------------------------------

if (!process.env.MYSQL_PWD) {
  console.error("MYSQL_PWD wajib diset (kata sandi root MySQL).");
  process.exit(2);
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function event(type, data = {}) {
  append(EVENTS, `${JSON.stringify({ timestamp: new Date().toISOString(), run: RUN, type, ...data })}\n`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function median(values) {
  const list = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function mysql(query) {
  return docker(["exec", "-e", "MYSQL_PWD", MYSQL, "mysql", "-u", "root", "-B", "-N", "-e", query]);
}

// ---------------------------------------------------------------------------
//  State basis data dan rantai (baca saja)
// ---------------------------------------------------------------------------

function snapshot(nim) {
  if (!/^\d{8}$/.test(nim)) throw new Error(`NIM tidak sah: ${nim}`);
  const line = mysql(`SELECT d.nina,d.token_id,d.status_blockchain,COALESCE(v.status,'MISSING'),COALESCE(v.nama_mahasiswa,'') FROM siakad_db.students s JOIN siakad_db.diplomas d ON d.student_id=s.id LEFT JOIN sivil_db.sivil_nina_registry v ON v.nina=d.nina WHERE s.nim='${nim}' LIMIT 1;`);
  if (!line) throw new Error(`Snapshot ${nim} tidak ditemukan`);
  const [nina, tokenId, siaDiploma, registry, name] = line.split("\t");
  return { nim, nina, token_id: Number(tokenId), sia_diploma: siaDiploma, registry_status: registry, name };
}

function bookkeeping() {
  const line = mysql("SELECT (SELECT COUNT(*) FROM siakad_db.students),(SELECT COUNT(*) FROM siakad_db.diplomas),(SELECT COUNT(*) FROM siakad_db.diplomas WHERE token_id BETWEEN 1001 AND 1200),(SELECT COUNT(*) FROM sivil_db.sivil_nina_registry WHERE status='aktif'),(SELECT COALESCE(MAX(id),0) FROM sivil_db.verifikasi_logs);");
  const [students, diplomas, tokens, registryActive, maxLog] = line.split("\t").map(Number);
  return { students, diplomas, tokens_1001_1200: tokens, sivil_registry_aktif: registryActive, verifikasi_logs_max_id: maxLog };
}

function verificationLog(nina, afterId) {
  const line = mysql(`SELECT id,sivil_valid,sivil_status,blockchain_valid,dual_verified,JSON_UNQUOTE(JSON_EXTRACT(blockchain_data,'$.message')) FROM sivil_db.verifikasi_logs WHERE nina='${nina}' AND id>${Number(afterId)} ORDER BY id DESC LIMIT 1;`);
  if (!line) return null;
  const [id, sivilValid, sivilStatus, blockchainValid, dualVerified, message] = line.split("\t");
  return {
    log_id: Number(id), sivil_valid: sivilValid === "1", sivil_status: sivilStatus,
    blockchain_valid: blockchainValid === "1", dual_verified: dualVerified === "1", blockchain_message: message,
  };
}

const ABI_READ = ["function getIjazahData(uint256) view returns(bytes32 hashedNina,bytes32 hashedNim,string cid,string encData,uint256 mintedAt,uint256 updatedAt,bool isActive,address mintedBy)"];

async function withReaders(label, fn) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const url = READ_RPCS[attempt % READ_RPCS.length];
    const provider = new ethers.JsonRpcProvider(url, 80002, { staticNetwork: true });
    try { return { value: await fn(provider), via: new URL(url).host }; } catch (error) {
      last = error;
      event("rpc_read_retry", { label, attempt: attempt + 1, via: new URL(url).host, error: error?.shortMessage || error?.message });
      await sleep(500 * (attempt + 1));
    } finally { provider.destroy(); }
  }
  throw last;
}

async function chainActive(tokenId) {
  const r = await withReaders(`getIjazahData(${tokenId})`, (p) => new ethers.Contract(CONTRACT, ABI_READ, p).getIjazahData(tokenId));
  return { is_active: r.value.isActive, via: r.via };
}

async function issuerNonce() {
  const r = await withReaders("getTransactionCount(issuer)", (p) => p.getTransactionCount(ISSUER, "latest"));
  return { nonce: r.value, via: r.via };
}

// ---------------------------------------------------------------------------
//  Portal SIVIL
// ---------------------------------------------------------------------------

// Token CSRF sesi dihapus dari salinan HTML yang disimpan; sisanya apa adanya.
function redactHtml(html) {
  return html
    .replace(/(name="csrf-token"\s+content=")[^"]*(")/g, "$1[REDACTED]$2")
    .replace(/(name="_token"\s+value=")[^"]*(")/g, "$1[REDACTED]$2");
}

async function verifySivil(nina, name, label) {
  const startedAt = Date.now();
  const response = await fetch(`${SIVIL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(name)}`, { headers: { "X-Test-Mode": "1" } });
  const html = await response.text();
  const endedAt = Date.now();
  fs.mkdirSync(HTML_DIR, { recursive: true });
  fs.writeFileSync(path.join(HTML_DIR, `${label}.html`), redactHtml(html));

  const valid = /const\s+isValid\s*=\s*(true|false)/.exec(html);
  const status = /const\s+sivilStatus\s*=\s*['"]([^'"]*)['"]/.exec(html);
  const bc = /const\s+blockchainData\s*=\s*(\{[^\n]*\});/.exec(html);
  if (!valid) throw new Error(`isValid tidak ditemukan untuk ${nina} (HTTP ${response.status})`);
  let blockchain = null;
  try { blockchain = bc ? JSON.parse(bc[1]) : null; } catch (_) { blockchain = null; }

  // Klasifikator mode identik dengan uji-matriks.cjs (sumber berkas 11), agar
  // kolom verification_mode dapat dibandingkan langsung.
  const modeFile11 = /luring|fallback|offline/i.test(html) ? "fallback" : "live";
  const offlineLabel = /offline\s+validation|validasi\s+luring|mode\s+luring|offline/i.test(html);

  return {
    started_at: startedAt, ended_at: endedAt, latency_ms: endedAt - startedAt,
    http_status: response.status, is_valid: valid[1] === "true", sivil_status: status?.[1] || "",
    blockchain, verification_mode: modeFile11, offline_label: offlineLabel,
  };
}

function blockchainStatus(bc) {
  if (!bc) return "tidak_ada_data";
  if (bc.valid === true && bc.is_active === true) return "aktif";
  if (bc.is_active === false) return "direvoke";
  if (bc.is_active === null || bc.is_active === undefined) return "tidak_terverifikasi";
  return "tidak_valid";
}

function decision(v) {
  if (v.is_valid) return "valid";
  if (v.sivil_status === "revoked") return "tidak valid (registri revoked)";
  const bc = blockchainStatus(v.blockchain);
  if (bc === "tidak_terverifikasi") return "tidak valid (blockchain tidak terverifikasi)";
  if (bc === "direvoke") return "tidak valid (token revoked)";
  return `tidak valid (${v.sivil_status || "registri tidak ditemukan"})`;
}

// ---------------------------------------------------------------------------
//  Injeksi dan pemulihan kontainer SIAKAD
// ---------------------------------------------------------------------------

function inspectSiakad() {
  const info = JSON.parse(docker(["inspect", SIAKAD_CONTAINER]))[0];
  const networks = Object.entries(info.NetworkSettings.Networks);
  if (networks.length !== 1) throw new Error("Kontainer SIAKAD diharapkan berada pada tepat satu jaringan");
  return {
    image: info.Image,
    env: info.Config.Env,
    network: networks[0][0],
    aliases: (networks[0][1].Aliases || []).filter((a) => a !== SIAKAD_CONTAINER),
    mounts: info.Mounts.filter((m) => m.Type === "volume").map((m) => `${m.Name}:${m.Destination}`),
    config_hash: info.Config.Labels["com.docker.compose.config-hash"],
    running: info.State.Running,
  };
}

async function waitSiakad(nina, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SIAKAD}/api/verify-nina?nina=${encodeURIComponent(nina)}`);
      if (res.status < 500) return res.json();
    } catch (_) { /* belum siap */ }
    await sleep(1000);
  }
  throw new Error("SIAKAD tidak siap dalam batas waktu");
}

function containerRpcUrl(name) {
  return docker(["exec", name, "printenv", "POLYGON_RPC_URL"]);
}

function startInjected(original) {
  // Env ditulis ke berkas sementara ber-mode 0600 dan dihapus segera sesudah
  // kontainer dibuat. Nilainya tidak pernah dicetak atau dicatat.
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpcunavail-")), "env");
  const env = original.env.map((line) => (line.startsWith("POLYGON_RPC_URL=") ? `POLYGON_RPC_URL=${UNREACHABLE_RPC}` : line));
  fs.writeFileSync(envFile, `${env.join("\n")}\n`, { mode: 0o600 });
  try {
    docker(["stop", SIAKAD_CONTAINER]);
    const args = ["run", "-d", "--name", TEMP_CONTAINER, "--restart", "no", "--env-file", envFile,
      "--network", original.network, "-p", "3000:3000"];
    for (const alias of original.aliases) args.push("--network-alias", alias);
    for (const mount of original.mounts) args.push("-v", mount);
    args.push(original.image);
    docker(args);
  } finally {
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  }
}

function restoreOriginal() {
  try {
    const logs = spawnSync("docker", ["logs", TEMP_CONTAINER], { encoding: "utf8" });
    if (logs.status === 0) fs.writeFileSync(path.join(OUT, "siakad-injected-container.log"), `${logs.stdout}${logs.stderr}`);
  } catch (_) { /* kontainer mungkin belum sempat dibuat */ }
  try { docker(["rm", "-f", TEMP_CONTAINER]); } catch (_) { /* tidak ada */ }
  docker(["start", SIAKAD_CONTAINER]);
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (fs.existsSync(RESULTS)) throw new Error(`${path.relative(ROOT, RESULTS)} sudah ada; hapus secara sadar sebelum menjalankan ulang`);

  const original = inspectSiakad();
  if (!original.running) throw new Error("Kontainer SIAKAD asli tidak berjalan");
  const rpcBefore = containerRpcUrl(SIAKAD_CONTAINER);
  const bookBefore = bookkeeping();
  const nonceBefore = await issuerNonce();
  event("run_started", {
    injection_method: INJECTION_METHOD, siakad_rpc_before: rpcBefore, siakad_config_hash: original.config_hash,
    siakad_image: original.image, bookkeeping_before: bookBefore, issuer_nonce_before: nonceBefore,
  });

  // === 1. Prapemeriksaan: aktif di KEDUA lapis ===
  const selected = [];
  for (const nim of CANDIDATES) {
    if (selected.length >= TARGET) break;
    const state = snapshot(nim);
    const chain = await chainActive(state.token_id);
    const live = await (await fetch(`${SIAKAD}/api/verify-nina?nina=${encodeURIComponent(state.nina)}`)).json();
    const eligible = state.registry_status === "aktif" && chain.is_active === true && live.valid === true && live.is_active === true;
    event("candidate_screened", { ...state, chain_active: chain.is_active, chain_read_via: chain.via, siakad_live_valid: live.valid, siakad_live_is_active: live.is_active, eligible });
    if (eligible) selected.push(state);
  }
  if (selected.length < TARGET) throw new Error(`Hanya ${selected.length} kandidat aktif di kedua lapis`);

  // === 2. Injeksi ===
  const rows = [];
  let injectionError = null;
  let restored = false;
  try {
    startInjected(original);
    const probe = await waitSiakad(selected[0].nina);
    const rpcInjected = containerRpcUrl(TEMP_CONTAINER);
    event("injection_applied", {
      temp_container: TEMP_CONTAINER, siakad_rpc_injected: rpcInjected,
      direct_probe: { valid: probe.valid, is_active: probe.is_active, verification_mode: probe.verification_mode ?? null, message: probe.message },
    });
    if (rpcInjected !== UNREACHABLE_RPC || probe.verification_mode !== "fallback") {
      throw new Error(`Injeksi tidak terkonfirmasi: rpc=${rpcInjected} mode=${probe.verification_mode}`);
    }

    // === 3. Verifikasi dua lapis melalui portal SIVIL ===
    for (let i = 0; i < selected.length; i += 1) {
      const target = selected[i];
      const caseId = `RPC-UNAVAIL-${i + 1}`;
      const maxLogBefore = bookkeeping().verifikasi_logs_max_id;
      const v = await verifySivil(target.nina, target.name, caseId);
      const registryAfter = snapshot(target.nim).registry_status;
      const log = verificationLog(target.nina, maxLogBefore);
      const bcStatus = blockchainStatus(v.blockchain);
      const final = decision(v);
      const contrast = log && log.sivil_valid === true && log.blockchain_valid === false && log.dual_verified === false;
      const pass = v.is_valid === false && registryAfter === "aktif" && v.sivil_status === "found"
        && bcStatus === "tidak_terverifikasi" && contrast === true;
      event("verification_injected", { case_id: caseId, nim: target.nim, token_id: target.token_id, http_status: v.http_status, latency_ms: v.latency_ms, is_valid: v.is_valid, sivil_status: v.sivil_status, registry_status: registryAfter, blockchain: v.blockchain, verification_mode_file11_classifier: v.verification_mode, offline_label_in_html: v.offline_label, log });
      rows.push({
        target, caseId, v, registryAfter, log, bcStatus, final, pass,
      });
    }
  } catch (error) {
    injectionError = error;
    event("run_error", { phase: "injection", error: error.message });
  } finally {
    // === 4. Pemulihan: kontainer asli dijalankan kembali ===
    restoreOriginal();
    await waitSiakad(selected[0].nina);
    const after = inspectSiakad();
    const rpcAfter = containerRpcUrl(SIAKAD_CONTAINER);
    restored = rpcAfter === rpcBefore && after.config_hash === original.config_hash && after.image === original.image;
    event("restored", { siakad_rpc_after: rpcAfter, config_hash_after: after.config_hash, identical_to_before: restored });
  }
  if (injectionError) throw injectionError;
  if (!restored) throw new Error("Konfigurasi SIAKAD tidak kembali identik; post_restore tidak dijalankan");

  // === 5. Verifikasi ulang sesudah pemulihan ===
  for (const row of rows) {
    const maxLogBefore = bookkeeping().verifikasi_logs_max_id;
    const v = await verifySivil(row.target.nina, row.target.name, `${row.caseId}-post-restore`);
    row.post = { final: decision(v), log: verificationLog(row.target.nina, maxLogBefore), latency_ms: v.latency_ms, bc: blockchainStatus(v.blockchain) };
    event("verification_post_restore", { case_id: row.caseId, final: row.post.final, blockchain_status: row.post.bc, latency_ms: v.latency_ms, log: row.post.log });
  }

  // === 6. Pembukuan dan bukti tanpa transaksi ===
  const bookAfter = bookkeeping();
  const nonceAfter = await issuerNonce();
  const chainAfter = [];
  for (const row of rows) chainAfter.push({ token_id: row.target.token_id, ...(await chainActive(row.target.token_id)) });

  fs.writeFileSync(RESULTS, `${HEADER}\n`);
  rows.forEach((row, i) => {
    const { target, v, log } = row;
    const notes = [
      `run=${RUN}`,
      `sivilStatus=${v.sivil_status}`,
      `verifikasi_logs.id=${log?.log_id}; sivil_valid=${log ? Number(log.sivil_valid) : ""}; blockchain_valid=${log ? Number(log.blockchain_valid) : ""}; dual_verified=${log ? Number(log.dual_verified) : ""}`,
      `blockchain_is_active=${v.blockchain?.is_active ?? null}`,
      `portal_offline_label=${v.offline_label}`,
      "verification_mode dihitung dengan klasifikator berkas 11 (regex luring|fallback|offline pada HTML)",
      "SIAKAD /api/verify-nina mengembalikan verification_mode=fallback tetapi SIVIL tidak meneruskan medan itu",
      `post_restore_log_id=${row.post.log?.log_id}; post_restore_dual_verified=${row.post.log ? Number(row.post.log.dual_verified) : ""}`,
    ].join("; ");
    const record = {
      run_id: i + 1, scenario_id: row.caseId, domain: "verifikasi", kelompok: "rpc_tidak_tersedia",
      timestamp_start: new Date(v.started_at).toISOString(), timestamp_end: new Date(v.ended_at).toISOString(),
      latency_ms: v.latency_ms, status: row.pass ? "pass" : "fail", expected: EXPECTED, actual: row.final,
      http_status: v.http_status, error_message: v.blockchain?.message ?? "", nim: target.nim, nina: target.nina,
      token_id: target.token_id, registry_status: row.registryAfter, blockchain_status: row.bcStatus,
      final_verification: row.final, verification_mode: v.verification_mode, notes,
      post_restore_verification: row.post.final, rpc_injection_method: INJECTION_METHOD,
    };
    append(RESULTS, `${HEADER.split(",").map((key) => csv(record[key])).join(",")}\n`);
  });

  const latencies = rows.map((r) => r.v.latency_ms);
  const audit = {
    run: RUN, injection_method: INJECTION_METHOD,
    siakad: { rpc_before: rpcBefore, rpc_injected: UNREACHABLE_RPC, config_hash: original.config_hash, restored_identical: restored },
    cases: rows.length,
    final_negative: rows.filter((r) => r.v.is_valid === false).length,
    registry_aktif: rows.filter((r) => r.registryAfter === "aktif").length,
    blockchain_tidak_terverifikasi: rows.filter((r) => r.bcStatus === "tidak_terverifikasi").length,
    log_contrast: rows.filter((r) => r.log?.sivil_valid && !r.log?.blockchain_valid && !r.log?.dual_verified).length,
    verification_mode_values: [...new Set(rows.map((r) => r.v.verification_mode))],
    portal_offline_label: rows.filter((r) => r.v.offline_label).length,
    latency_ms: { median: median(latencies), min: Math.min(...latencies), max: Math.max(...latencies) },
    post_restore_valid: rows.filter((r) => r.post.final === "valid").length,
    bookkeeping_before: bookBefore, bookkeeping_after: bookAfter,
    issuer_nonce_before: nonceBefore, issuer_nonce_after: nonceAfter,
    no_transactions: nonceBefore.nonce === nonceAfter.nonce,
    chain_after: chainAfter,
    pass: rows.filter((r) => r.pass).length,
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  event("run_completed", { pass: audit.pass, cases: audit.cases });
  console.log(JSON.stringify(audit, null, 2));
}

main().catch((error) => {
  try { event("run_error", { error: error.message }); } catch (_) {}
  console.error(error.message);
  process.exit(1);
});
