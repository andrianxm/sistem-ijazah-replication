#!/usr/bin/env python3
"""Reachability of the OpenZeppelin dependency findings from IjazahNFT entry points.

Two independent checks on the exact source set Sourcify verified for
0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54 (Polygon Amoy, chain 80002):

1. Call-graph closure (Slither IR). Starting from every public/external
   function of IjazahNFT, including inherited ones, plus the constructor,
   receive and fallback, follow every InternalCall, LibraryCall, HighLevelCall
   and modifier invocation transitively. Report which dependency functions are
   reached and whether the functions holding the findings are among them.
   Unresolvable edges (InternalDynamicCall, i.e. calls through function-type
   variables) are counted and reported, because they would make the closure
   incomplete.

2. Deployed bytecode (solc source map). Compile with the verified settings,
   confirm the runtime bytecode equals the on-chain runtime bytecode, then
   check whether any instruction of the deployed bytecode maps back to the
   source range of the functions holding the findings. solc emits code for an
   internal function only when it is referenced from emitted code, so zero
   mapped instructions means the function is not in the deployed contract.

Usage (from the directory holding contracts/ and @openzeppelin/):
    python reachability.py <sourcify.json> <out.json>
Requires slither-analyzer 0.11.x and solc 0.8.34 on PATH.
"""

import json
import subprocess
import sys

from slither import Slither
from slither.core.declarations import Function
from slither.slithir.operations import HighLevelCall, InternalCall, InternalDynamicCall, LibraryCall

TARGET = "contracts/IjazahNFT.sol"
CONTRACT = "IjazahNFT"
MATH = "@openzeppelin/contracts/utils/math/Math.sol"
# Functions holding the 1 High (incorrect-exp) and 9 Medium (divide-before-multiply)
# dependency findings in slither-report.json.
FINDING_FUNCTIONS = {
    "Math.mulDiv(uint256,uint256,uint256)": {"High": 1, "Medium": 8},
    "Math.invMod(uint256,uint256)": {"High": 0, "Medium": 1},
}


def qualified(f):
    return f"{f.contract_declarer.name}.{f.full_name}"


def callees(f):
    """Direct callees of f, and the number of unresolvable dynamic calls."""
    out, dynamic = [], 0
    for m in f.modifiers:
        out.append(m)
    for call in f.explicit_base_constructor_calls:
        out.append(call)
    for node in f.nodes:
        for ir in node.irs:
            if isinstance(ir, InternalDynamicCall):
                dynamic += 1
            elif isinstance(ir, (InternalCall, LibraryCall, HighLevelCall)) and isinstance(ir.function, Function):
                out.append(ir.function)
    return out, dynamic


def closure(start):
    """Breadth-first closure; returns {qualified name: path from start}."""
    seen = {qualified(start): [qualified(start)]}
    queue, dynamic = [start], 0
    while queue:
        f = queue.pop(0)
        nexts, dyn = callees(f)
        dynamic += dyn
        for g in nexts:
            key = qualified(g)
            if key not in seen:
                seen[key] = seen[qualified(f)] + [key]
                queue.append(g)
    return seen, dynamic


def slither_check(slither):
    contract = slither.get_contract_from_name(CONTRACT)[0]
    entries = [f for f in contract.functions
               if (f.visibility in ("public", "external") and not f.is_shadowed)
               or f.is_constructor or f.is_fallback or f.is_receive]
    per_entry, reached_any, dynamic_total = {}, {}, 0
    for f in sorted(entries, key=lambda x: x.full_name):
        seen, dynamic = closure(f)
        dynamic_total += dynamic
        deps = sorted(k for k in seen if k.split(".")[0] in {"Math", "Strings", "SafeCast", "SignedMath", "Bytes", "Panic", "StorageSlot", "ERC721Utils"})
        per_entry[f"{f.contract_declarer.name}.{f.full_name}"] = {
            "visibility": "constructor" if f.is_constructor else f.visibility,
            "library_functions_reached": deps,
        }
        for k in seen:
            if k in FINDING_FUNCTIONS:
                reached_any.setdefault(k, []).append(seen[k])

    # Positive controls: the traversal must cross library boundaries.
    erc721 = slither.get_contract_from_name("ERC721")[0]
    math = slither.get_contract_from_name("Math")[0]
    controls = {}
    base_uri = erc721.get_function_from_signature("tokenURI(uint256)")
    seen, _ = closure(base_uri)
    controls["ERC721.tokenURI(uint256) [overridden in IjazahNFT, not an entry point]"] = sorted(k for k in seen if k.startswith(("Math.", "Strings.")))
    four_arg = math.get_function_from_signature("mulDiv(uint256,uint256,uint256,uint8)")
    seen, _ = closure(four_arg)
    controls["Math.mulDiv(uint256,uint256,uint256,Rounding)"] = sorted(k for k in seen if k.startswith("Math."))

    # Every in-source caller of the finding functions, reachable or not.
    callers = {}
    for c in slither.contracts:
        for f in c.functions_and_modifiers_declared:
            for g in callees(f)[0]:
                if qualified(g) in FINDING_FUNCTIONS:
                    callers.setdefault(qualified(g), set()).add(qualified(f))

    return {
        "entry_points": per_entry,
        "entry_point_count": len(per_entry),
        "unresolvable_dynamic_calls": dynamic_total,
        "finding_functions_reached_from_entry_points": reached_any,
        "all_callers_in_source_set": {k: sorted(v) for k, v in callers.items()},
        "positive_controls": controls,
    }


def bytecode_check(sourcify_path):
    meta = json.load(open(sourcify_path))
    sources = {p: {"content": s["content"]} for p, s in meta["sources"].items()}
    settings = {k: v for k, v in meta["compilation"]["compilerSettings"].items() if k in ("optimizer", "remappings", "evmVersion", "metadata", "libraries")}
    settings["outputSelection"] = {"*": {"*": ["evm.deployedBytecode.object", "evm.deployedBytecode.sourceMap"], "": ["ast"]}}
    out = json.loads(subprocess.run(["solc", "--standard-json"], input=json.dumps({"language": "Solidity", "sources": sources, "settings": settings}),
                                    capture_output=True, text=True, check=True).stdout)
    errors = [e for e in out.get("errors", []) if e["severity"] == "error"]
    if errors:
        raise SystemExit(json.dumps(errors, indent=2))
    evm = out["contracts"][TARGET][CONTRACT]["evm"]["deployedBytecode"]
    onchain = meta["runtimeBytecode"]["onchainBytecode"].lower().removeprefix("0x")
    compiled = evm["object"].lower()

    file_index = {s["id"]: p for p, s in out["sources"].items()}
    math_id = out["sources"][MATH]["id"]

    # Byte ranges of every function in Math.sol, from the AST.
    ranges = {}
    for node in out["sources"][MATH]["ast"]["nodes"]:
        for member in node.get("nodes", []):
            if member.get("nodeType") == "FunctionDefinition":
                start, length, _ = map(int, member["src"].split(":"))
                params = ",".join(p["typeDescriptions"]["typeString"].replace("enum Math.", "") for p in member["parameters"]["parameters"])
                ranges[f"Math.{member['name']}({params})"] = (start, start + length)

    # Decompress the source map: s:l:f:j:m, empty fields inherit the previous value.
    s = l = f = 0
    hits = {name: 0 for name in ranges}
    per_file = {}
    for entry in evm["sourceMap"].split(";"):
        parts = entry.split(":")
        if len(parts) > 0 and parts[0]:
            s = int(parts[0])
        if len(parts) > 1 and parts[1]:
            l = int(parts[1])
        if len(parts) > 2 and parts[2]:
            f = int(parts[2])
        per_file[file_index.get(f, "<generated/none>")] = per_file.get(file_index.get(f, "<generated/none>"), 0) + 1
        if f == math_id:
            for name, (a, b) in ranges.items():
                if a <= s < b:
                    hits[name] += 1
    return {
        "solc": meta["compilation"]["compilerVersion"],
        "settings": {k: v for k, v in settings.items() if k != "outputSelection"},
        "sourcify_match": {"creation": meta.get("creationMatch"), "runtime": meta.get("runtimeMatch"), "match_id": meta.get("matchId")},
        "compiled_runtime_equals_onchain_runtime": compiled == onchain,
        "math_sol_source_index": math_id,
        "source_files": len(file_index),
        # Positive control for the method: files whose code is in the contract must show hits.
        "deployed_instructions_per_source_file": dict(sorted(per_file.items())),
        "deployed_instructions_mapped_to_math_function": {k: v for k, v in sorted(hits.items())},
        "finding_functions_in_deployed_bytecode": {k: hits.get(k, 0) for k in FINDING_FUNCTIONS},
    }


def main():
    sourcify_path, out_path = sys.argv[1], sys.argv[2]
    slither = Slither(TARGET, solc_remaps="@openzeppelin/=@openzeppelin/", solc_args="--optimize --optimize-runs 200")
    result = {
        "contract": "0x99b047a0165ef97d585aB8C3a50E3E001B9A1e54",
        "chain_id": 80002,
        "finding_functions": FINDING_FUNCTIONS,
        "slither_call_graph": slither_check(slither),
        "deployed_bytecode": bytecode_check(sourcify_path),
    }
    reached = result["slither_call_graph"]["finding_functions_reached_from_entry_points"]
    in_bytecode = result["deployed_bytecode"]["finding_functions_in_deployed_bytecode"]
    result["conclusion"] = {
        "reachable_from_any_entry_point": bool(reached),
        "present_in_deployed_bytecode": any(v > 0 for v in in_bytecode.values()),
        "closure_complete": result["slither_call_graph"]["unresolvable_dynamic_calls"] == 0,
    }
    with open(out_path, "w") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    print(json.dumps(result["conclusion"], indent=2))


if __name__ == "__main__":
    main()
