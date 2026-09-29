# Reachability of the dependency findings in Table 9

## Conclusion

None of the ten OpenZeppelin dependency findings can be reached from any
public or external entry point of the deployed `IjazahNFT`, and none of the
functions that contain them is present in the deployed bytecode. They cannot
affect credential status.

## What the findings are

From `../slither-report.json`, all ten dependency findings are in
`@openzeppelin/contracts/utils/math/Math.sol` (OpenZeppelin 5.x). They sit in
two functions, not one:

| Function | High | Medium | Detector |
|---|---|---|---|
| `Math.mulDiv(uint256,uint256,uint256)` | 1 (`incorrect-exp`, line 259) | 8 (`divide-before-multiply`) | |
| `Math.invMod(uint256,uint256)` | 0 | 1 (`divide-before-multiply`, lines 339/341) | |

## Source tree analysed

The analysis ran on the exact source set that Sourcify holds as an
**exact match** (creation and runtime) for
`0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54` on Polygon Amoy (match id
43422570): solc `0.8.34+commit.80d5c536`, optimizer enabled, 200 runs.
All 21 source files are identical to `../contracts/IjazahNFT.sol` and to the
local OpenZeppelin tree, ignoring CRLF line endings. Hashes are in
`verified-source-provenance.json`.

## Evidence, two independent methods

**1. Call graph (Slither 0.11.6).**

```
slither contracts/IjazahNFT.sol --solc-remaps "@openzeppelin/=@openzeppelin/" \
  --solc-args "--optimize --optimize-runs 200" --print call-graph,entry-points
python reachability.py <sourcify.json> reachability-result.json
```

`reachability.py` takes all 45 entry points and follows every internal, library
and external call plus every modifier, transitively. That covers all
public/external functions of `IjazahNFT` including those inherited from
ERC721, AccessControl and Pausable, the constructor chain, `receive` and
`fallback`. The result:

* The only library functions reachable from any entry point are
  `ERC721Utils.checkOnERC721Received` and `StorageSlot.getUint256Slot`.
  No `Math`, `Strings`, `SafeCast`, `SignedMath` or `Bytes` function is
  reachable.
* Neither `Math.mulDiv(uint256,uint256,uint256)` nor `Math.invMod` is reached.
  Across the whole source set, the only caller of the three-argument `mulDiv`
  is the four-argument `mulDiv(…,Rounding)`, which itself has no caller.
  `invMod` has no caller at all.
* There are no calls through function-type variables (0 `InternalDynamicCall`),
  so the closure is complete.
* **The `tokenURI → Strings → Math` path does not exist in this contract.**
  `IjazahNFT.tokenURI` overrides the ERC721 version and returns
  `abi.encodePacked("ipfs://", cid)` without calling `Strings`. Even the
  overridden `ERC721.tokenURI`, which is not an entry point, would reach only
  `Strings.toString → Math.log10`, never `mulDiv` or `invMod`. That fact
  doubles as a positive control: the traversal does cross into libraries.

The call graphs are in `call-graph/`. In `all_contracts.call-graph.dot`
there is no edge from any `IjazahNFT` node into `Math`.

**2. Deployed bytecode (solc source map).**

`reachability.py` recompiles the verified sources with the verified settings.
The compiled runtime bytecode equals the on-chain runtime bytecode. It then
maps every deployed instruction back to its source range.

* Instructions mapped to `Math.sol`: **0**, and so 0 for `mulDiv` and 0 for
  `invMod`.
* Positive control: dependency code that *is* used does appear. There are
  instructions from `ERC721.sol` (990), `AccessControl.sol` (424),
  `ERC721Utils.sol` (157), `Pausable.sol` (118) and `ReentrancyGuard.sol` (66).

solc emits an internal library function only when emitted code references it.
Zero mapped instructions therefore means the code of these functions is not
in the deployed contract.

## Effect on credential status

None. A credential's `isActive` flag is set to true in `_mintSingle`, which is
reached from `mintIjazah`, `mintIjazahForInstitution` and `batchMintIjazah`.
It is set to false only in `revokeIjazah`. `updateIjazah` appends to the update
history. All of these, together with every view function that reads status,
are among the 45 entry points in the closure. None of them reaches `Math.sol`,
and the affected arithmetic is not in the deployed bytecode.

## Files

* `slither-printers.txt`: raw `call-graph` and `entry-points` printer output
* `call-graph/*.dot`: Slither call graphs
* `reachability.py`: the closure and source-map checks
* `reachability-result.json`: their full output, with per-entry-point reachable library functions
* `verified-source-provenance.json`: Sourcify match, compiler, source hashes, tool versions
