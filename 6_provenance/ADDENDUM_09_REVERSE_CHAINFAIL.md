# Addendum — Reverse chain-failure revocation experiment

This note records files added **after** the original analysis package was sealed.
`checksums.sha256`, `FILE_MANIFEST.csv`, `MANIFEST.csv`, `RAW_MANIFEST.csv` and
`PROVENANCE_FINAL.json` are deliberately **left unmodified**, so none of the files
listed here appear in them. `sha256sum -c checksums.sha256`, run from
`6_provenance/`, still verifies all 91 original entries as OK.

## Why this experiment exists

`3_raw_measurements/14_cascading_revoke_final_10.csv` covers only one failure
direction. In all ten executions the on-chain revocation succeeded first
(`blockchain_active_initial = false`) and the injected fault was a SIVIL registry
synchronisation failure. A reviewer asked for the opposite direction to be
exercised operationally: the SIVIL registry is revoked, but the on-chain
revocation **fails before entering a block**, leaving the token active in the
contract.

## How it differs from `15_recovery_timeout_rpc_final_1.csv`

In file 15 the transaction *was* committed on chain and only the receipt read
timed out. Here the transaction is rejected at broadcast, so every execution is
re-checked against a correct RPC endpoint:

* the token must still read `isActive = true` on chain, and
* the hash of the signed-but-rejected raw transaction must **not** be found on
  chain (`getTransaction` returns `null`).

Both checks are recorded per case in `events.ndjson` (`injection_verified`) and
the unsent hash is carried in each CSV row's `notes` field. If a transaction had
in fact been mined, the execution would have been marked invalid and repeated
with the next candidate credential; the run completed with zero invalid
executions (`audit.json -> invalid_executions: []`).

## Fault injection method

Method **(b)**: a local JSON-RPC stub bound to `127.0.0.1` on an ephemeral port.
It forwards every read method (`eth_chainId`, `eth_getTransactionCount`,
`eth_gasPrice`, `eth_estimateGas`, …) to the real RPC so the transaction is built
and signed normally, and returns a JSON-RPC error for `eth_sendRawTransaction`.
The failure therefore occurs precisely at broadcast rather than at an unreachable
endpoint. The rejected raw transaction is captured so its hash can be searched
for on chain.

## Files added

Experiment script and result table:

| Path | SHA-256 |
| --- | --- |
| `5_test_scripts/uji-reverse-chainfail.cjs` | `6d57ea3adeaeb257eaab122081b898476c5942ccd9e1f592744f0d33df4b8dce` |
| `3_raw_measurements/21_reverse_chainfail_final_5.csv` | `beb0756fc546244962fca7c987646726010bba9eac62258a3c76125df8eeb120` |

Raw execution logs, copied to `6_provenance/raw/09-reverse-chainfail/`
(checksums relative to `6_provenance/`):

```
b453f588ff9fb73360f0d998585cd4890db8f288eec263dfbfe9274aaccad3ef  raw/09-reverse-chainfail/audit.json
68bbfa43fa724e5de3de79ef1a72b32ac97306c208b45cebb998b6ed0bc1b568  raw/09-reverse-chainfail/checkpoint.json
69948b9a9217e32a1d138542a1399da47eeb6240fac34aa588f6fc2479f71fd2  raw/09-reverse-chainfail/events.ndjson
8dd5504ff05668c256aa0a8ef874beca52d97142e95091ba7b036248711c2783  raw/09-reverse-chainfail/post-revoke-revert-probe.json
1bf95c7f7da97a5b34b3120d26766a575acffe375aa0767c7cef4c9afce2f9cb  raw/09-reverse-chainfail/receipts/REV-CHAINFAIL-1.json
55dde2e45595e32e2c8b13ba90fb4b4d47395555780d22b67872829e7e9fb185  raw/09-reverse-chainfail/receipts/REV-CHAINFAIL-2.json
945a528a22c2fc49ae46c215ad327219e3b40cb01fd5e8ab690653fa1e26c22d  raw/09-reverse-chainfail/receipts/REV-CHAINFAIL-3.json
b00a66ba4a2b1ea9edf2c6be6ac7dda8f51fea2dccb4f7a98f78992d8279b2be  raw/09-reverse-chainfail/receipts/REV-CHAINFAIL-4.json
36427916ae57e425fa49c28d0d611b8316442e7309101251eedc36a550a5a2d8  raw/09-reverse-chainfail/receipts/REV-CHAINFAIL-5.json
beb0756fc546244962fca7c987646726010bba9eac62258a3c76125df8eeb120  raw/09-reverse-chainfail/results.csv
b61c15f4599e65c2c379d214d64c13b8da5c7330c4cf7d6d4281d57886bcb5af  raw/09-reverse-chainfail/validation-report.json
3504ba71b9914f486f87450727ad03d63eae015be3cda6005664a7373f44697a  raw/09-reverse-chainfail/run-attempt-aborted.json
782638cf930b3c86919898555078be5ca7bf8dc988e8953a0c730e3e61e69629  raw/09-reverse-chainfail/run.json
```

The script writes its working copy of these logs to
`5_test_scripts/pengujian-final/reverse-chainfail/chainfail/` on the machine it
runs on. That directory is not committed; `6_provenance/raw/09-reverse-chainfail/`
is the copy of record.

## Post-run validation

`validation-report.json` records an independent verification pass run after the
experiment. Every claim in the CSV is re-tested against its source rather than
against the run's own log: on-chain state and receipts are re-read through two
independent RPC providers, the eight state columns are re-read from the live
databases, and the portal verdict is re-requested live. 91 checks, 91 pass.

Two results are worth singling out:

* For all five rows the signed-but-rejected injection transaction is still
  absent from the chain (`getTransaction` returns `null`), and the recovery
  receipt matches the recorded `block_number`, `gas_used`, `receipt_status` and
  sender. This is the evidence that separates this experiment from file 15.
* `sivil_db.verifikasi_logs` independently preserves the inconsistent moment:
  exactly one row per NINA with `sivil_valid = 0`, `blockchain_valid = 1`,
  `dual_verified = 0` — the registry layer rejecting while the chain layer still
  accepted.

One check initially failed and resolved as transient: a live re-request for
`REV-CHAINFAIL-2` returned `is_active = null`, SIAKAD's fail-closed branch when
the Polygon node is momentarily unreachable. Six consecutive re-probes returned
`is_active = false`. The portal verdict is `false` under both conditions, so no
row's claim is affected. The detail is kept in the report rather than removed.

## CSV schema

`21_reverse_chainfail_final_5.csv` uses the 31 columns of
`14_cascading_revoke_final_10.csv` in the same order, followed by three new
columns: `blockchain_active_final`, `detection_method`, `detection_latency_ms`.
`mode` is `chain_failure` in every row.

Two column semantics are worth stating explicitly:

* `first_attempt_cascade` keeps the file-14 predicate (all local layers revoked
  **and** the token inactive on chain on the first attempt). It is `false` in
  every row, because the on-chain transaction never entered a block.
* `safety_denial` keeps the file-14 *meaning* — the portal refused a valid
  verdict while the credential was already revoked in the authoritative layer —
  but the authoritative layer differs by construction. In file 14 that layer is
  the chain; here it is the SIVIL registry, so the predicate is
  `sivil_initial_status == "direvoke" && verification_valid_initial == false`.
  Each row's `notes` field states this.
* `action_latency_ms` is the total span `timestamp_end - timestamp_start`, as
  specified for this experiment. In file 14 the same column held only the
  duration of the revoke action, so the two columns are **not** directly
  comparable.

## Deviations and corrections, recorded in full

1. **One credential consumed by an aborted first attempt.** The first run
   completed the whole mechanism for NIM `20210025` / token `1024`
   (registry revoked, injection rejected, mismatch detected, recovery
   transaction `0xc72f33a4d354aff9b335ae28e5547d42f1d1c76cc0f83f0801fcc6234e68cc83`
   mined in block `48103763`), then aborted on a transient
   `CALL_EXCEPTION: missing revert data` from the public RPC while reading the
   final on-chain state. No CSV row was written. Token `1024` ended fully and
   consistently revoked across all layers, so it was no longer an active
   credential and the re-run skipped it. The full trace is at the head of
   `events.ndjson` and in `run-attempt-aborted.json`. Record counts were
   unaffected: 212 students / 200 diplomas / 200 tokens in `#1001–#1200` before
   and after (`audit.json -> bookkeeping_before`, `bookkeeping_after`).
   The recorded five cases therefore use tokens `1025, 1026, 1027, 1028, 1023`.
   Because the aborted attempt had already been assigned the case identifier
   `REV-CHAINFAIL-1`, its on-chain revoke reason carries that label, and the
   re-run then assigned the same label to token `1025`. Two transactions on the
   contract therefore read `REV-CHAINFAIL-1`; only the one on token `1025`
   corresponds to a row in the measurement table. Counted over this experiment
   the contract records six `revokeIjazah` calls, in blocks 48103763 to
   48103898. Earlier revocation experiments account for a further fourteen,
   listed in `19_transaksi_revoke_final_14.csv`, so the issued range
   `#1001-#1200` holds twenty inactive tokens in total.

2. **Read hardening after that abort.** Chain reads were given bounded retries
   and, from the third attempt, a second independent RPC endpoint
   (`80002.rpc.thirdweb.com` alongside `polygon-amoy.drpc.org`). This affects
   only how a read is transported, never what is reported as chain state.

3. **Post-hoc correction of two `notes` cells.** Step 9 of the protocol probes,
   read-only, whether a further revoke call would revert. On `REV-CHAINFAIL-3`
   and `REV-CHAINFAIL-5` the first probe returned the transport error
   `missing revert data` rather than the contract's revert reason. The probe was
   re-run read-only for all five tokens (`eth_call` from the `REKTOR_ROLE`
   address; no transaction sent) and all five revert with
   `Ijazah sudah direvoke`. Those two `notes` cells were corrected and say so
   inline. Evidence: `post-revoke-revert-probe.json`. The original transient
   readings remain in `events.ndjson` (`second_tx_assessment`).
