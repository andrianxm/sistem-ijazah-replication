#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.TAMPER_ENV || path.join(ROOT, "sia-simulasi", ".env");
const RUN_ID = process.env.TAMPER_RUN || "modifikasi-artefak-final-6-20260809";
const RUN_DIR = process.env.TAMPER_LOG_DIR || path.join(__dirname, "pengujian-final", RUN_ID);
const EVENTS = path.join(RUN_DIR, "events.ndjson");
const RESULTS = path.join(RUN_DIR, "results.csv");
const CHECKPOINT = path.join(RUN_DIR, "checkpoint.json");
const AUDIT = path.join(RUN_DIR, "audit.json");

const SOURCES = [
  {
    group: "single", nim: "20210001", tokenId: 1001,
    pdf: "bafybeib63t4cgtyjbrefljkm5flg62hujqc3m6eskrcbc4zdrh647kjqnq",
    metadata: "bafkreiexj23jwhqapalnjiyxzrr4myw2pdkjumtxm4rks52ksxsjw3zqba",
  },
  {
    group: "batch5", nim: "20210031", tokenId: 1031,
    pdf: "bafybeigj47sirx2loi446inbubjw7r2sdiowold4z3ue7rfd6luyjkk35a",
    metadata: "bafkreiacr3qaevohkrjjovawq54y3dty233qj4unjsewf6xh36brlg7o5y",
  },
  {
    group: "batch50", nim: "20210151", tokenId: 1151,
    pdf: "bafybeig36oibbjq54kipxyjxtfsm44m5nj47yormkzvedjvnru67nc2nwu",
    metadata: "bafkreig6quddzckwkqa27h5a7vhocibxrvvhnlymhwljb7pq4vray7z64i",
  },
];

const CASES = SOURCES.flatMap((source) => ["pdf", "metadata"].map((type) => ({
  id: `TAMPER-${source.group.toUpperCase()}-${type.toUpperCase()}`,
  group: source.group,
  nim: source.nim,
  tokenId: source.tokenId,
  type,
  sourceCid: source[type],
  onchainCid: source.metadata,
})));

const ABI = [
  "function getNextTokenId() view returns(uint256)",
  "function getIjazahData(uint256) view returns(bytes32,bytes32,string cid,string,uint256,uint256,bool isActive,address)",
];

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function append(file, text) {
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function event(type, data = {}) {
  append(EVENTS, `${JSON.stringify({ timestamp: new Date().toISOString(), run: RUN_ID, type, ...data })}\n`);
}

function saveCheckpoint(data) {
  const tmp = `${CHECKPOINT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, CHECKPOINT);
}

function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tamperBase64Text(buffer) {
  const text = buffer.toString("utf8");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text) || text.length < 80) throw new Error("Artefak sumber bukan payload base64 terenkripsi yang diharapkan");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let index = Math.floor(text.length / 2);
  while (index < text.length && !alphabet.includes(text[index])) index++;
  if (index >= text.length) throw new Error("Tidak menemukan byte base64 yang dapat dimodifikasi");
  const oldChar = text[index];
  const newChar = alphabet[(alphabet.indexOf(oldChar) + 1) % alphabet.length];
  return { buffer: Buffer.from(text.slice(0, index) + newChar + text.slice(index + 1), "utf8"), offset: index, oldChar, newChar };
}

function decryptPayload(payload, keyString, cipherName) {
  try {
    const combined = Buffer.from(payload.toString("utf8"), "base64");
    const iv = combined.subarray(0, 16);
    const encryptedBase64 = combined.subarray(16).toString("utf8");
    const key = Buffer.from(keyString.padEnd(32, "0").slice(0, 32), "utf8");
    const decipher = crypto.createDecipheriv(cipherName, key, iv);
    return Buffer.concat([decipher.update(encryptedBase64, "base64"), decipher.final()]);
  } catch (_) {
    return null;
  }
}

async function fetchBuffer(url, attempts = 1) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error("respons kosong");
      return buffer;
    } catch (error) {
      last = error;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw last;
}

async function uploadTampered(buffer, filename, metadata, jwt) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("pinataMetadata", JSON.stringify({ name: filename, keyvalues: metadata }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload Pinata gagal HTTP ${response.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!json.IpfsHash) throw new Error("Pinata tidak mengembalikan IpfsHash");
  return json.IpfsHash;
}

function detect(type, originalPlain, tamperedPlain) {
  if (!tamperedPlain) return "decryption_failed";
  if (sha256(originalPlain) !== sha256(tamperedPlain)) {
    if (type === "metadata") {
      try { JSON.parse(tamperedPlain.toString("utf8")); }
      catch (_) { return "json_parse_failed"; }
    }
    if (type === "pdf" && tamperedPlain.subarray(0, 4).toString() !== "%PDF") return "pdf_signature_invalid";
    return "plaintext_hash_mismatch";
  }
  return "not_detected";
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS)) {
    append(RESULTS, "case_id,group,nim,token_id,artifact_type,source_cid,tampered_cid,source_cipher_sha256,tampered_cipher_sha256,source_plain_sha256,tampered_plain_sha256,tamper_offset,detection,status,gateway_http_status,pin_added,latency_ms,notes\n");
  }
  const checkpoint = fs.existsSync(CHECKPOINT)
    ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"))
    : { schema_version: 1, run: RUN_ID, created_at: new Date().toISOString(), cases: {} };

  loadEnv();
  const gateway = (process.env.PINATA_GATEWAY || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const jwt = process.env.PINATA_JWT;
  const key = process.env.IPFS_ENCRYPTION_KEY || "your-32-byte-encryption-key-here";
  const cipher = process.env.IPFS_ENCRYPTION_CIPHER || "aes-256-cbc";
  const rpc = process.env.POLYGON_RPC_URL;
  const address = process.env.CONTRACT_ADDRESS_IJAZAH;
  if (!gateway || !jwt || !rpc || !address) throw new Error("Gateway, JWT Pinata, RPC, atau alamat kontrak belum tersedia");
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(address, ABI, provider);
  const nextBeforeRun = Number(await contract.getNextTokenId());
  event("run_started", { cases: CASES.length, gateway, contract: address, next_token_id: nextBeforeRun });

  const verified = [];
  for (const test of CASES) {
    if (checkpoint.cases[test.id]?.phase === "verified") {
      verified.push(checkpoint.cases[test.id]);
      console.log(`${test.id}: sudah verified, dilewati`);
      continue;
    }
    const started = Date.now();
    const chain = await contract.getIjazahData(test.tokenId);
    if (!chain.isActive || chain.cid !== test.onchainCid) throw new Error(`${test.id}: token sumber atau CID on-chain tidak sesuai snapshot`);

    const source = await fetchBuffer(`https://${gateway}/ipfs/${test.sourceCid}`, 3);
    const originalPlain = decryptPayload(source, key, cipher);
    if (!originalPlain) throw new Error(`${test.id}: artefak asli gagal didekripsi`);
    if (test.type === "metadata") JSON.parse(originalPlain.toString("utf8"));
    if (test.type === "pdf" && originalPlain.subarray(0, 4).toString() !== "%PDF") throw new Error(`${test.id}: artefak asli bukan PDF`);

    const changed = tamperBase64Text(source);
    if (sha256(source) === sha256(changed.buffer)) throw new Error(`${test.id}: modifikasi tidak mengubah hash ciphertext`);
    let tamperedCid = checkpoint.cases[test.id]?.tampered_cid || "";
    if (!tamperedCid) {
      tamperedCid = await uploadTampered(
        changed.buffer,
        `${test.id.toLowerCase()}-${test.nim}.enc`,
        { experiment: RUN_ID, case_id: test.id, source_cid: test.sourceCid, artifact_type: test.type },
        jwt,
      );
      checkpoint.cases[test.id] = { phase: "uploaded", tampered_cid: tamperedCid, uploaded_at: new Date().toISOString() };
      saveCheckpoint(checkpoint);
      event("tampered_artifact_uploaded", { case_id: test.id, source_cid: test.sourceCid, tampered_cid: tamperedCid });
    }
    if (tamperedCid === test.sourceCid) throw new Error(`${test.id}: CID termodifikasi sama dengan CID sumber`);
    const downloaded = await fetchBuffer(`https://${gateway}/ipfs/${tamperedCid}`, 12);
    if (!downloaded.equals(changed.buffer)) throw new Error(`${test.id}: isi gateway tidak sama dengan payload termodifikasi`);
    const tamperedPlain = decryptPayload(downloaded, key, cipher);
    const detection = detect(test.type, originalPlain, tamperedPlain);
    if (detection === "not_detected") throw new Error(`${test.id}: modifikasi tidak terdeteksi`);
    const nextAfter = Number(await contract.getNextTokenId());
    const chainAfter = await contract.getIjazahData(test.tokenId);
    if (nextAfter !== nextBeforeRun || chainAfter.cid !== test.onchainCid || !chainAfter.isActive) {
      throw new Error(`${test.id}: state blockchain berubah selama uji artefak`);
    }

    const row = {
      phase: "verified", case_id: test.id, group: test.group, nim: test.nim, token_id: test.tokenId,
      artifact_type: test.type, source_cid: test.sourceCid, tampered_cid: tamperedCid,
      source_cipher_sha256: sha256(source), tampered_cipher_sha256: sha256(downloaded),
      source_plain_sha256: sha256(originalPlain), tampered_plain_sha256: tamperedPlain ? sha256(tamperedPlain) : "",
      tamper_offset: changed.offset, detection, status: "pass", gateway_http_status: 200,
      pin_added: 1, latency_ms: Date.now() - started,
      notes: "salinan terenkripsi dimodifikasi; CID asli database dan blockchain tidak diubah",
      verified_at: new Date().toISOString(),
    };
    checkpoint.cases[test.id] = row;
    saveCheckpoint(checkpoint);
    append(RESULTS, [
      row.case_id, row.group, row.nim, row.token_id, row.artifact_type, row.source_cid, row.tampered_cid,
      row.source_cipher_sha256, row.tampered_cipher_sha256, row.source_plain_sha256, row.tampered_plain_sha256,
      row.tamper_offset, row.detection, row.status, row.gateway_http_status, row.pin_added, row.latency_ms, row.notes,
    ].map(csv).join(",") + "\n");
    event("case_verified", { case_id: test.id, tampered_cid: tamperedCid, detection, latency_ms: row.latency_ms });
    verified.push(row);
    console.log(`${test.id}: pass — ${detection} — ${tamperedCid}`);
  }

  const nextAfterRun = Number(await contract.getNextTokenId());
  const audit = {
    schema_version: 1,
    run: RUN_ID,
    recorded_at: new Date().toISOString(),
    status: verified.length === CASES.length ? "pass" : "incomplete",
    cases_expected: CASES.length,
    cases_passed: verified.filter((x) => x.status === "pass").length,
    pins_added: verified.reduce((sum, x) => sum + Number(x.pin_added || 0), 0),
    next_token_before: nextBeforeRun,
    next_token_after: nextAfterRun,
    database_or_blockchain_cid_updated: false,
    cases: verified,
  };
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  event("run_finished", { status: audit.status, cases_passed: audit.cases_passed, pins_added: audit.pins_added, next_token_id: nextAfterRun });
  console.log(`Selesai. pass=${audit.cases_passed}/${audit.cases_expected}, pin=${audit.pins_added}, nextTokenId=${nextAfterRun}`);
}

main().catch((error) => {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); event("run_failed", { error: error?.message || String(error) }); } catch (_) {}
  console.error(error?.message || String(error));
  process.exit(1);
});
