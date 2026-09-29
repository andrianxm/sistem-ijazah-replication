# Addendum — Verification with the RPC path unavailable

This note records files added in v1.0.3, **after** the original analysis
package was sealed. As with Addendum 09, `checksums.sha256`,
`FILE_MANIFEST.csv`, `MANIFEST.csv`, `RAW_MANIFEST.csv` and
`PROVENANCE_FINAL.json` are deliberately **left unmodified**.
`sha256sum -c checksums.sha256`, run from `6_provenance/`, still verifies all 91
original entries as OK.

## Why this experiment exists

Section 2.2 states that when the RPC path is unavailable, the blockchain layer
is reported as unverified and the combined decision is negative. None of the 30
verification executions in `11_latensi_verifikasi_final_30.csv` entered that
path. This experiment exercises it under control, for the contrast the reviewer
asked for: registry **positive**, chain **unverified**, combined decision
**negative**.

## Where the RPC path actually is

The SIVIL portal does not call an RPC endpoint itself.
`VerifikasiController::verifyBlockchain()` delegates the blockchain layer to the
SIAKAD endpoint `GET /api/verify-nina`. That endpoint reads the contract through
`POLYGON_RPC_URL` **of the SIAKAD container**. The `POLYGON_RPC_URL` set on the
SIVIL container is not used by the verification flow. The fault was therefore
injected on the SIAKAD side of that path.

## Fault injection, method (a)

This is method (a): an unreachable endpoint. The original SIAKAD container was
stopped but not removed. A replacement container was started from the same
image with the same environment, volumes, network, `siakad` alias and port.
The only difference was `POLYGON_RPC_URL=http://127.0.0.1:1` (connection
refused). Before any SIVIL call, the injection was confirmed twice:

* `printenv` inside the replacement container returned `http://127.0.0.1:1`;
* a direct call to `/api/verify-nina` returned `valid:false`, `is_active:null`,
  `verification_mode:"fallback"` and
  "Status blockchain tidak dapat diverifikasi karena node Polygon tidak tersedia."

Afterwards the replacement was removed and the original container restarted.
Its compose config hash (`3e2677b9…d9f1`), image and `POLYGON_RPC_URL`
(`https://polygon-amoy.drpc.org`) were identical to before
(`events.ndjson → restored`). This approach was chosen over re-running
`docker compose up`: `sia-simulasi/.env` has gained a key since the running
container was created, so recreating it would have changed its configuration.

The replacement container logged
`Blockchain verification error: connect ECONNREFUSED 127.0.0.1:1` six times,
once for the direct probe and once for each of the five SIVIL executions
(`siakad-injected-container.log`).

## Credentials

Five credentials were used. Each was active in **both** layers, and this was
confirmed before injection: the SIVIL registry row read `aktif`, the on-chain
`getIjazahData().isActive` read `true`, and a live `/api/verify-nina` call
returned `valid:true, is_active:true`. None of them appears in any earlier
verification, revocation or modification experiment (files 06–08, 11–16 and
19–21). They are the first such credential at or after tokens 1040, 1080, 1120,
1160 and 1200: NIM 20210040, 20210080, 20210120, 20210160 and 20210200.

No credential was issued, nothing was revoked, nothing was uploaded, and no
transaction was sent. The issuer wallet nonce was 151 before and 151 after.
Bookkeeping was 212 students, 200 diplomas and 200 tokens in `#1001–#1200`
before and after. All five tokens still read `isActive = true` after the run
(`audit.json`).

## Result

`3_raw_measurements/22_rpc_unavailable_final_5.csv` has the column set of file
11 in the same order, followed by `post_restore_verification` and
`rpc_injection_method`.

* 5/5 combined decisions were negative (`tidak valid (blockchain tidak terverifikasi)`), HTTP 200.
* 5/5 registry statuses stayed `aktif`; the portal's `sivilStatus` was `found`.
* 5/5 `blockchain_status` values were `tidak_terverifikasi`, with `is_active = null` and
  the error message "Status blockchain tidak dapat diverifikasi karena node
  Polygon tidak tersedia."
* 5/5 rows in `sivil_db.verifikasi_logs` (ids 143–147) record
  `sivil_valid=1, blockchain_valid=0, dual_verified=0`.
* Latency was 44–128 ms with a median of 48 ms. The refused connection fails fast,
  so these figures describe this failure mode and are not comparable with the
  live-path latencies in file 11.

### Two observations about labelling, recorded as found

1. **`verification_mode` reads `live` in all five rows.** The column is computed
   with the same classifier that produced file 11 (`uji-matriks.cjs`: the regex
   `luring|fallback|offline` over the returned HTML), so the rows can be compared
   directly. SIAKAD does return `verification_mode:"fallback"`, but
   `verifyBlockchain()` does not copy that field into the result it passes to the
   page or the log, so the classifier cannot see it. The fail-closed decision
   does not depend on this label: it follows from `blockchain_valid=false`.
   It does mean the file-11 statement that no execution entered the fallback path
   rests on those 30 executions returning `valid`, which requires a live chain
   read. It does not rest on the `verification_mode` label.
2. **The portal does not label the result as offline validation.** The page
   displays the generic modal "Data tidak ditemukan atau tidak valid di
   Blockchain." The specific RPC-unavailable message exists only in the embedded
   `blockchainData` and in `verifikasi_logs.blockchain_data`. Redacted copies of
   every returned page are in `portal-html/`, with CSRF tokens replaced by
   `[REDACTED]`.

## Deviation, recorded in full

**Post-restore verification of `RPC-UNAVAIL-3` (token 1120) failed once, for an
unrelated reason.** Once the original container was running again, four of the
five re-verifications returned `valid` (log ids 148, 149, 151, 152). The
re-verification of token 1120 (log id 150) returned `tidak valid (blockchain tidak
terverifikasi)`. The original, correctly configured container logged
`Blockchain verification error: missing revert data (… code=CALL_EXCEPTION,
version=6.17.0)` at 12:11:50.845Z (`siakad-original-post-restore.log`). That is
a transient transport error from the public drpc endpoint, the same class of
error that aborted the first reverse-chainfail attempt on token 1024
(Addendum 09). The CSV cell is left as recorded.

One further re-verification of token 1120 was then made through the same portal,
40 seconds later with no configuration change. It returned `valid` with
`dual_verified=1` (log id 153), and it is kept separately in
`post-restore-reverify-RPC-UNAVAIL-3.json`. The incident also shows the
fail-closed behaviour occurring naturally on a public RPC fault while the
credential was valid in both layers.

## Reproduction

From the root of the package, with the stack from `docker-compose.yml` running:

```
MYSQL_PWD=<mysql root password> node 5_test_scripts/uji-rpc-unavailable.cjs
```

The script needs no private key. It refuses to run if the output CSV already
exists.

## Files added in v1.0.3

Paths are relative to the package root.

```
111135851e731235ac6c80d330c51642a0caaa23a56e6a20c988b26bc21e32de  2_smart_contract/dependency-reachability/README.md
43074135a6fa5e8546fd9ee8d2ad7dd57229a61b9401b6ea331fae8a3240c9f4  2_smart_contract/dependency-reachability/call-graph/Bytes.call-graph.dot
d273872e3125ccac2b5d2e800360c350ae0e8f91e8ed1230ae1ae046ad08b80b  2_smart_contract/dependency-reachability/call-graph/ERC721Utils.call-graph.dot
18ebed2122ccc19a3a5040c125451f52470b6c83904f35f799f94068f208d4b6  2_smart_contract/dependency-reachability/call-graph/IERC1155Errors.call-graph.dot
18ebed2122ccc19a3a5040c125451f52470b6c83904f35f799f94068f208d4b6  2_smart_contract/dependency-reachability/call-graph/IERC20Errors.call-graph.dot
4a6dfb1fbc067dece3bb1718029f9842a1c337859f20bbda61ab439c783a56c4  2_smart_contract/dependency-reachability/call-graph/IERC721Receiver.call-graph.dot
8524d52de55c328b38296bdc67899b9d80de85dd39dcb56ed8babc991345a885  2_smart_contract/dependency-reachability/call-graph/IjazahNFT.call-graph.dot
00649902b15b05f4bda194afeaef5e9eb30081224ce1f520952ba94b8f7c65e2  2_smart_contract/dependency-reachability/call-graph/Math.call-graph.dot
4eb0ec4743ee7fa51d39dbca20ac8a0fd4f6e47615b66bfbbfc6b95c99825945  2_smart_contract/dependency-reachability/call-graph/Panic.call-graph.dot
7e3a00eacdd5dc57594a2cfda7e2c4ff46d87decc3d3cce4c1313187d785d0b0  2_smart_contract/dependency-reachability/call-graph/SafeCast.call-graph.dot
6247d31086d4d83bf20b7928e53c270c60d295332a1dfebd35686a4195e8954b  2_smart_contract/dependency-reachability/call-graph/SignedMath.call-graph.dot
67727b4b57afb9c443bcce650f189c560534fe47fe6a37d95c413fbfbead3114  2_smart_contract/dependency-reachability/call-graph/StorageSlot.call-graph.dot
54903a380450b640ad5b859acd74b52da1664cbd2bfbb706bdeca96c71270960  2_smart_contract/dependency-reachability/call-graph/Strings.call-graph.dot
5a5567c2edf43be487a92cb5265ece05d714edc08fcde4e3e454f4050ba4c0ed  2_smart_contract/dependency-reachability/call-graph/all_contracts.call-graph.dot
3cbbbf9ac459eb721d12420d255e70270d0432bde4e51724264ddc9563ef52c3  2_smart_contract/dependency-reachability/reachability-result.json
3afce07f710029463ee906c6b939f6124c55bc918bf1d535d8c68057fb97eab9  2_smart_contract/dependency-reachability/reachability.py
8d66547e79d8c3235c5cb1883b8c34b4d736fc6a5f6e2b113afbc0c1077b7b82  2_smart_contract/dependency-reachability/slither-printers.txt
7e1269ef378c2b83079d164abb557714216bbc9b25fee338309d55c7604f993b  2_smart_contract/dependency-reachability/verified-source-provenance.json
a655fdf9018db92f02ad4e8a7e1a9f179edba8f226cca99af514b593d4cc8a1f  3_raw_measurements/22_rpc_unavailable_final_5.csv
d225c34a6e60d2e3140fb90aaf2d4e3ca989dc6718896afee7e60c4d4b4899b5  5_test_scripts/uji-rpc-unavailable.cjs
d0279fdca5b97b5706fc3416af0abe48c23991bd67190f8ec3db9e24da9784b7  6_provenance/raw/10-rpc-unavailable/audit.json
48e676d131baad53bb5cbaa90566c9338344591348cd41abbe18ae491e5085e1  6_provenance/raw/10-rpc-unavailable/events.ndjson
469e2728db753bf6492664c65e93c40d49d8746934829522335361d30c36a019  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-1-post-restore.html
0b27353684cc35da97978c83192d533159737c88709d36eb105c883282412f3f  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-1.html
e4b66866381055820ab0718d03f4ff44dd0de3d2377732241243cf56065b2e50  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-2-post-restore.html
3b47248a3d96fd6af770900bdf8a60e92889cf08927b5288b63e32cc966b039b  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-2.html
874e9b20074b9adb0e053bb3fa30cf678f5dce47c393de956b17aa340157be6d  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-3-post-restore.html
874e9b20074b9adb0e053bb3fa30cf678f5dce47c393de956b17aa340157be6d  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-3.html
ed83fee8b9a5e64b1d301102ffa0644e12b225f1114b808238608efd9b7dc05e  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-4-post-restore.html
40a2523d984c3057aa3256ccd10bd39478ac02687b42f1bd9401a184fb3f8cdc  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-4.html
e7fc88be7bb6699ab7ebbd797a857d8bc892d23b3fc86197c911b46e29688419  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-5-post-restore.html
e20e100cab6c594975c3a2776fef1be961b3285e49936c6c11fdb542029c9d30  6_provenance/raw/10-rpc-unavailable/portal-html/RPC-UNAVAIL-5.html
925fbf379404fbfdd79f691d1034897dcc3e65d72f51e02ff2aad64f9342e279  6_provenance/raw/10-rpc-unavailable/post-restore-reverify-RPC-UNAVAIL-3.json
84352d863d2642b946f8e55db5b4522295081aba3ec684018b5fba2a23ebd246  6_provenance/raw/10-rpc-unavailable/siakad-injected-container.log
c915f46a5b9b63bc39888a0283c88103d010e593863b8877cc21ab2226b45280  6_provenance/raw/10-rpc-unavailable/siakad-original-post-restore.log
```
