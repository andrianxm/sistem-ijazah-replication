#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.DUP_NINA_ENV || path.join(ROOT, "sia-simulasi", ".env");
const RUN_ID = process.env.DUP_NINA_RUN || "duplikat-nina-final-2-20260809";
const RUN_DIR = process.env.DUP_NINA_LOG_DIR || path.join(__dirname, "pengujian-final", RUN_ID);
const EVENTS = path.join(RUN_DIR, "events.ndjson");
const RESULTS = path.join(RUN_DIR, "results.csv");
const CHECKPOINT = path.join(RUN_DIR, "checkpoint.json");

const CASES = [
  { id: "DUP-NINA-1", nim: "20210211", nina: "040410582605000", sourceTokenId: 1001 },
  { id: "DUP-NINA-2", nim: "20210212", nina: "040410582605030", sourceTokenId: 1031 },
];

const ABI = [
  "function mintIjazah(bytes32 hashedNina,bytes32 hashedNim,string cid,string encData) returns(uint256)",
  "function getNextTokenId() view returns(uint256)",
  "function getTokenIdByHashedNina(bytes32) view returns(uint256)",
  "function getIjazahData(uint256) view returns(bytes32 hashedNina,bytes32 hashedNim,string cid,string encData,uint256 mintedAt,uint256 updatedAt,bool isActive,address mintedBy)",
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

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function errorReason(error) {
  return error?.revert?.args?.[0] || error?.reason || error?.shortMessage || error?.message || String(error);
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS)) {
    append(RESULTS, "case_id,nim,duplicate_nina,source_token_id,expected,actual,status,revert_reason,tx_hash,receipt_status,gas_used,block_number,next_token_before,next_token_after,pin_added,notes\n");
  }
  const checkpoint = fs.existsSync(CHECKPOINT)
    ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"))
    : { schema_version: 1, run: RUN_ID, created_at: new Date().toISOString(), cases: {} };

  loadEnv();
  const rpc = process.env.POLYGON_RPC_URL;
  const privateKey = process.env.REKTOR_PRIVATE_KEY;
  const address = process.env.CONTRACT_ADDRESS_IJAZAH;
  if (!rpc || !privateKey || !address) throw new Error("POLYGON_RPC_URL, REKTOR_PRIVATE_KEY, dan CONTRACT_ADDRESS_IJAZAH wajib tersedia");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(address, ABI, wallet);
  const network = await provider.getNetwork();
  if (network.chainId !== 80002n) throw new Error(`Chain salah: ${network.chainId}`);
  event("run_started", { contract: address, wallet: wallet.address, chain_id: network.chainId.toString() });

  for (const test of CASES) {
    if (checkpoint.cases[test.id]?.phase === "verified") {
      console.log(`${test.id}: sudah verified, dilewati`);
      continue;
    }
    const hashedNina = ethers.keccak256(ethers.toUtf8Bytes(test.nina));
    const hashedNim = ethers.keccak256(ethers.toUtf8Bytes(test.nim));
    const mapped = Number(await contract.getTokenIdByHashedNina(hashedNina));
    if (mapped !== test.sourceTokenId) throw new Error(`${test.id}: NINA memetakan token ${mapped}, bukan ${test.sourceTokenId}`);
    const source = await contract.getIjazahData(mapped);
    if (!source.isActive || !source.cid) throw new Error(`${test.id}: token sumber tidak aktif atau CID kosong`);
    const nextBefore = Number(await contract.getNextTokenId());

    let expectedReason = "";
    try {
      await contract.mintIjazah.staticCall(hashedNina, hashedNim, source.cid, "");
      throw new Error(`${test.id}: staticCall tidak ditolak`);
    } catch (error) {
      expectedReason = errorReason(error);
      if (!/NINA ini sudah memiliki ijazah aktif/i.test(expectedReason)) throw error;
    }
    event("preflight_revert_confirmed", { case_id: test.id, nim: test.nim, nina: test.nina, reason: expectedReason, next_token_id: nextBefore });

    let txHash = checkpoint.cases[test.id]?.tx_hash || "";
    let receipt = txHash ? await provider.getTransactionReceipt(txHash) : null;
    if (!txHash) {
      const tx = await contract.mintIjazah(hashedNina, hashedNim, source.cid, "", { gasLimit: 500000n });
      txHash = tx.hash;
      checkpoint.cases[test.id] = { phase: "submitted", tx_hash: txHash, submitted_at: new Date().toISOString() };
      saveCheckpoint(checkpoint);
      event("transaction_submitted", { case_id: test.id, tx_hash: txHash, nonce: tx.nonce });
      try { receipt = await tx.wait(1, 180000); }
      catch (error) { receipt = error?.receipt || await provider.getTransactionReceipt(txHash); }
    }
    if (!receipt) throw new Error(`${test.id}: receipt belum tersedia; jalankan ulang dengan run yang sama`);
    if (Number(receipt.status) !== 0) throw new Error(`${test.id}: transaksi justru berhasil, status ${receipt.status}`);

    const nextAfter = Number(await contract.getNextTokenId());
    const mappedAfter = Number(await contract.getTokenIdByHashedNina(hashedNina));
    const sourceAfter = await contract.getIjazahData(mappedAfter);
    if (nextAfter !== nextBefore || mappedAfter !== mapped || !sourceAfter.isActive || sourceAfter.cid !== source.cid) {
      throw new Error(`${test.id}: state berubah setelah transaksi revert`);
    }

    checkpoint.cases[test.id] = {
      phase: "verified", tx_hash: txHash, receipt_status: Number(receipt.status),
      gas_used: receipt.gasUsed.toString(), block_number: receipt.blockNumber,
      revert_reason: expectedReason, verified_at: new Date().toISOString(),
    };
    saveCheckpoint(checkpoint);
    append(RESULTS, [
      test.id, test.nim, test.nina, mapped, "transaksi direvert; token dan pin tidak bertambah",
      "receipt status 0; state kontrak tetap", "pass", expectedReason, txHash,
      receipt.status, receipt.gasUsed, receipt.blockNumber, nextBefore, nextAfter, 0,
      "transaksi nyata; CID sumber aktif dipakai ulang tanpa unggahan IPFS",
    ].map(csv).join(",") + "\n");
    event("case_verified", { case_id: test.id, tx_hash: txHash, gas_used: receipt.gasUsed.toString(), next_token_id: nextAfter });
    console.log(`${test.id}: pass — ${txHash} (gas ${receipt.gasUsed})`);
  }

  const next = Number(await contract.getNextTokenId());
  event("run_finished", { passed: CASES.filter((x) => checkpoint.cases[x.id]?.phase === "verified").length, next_token_id: next });
  console.log(`Selesai. nextTokenId=${next}`);
}

main().catch((error) => {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); event("run_failed", { error: errorReason(error) }); } catch (_) {}
  console.error(errorReason(error));
  process.exit(1);
});
