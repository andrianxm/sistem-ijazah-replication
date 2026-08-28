#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.SC_NEGATIVE_ENV || path.join(ROOT, "sia-simulasi", ".env");
const RUN_ID = process.env.SC_NEGATIVE_RUN || "smart-contract-negative-final-20260810";
const RUN_DIR = process.env.SC_NEGATIVE_LOG_DIR || path.join(__dirname, "pengujian-final", RUN_ID);
const EVENTS = path.join(RUN_DIR, "events.ndjson");
const RESULTS = path.join(RUN_DIR, "results.csv");
const CHECKPOINT = path.join(RUN_DIR, "checkpoint.json");
const RUN_META = path.join(RUN_DIR, "run.json");
const AUDIT = path.join(RUN_DIR, "audit.json");
const RECEIPTS = path.join(RUN_DIR, "receipts");
const EXPECTED_UNAUTHORIZED = "0x2C9B3d6b80E463EEC0d0E5dFD4741A3B2C1B1503";
const TRANSFER_TOKEN_ID = 1002;
const RESULT_HEADERS = [
  "run", "attempt", "scenario_id", "timestamp_start", "timestamp_end", "latency_ms",
  "status", "expected", "actual", "sender", "contract_address", "token_id", "tx_hash",
  "receipt_status", "gas_limit", "gas_used", "block_number", "block_timestamp",
  "revert_name", "revert_reason", "required_role", "sender_has_required_role",
  "next_token_before", "next_token_after", "owner_before", "owner_after",
  "active_before", "active_after", "balance_before_wei", "balance_after_wei",
  "pin_added", "state_unchanged", "notes",
];

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) throw new Error(`Env tidak ditemukan: ${ENV_FILE}`);
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function normalizedKey(value) {
  const raw = String(value || "").trim();
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Format private key tidak valid");
  return key;
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, bigintReplacer, 2)}\n`);
  fs.renameSync(temp, file);
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function event(type, data = {}) {
  append(EVENTS, `${JSON.stringify({ timestamp: new Date().toISOString(), run: RUN_ID, type, ...data }, bigintReplacer)}\n`);
}

function csv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendResult(row) {
  if (!fs.existsSync(RESULTS)) append(RESULTS, `${RESULT_HEADERS.join(",")}\n`);
  append(RESULTS, `${RESULT_HEADERS.map((key) => csv(row[key])).join(",")}\n`);
}

function errorData(error) {
  return error?.data || error?.info?.error?.data || error?.error?.data || error?.revert?.data || null;
}

async function expectedRevert(provider, iface, request) {
  try {
    await provider.call(request);
    throw new Error("eth_call tidak direvert");
  } catch (error) {
    const data = errorData(error);
    let parsed = null;
    if (data) {
      try { parsed = iface.parseError(data); } catch (_) { /* gunakan pesan fallback */ }
    }
    return {
      name: parsed?.name || "UnknownRevert",
      args: parsed ? Array.from(parsed.args, (value) => value.toString()) : [],
      reason: parsed?.name === "Error" ? String(parsed.args[0]) : (parsed?.name || error.shortMessage || error.message),
      data,
    };
  }
}

async function obtainReceipt(provider, checkpointCase, signer, request, scenarioId, gasLimit) {
  let hash = checkpointCase?.tx_hash || "";
  let tx = null;
  let receipt = hash ? await provider.getTransactionReceipt(hash) : null;
  if (!hash) {
    tx = await signer.sendTransaction({ ...request, gasLimit });
    hash = tx.hash;
    return { hash, tx, receipt: null, submitted: true };
  }
  if (!receipt) tx = await provider.getTransaction(hash);
  if (!receipt && !tx) throw new Error(`${scenarioId}: transaksi ${hash} tidak ditemukan`);
  return { hash, tx, receipt, submitted: false };
}

async function waitForRevertedReceipt(provider, tx, hash, existingReceipt) {
  if (existingReceipt) return existingReceipt;
  let receipt = null;
  try { receipt = await tx.wait(1, 180000); }
  catch (error) { receipt = error?.receipt || await provider.getTransactionReceipt(hash); }
  if (!receipt) throw new Error(`Receipt ${hash} belum tersedia; jalankan ulang dengan run yang sama`);
  return receipt;
}

async function main() {
  fs.mkdirSync(RECEIPTS, { recursive: true });
  loadEnv();
  const rpc = process.env.POLYGON_RPC_URL;
  const contractAddress = process.env.CONTRACT_ADDRESS_IJAZAH || process.env.CONTRACT_ADDRESS;
  if (!rpc || !contractAddress || !process.env.REKTOR_PRIVATE_KEY || !process.env.UNAUTHORIZED_PRIVATE_KEY) {
    throw new Error("POLYGON_RPC_URL, CONTRACT_ADDRESS_IJAZAH, REKTOR_PRIVATE_KEY, dan UNAUTHORIZED_PRIVATE_KEY wajib tersedia");
  }

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const rektor = new ethers.Wallet(normalizedKey(process.env.REKTOR_PRIVATE_KEY), provider);
  const unauthorized = new ethers.Wallet(normalizedKey(process.env.UNAUTHORIZED_PRIVATE_KEY), provider);
  if (unauthorized.address.toLowerCase() !== EXPECTED_UNAUTHORIZED.toLowerCase()) {
    throw new Error(`Wallet tanpa role tidak cocok: ${unauthorized.address}`);
  }
  const artifact = require(path.join(ROOT, "sia-simulasi", "IjazahNFT.json"));
  const iface = new ethers.Interface(artifact.abi);
  const contract = new ethers.Contract(contractAddress, artifact.abi, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== 80002n) throw new Error(`Chain salah: ${network.chainId}`);
  const requiredRole = await contract.REKTOR_ROLE();
  const unauthorizedHasRole = await contract.hasRole(requiredRole, unauthorized.address);
  const rektorHasRole = await contract.hasRole(requiredRole, rektor.address);
  if (unauthorizedHasRole) throw new Error("Wallet uji ternyata memiliki REKTOR_ROLE");
  if (!rektorHasRole) throw new Error("Wallet rektor tidak memiliki REKTOR_ROLE");

  const checkpoint = fs.existsSync(CHECKPOINT)
    ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"))
    : { schema_version: 1, run: RUN_ID, created_at: new Date().toISOString(), cases: {} };
  if (!fs.existsSync(RUN_META)) {
    atomicJson(RUN_META, {
      schema_version: 1, run: RUN_ID, created_at: new Date().toISOString(), chain_id: "80002",
      contract_address: contractAddress, rektor_wallet: rektor.address,
      unauthorized_wallet: unauthorized.address, required_role: requiredRole,
      transfer_token_id: TRANSFER_TOKEN_ID, expected_transactions: 2,
      pinata_operations: 0, logging_policy: "append-only events/results; atomic checkpoint/audit; no private keys",
    });
  }
  event("run_started", { contract_address: contractAddress, chain_id: "80002", rektor_wallet: rektor.address, unauthorized_wallet: unauthorized.address });

  const syntheticHashedNina = ethers.id("SC-RBAC-FINAL-20260810-NINA");
  const syntheticHashedNim = ethers.id("SC-RBAC-FINAL-20260810-NIM");
  const cases = [
    {
      id: "SC-RBAC-01", signer: unauthorized, gasLimit: 500000n,
      expected: "revert AccessControlUnauthorizedAccount",
      request: { to: contractAddress, data: iface.encodeFunctionData("mintIjazah", [syntheticHashedNina, syntheticHashedNim, "bafkrei-rbac-no-pin", "0x00"]) },
      validateRevert: (r) => r.name === "AccessControlUnauthorizedAccount" && r.args[0]?.toLowerCase() === unauthorized.address.toLowerCase() && r.args[1]?.toLowerCase() === requiredRole.toLowerCase(),
    },
    {
      id: "SC-TRANSFER-01", signer: rektor, gasLimit: 300000n,
      expected: "revert Transfer diblokir",
      request: { to: contractAddress, data: iface.encodeFunctionData("transferFrom", [contractAddress, unauthorized.address, TRANSFER_TOKEN_ID]) },
      validateRevert: (r) => r.name === "Error" && r.reason === "Transfer diblokir: ijazah tidak dapat dipindahtangankan",
    },
  ];

  for (const test of cases) {
    if (checkpoint.cases[test.id]?.phase === "verified") {
      console.log(`${test.id}: sudah verified, dilewati`);
      continue;
    }
    const attempt = Number(checkpoint.cases[test.id]?.attempt || 0) + 1;
    const startedAt = new Date();
    let before = null;
    let resultBase = { run: RUN_ID, attempt, scenario_id: test.id, timestamp_start: startedAt.toISOString(), expected: test.expected, sender: test.signer.address, contract_address: contractAddress, token_id: test.id === "SC-TRANSFER-01" ? TRANSFER_TOKEN_ID : "", gas_limit: test.gasLimit.toString(), required_role: requiredRole, sender_has_required_role: test.id === "SC-RBAC-01" ? false : true, pin_added: 0 };
    try {
      const nextBefore = await contract.getNextTokenId();
      const balanceBefore = await provider.getBalance(test.signer.address);
      if (test.id === "SC-RBAC-01") {
        before = { nextToken: nextBefore, mapped: await contract.getTokenIdByHashedNina(syntheticHashedNina), balance: balanceBefore };
        if (before.mapped !== 0n) throw new Error("Hash NINA sintetis sudah memiliki token");
      } else {
        const data = await contract.getIjazahData(TRANSFER_TOKEN_ID);
        before = { nextToken: nextBefore, owner: await contract.ownerOf(TRANSFER_TOKEN_ID), active: Boolean(data[6]), balance: balanceBefore };
        if (!before.active) throw new Error(`Token #${TRANSFER_TOKEN_ID} tidak aktif`);
      }

      const revert = await expectedRevert(provider, iface, { ...test.request, from: test.signer.address });
      if (!test.validateRevert(revert)) throw new Error(`${test.id}: revert preflight tidak sesuai: ${revert.name} ${revert.reason}`);
      event("preflight_revert_confirmed", { scenario_id: test.id, attempt, revert_name: revert.name, revert_reason: revert.reason, revert_args: revert.args });

      const saved = checkpoint.cases[test.id];
      const submission = await obtainReceipt(provider, saved, test.signer, test.request, test.id, test.gasLimit);
      if (submission.submitted) {
        checkpoint.cases[test.id] = { phase: "submitted", attempt, tx_hash: submission.hash, submitted_at: new Date().toISOString() };
        atomicJson(CHECKPOINT, checkpoint);
        event("transaction_submitted", { scenario_id: test.id, attempt, tx_hash: submission.hash, nonce: submission.tx.nonce, gas_limit: test.gasLimit });
      }
      const receipt = await waitForRevertedReceipt(provider, submission.tx, submission.hash, submission.receipt);
      atomicJson(path.join(RECEIPTS, `${test.id}.json`), receipt.toJSON ? receipt.toJSON() : receipt);
      if (Number(receipt.status) !== 0) throw new Error(`${test.id}: transaksi justru berhasil dengan status ${receipt.status}`);

      const nextAfter = await contract.getNextTokenId();
      const balanceAfter = await provider.getBalance(test.signer.address);
      let stateUnchanged = nextAfter === before.nextToken;
      let ownerAfter = "", activeAfter = "";
      if (test.id === "SC-RBAC-01") {
        stateUnchanged = stateUnchanged && await contract.getTokenIdByHashedNina(syntheticHashedNina) === 0n;
      } else {
        ownerAfter = await contract.ownerOf(TRANSFER_TOKEN_ID);
        activeAfter = Boolean((await contract.getIjazahData(TRANSFER_TOKEN_ID))[6]);
        stateUnchanged = stateUnchanged && ownerAfter.toLowerCase() === before.owner.toLowerCase() && activeAfter === before.active;
      }
      if (!stateUnchanged) throw new Error(`${test.id}: state berubah setelah transaksi revert`);
      const block = await provider.getBlock(receipt.blockNumber);
      const finishedAt = new Date();
      const row = {
        ...resultBase, timestamp_end: finishedAt.toISOString(), latency_ms: finishedAt - startedAt,
        status: "pass", actual: "receipt status 0; revert sesuai; state tidak berubah",
        tx_hash: submission.hash, receipt_status: Number(receipt.status), gas_used: receipt.gasUsed.toString(),
        block_number: receipt.blockNumber, block_timestamp: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : "",
        revert_name: revert.name, revert_reason: revert.reason,
        next_token_before: before.nextToken.toString(), next_token_after: nextAfter.toString(),
        owner_before: before.owner || "", owner_after: ownerAfter,
        active_before: before.active === undefined ? "" : before.active,
        active_after: activeAfter,
        balance_before_wei: before.balance.toString(), balance_after_wei: balanceAfter.toString(),
        state_unchanged: true,
        notes: test.id === "SC-RBAC-01" ? "wallet eksternal tanpa role; input sintetis; tanpa unggah IPFS" : `transferFrom token aktif #${TRANSFER_TOKEN_ID}; owner kontrak tetap`,
      };
      appendResult(row);
      checkpoint.cases[test.id] = { phase: "verified", attempt, tx_hash: submission.hash, receipt_status: 0, gas_used: receipt.gasUsed.toString(), block_number: receipt.blockNumber, revert_name: revert.name, revert_reason: revert.reason, state_unchanged: true, verified_at: finishedAt.toISOString() };
      atomicJson(CHECKPOINT, checkpoint);
      event("case_verified", { scenario_id: test.id, attempt, tx_hash: submission.hash, receipt_status: 0, gas_used: receipt.gasUsed, state_unchanged: true });
      console.log(`${test.id}: PASS — ${submission.hash} (gas ${receipt.gasUsed})`);
    } catch (error) {
      const finishedAt = new Date();
      const message = error.shortMessage || error.message || String(error);
      appendResult({ ...resultBase, timestamp_end: finishedAt.toISOString(), latency_ms: finishedAt - startedAt, status: "fail", actual: message, pin_added: 0, state_unchanged: "unknown", notes: "runner melanjutkan ke skenario berikutnya" });
      checkpoint.cases[test.id] = { ...(checkpoint.cases[test.id] || {}), phase: "failed", attempt, error: message, failed_at: finishedAt.toISOString() };
      atomicJson(CHECKPOINT, checkpoint);
      event("case_failed", { scenario_id: test.id, attempt, error: message });
      console.error(`${test.id}: FAIL — ${message}`);
    }
  }

  const verified = cases.filter((test) => checkpoint.cases[test.id]?.phase === "verified");
  const audit = {
    schema_version: 1, run: RUN_ID, audited_at: new Date().toISOString(), status: verified.length === cases.length ? "pass" : "fail",
    expected_cases: cases.length, passed_cases: verified.length, failed_cases: cases.length - verified.length,
    transactions_expected: 2, transactions_recorded: verified.length,
    receipt_status_zero: verified.filter((test) => checkpoint.cases[test.id].receipt_status === 0).length,
    state_unchanged: verified.filter((test) => checkpoint.cases[test.id].state_unchanged).length,
    pin_added: 0, next_token_id: (await contract.getNextTokenId()).toString(),
    cases: Object.fromEntries(cases.map((test) => [test.id, checkpoint.cases[test.id] || null])),
  };
  atomicJson(AUDIT, audit);
  event("run_finished", audit);
  console.log(JSON.stringify(audit, null, 2));
  if (audit.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  try { event("run_failed", { error: error.shortMessage || error.message || String(error) }); } catch (_) { /* best effort */ }
  console.error(error.shortMessage || error.message || String(error));
  process.exit(1);
});
