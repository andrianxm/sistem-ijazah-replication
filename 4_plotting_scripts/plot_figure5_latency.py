#!/usr/bin/env python3
"""
Figure 5 - Latency distribution per issuance stage.

Run this on YOUR OWN measurement data. It does not contain or invent any data.

Expected input: a CSV with one row per measured execution and two columns:

    stage,latency_ms
    F01 Report data (PDDikti),103
    F01 Report data (PDDikti),97
    F02 Eligibility check (PDDikti),98
    ...

Usage:
    python plot_figure5_latency.py latency_raw.csv figure5_latency.png

Output: a 300 dpi PNG sized for a 5.2-inch column, matching the other
figures in the manuscript.
"""

import sys
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Stage order top-to-bottom in the plot. Edit to match your own labels exactly
# as they appear in the CSV.
STAGE_ORDER = [
    "F01 Report data (PDDikti)",
    "F02 Eligibility check (PDDikti)",
    "F03 Generate NINA (PISN)",
    "F04 Generate PDF (SIA)",
    "F05 Encrypt and upload (IPFS/Pinata)",
    "F07 Mint token (Polygon Amoy)",
    "F08 Dual-layer verification (SIVIL)",
]

WIDTH_IN = 5.2      # matches Figures 4 and 6 in the manuscript
HEIGHT_IN = 2.9
DPI = 300


def main(csv_path: str, out_path: str) -> None:
    df = pd.read_csv(csv_path)

    missing = [c for c in ("stage", "latency_ms") if c not in df.columns]
    if missing:
        raise SystemExit(f"CSV is missing required column(s): {missing}")

    present = [s for s in STAGE_ORDER if s in set(df["stage"])]
    unexpected = sorted(set(df["stage"]) - set(STAGE_ORDER))
    if unexpected:
        print(f"Warning: stages not in STAGE_ORDER were skipped: {unexpected}")
    if not present:
        raise SystemExit("No stage in STAGE_ORDER matched the CSV.")

    # Reverse so the first stage appears at the top of the plot.
    ordered = list(reversed(present))
    data = [df.loc[df["stage"] == s, "latency_ms"].dropna().values for s in ordered]

    for label, values in zip(ordered, data):
        print(f"{label:40s} n={len(values):4d}  median={pd.Series(values).median():10.1f} ms")

    fig, ax = plt.subplots(figsize=(WIDTH_IN, HEIGHT_IN))
    ax.boxplot(
        data,
        vert=False,
        labels=ordered,
        widths=0.6,
        showfliers=True,
        flierprops=dict(marker=".", markersize=3, markerfacecolor="0.3",
                        markeredgecolor="0.3"),
        medianprops=dict(color="black", linewidth=1.2),
        boxprops=dict(color="black", linewidth=0.8),
        whiskerprops=dict(color="black", linewidth=0.8),
        capprops=dict(color="black", linewidth=0.8),
    )

    ax.set_xscale("log")
    ax.set_xlabel("Latency (ms, log scale)", fontsize=8)
    ax.tick_params(axis="both", labelsize=7)
    ax.grid(axis="x", which="both", linestyle=":", linewidth=0.5, alpha=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

    fig.tight_layout(pad=0.3)
    fig.savefig(out_path, dpi=DPI, facecolor="white")
    print(f"\nWrote {out_path} at {WIDTH_IN}x{HEIGHT_IN} in, {DPI} dpi")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
