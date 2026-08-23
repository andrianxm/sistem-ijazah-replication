import csv
import os

STAGE_MAP = {
    "F01": "F01 Report data (PDDikti)",
    "F02": "F02 Eligibility check (PDDikti)",
    "F03": "F03 Generate NINA (PISN)",
    "F04": "F04 Generate PDF (SIA)",
    "F05": "F05 Encrypt and upload (IPFS/Pinata)",
    "F07": "F07 Mint token (Polygon Amoy)"
}

F08_LABEL = "F08 Dual-layer verification (SIVIL)"

primary_files = [
    "/home/andrian/sistem-ijazah/pengujian/pengujian-final/analisis-inti-final/raw/01-functional/automated-primary-results.csv",
    "/home/andrian/sistem-ijazah/pengujian/pengujian-final/analisis-inti-final/raw/01-functional/automated-retry-nim05-results.csv"
]

verif_file = "/home/andrian/sistem-ijazah/pengujian/pengujian-final/analisis-inti-final/11_latensi_verifikasi_final_30.csv"

all_data = []

# 1. Gather F01 to F07 from primary files
for f in primary_files:
    if os.path.exists(f):
        with open(f, mode='r', encoding='utf-8') as infile:
            reader = csv.DictReader(infile)
            for row in reader:
                scenario_id = row.get('scenario_id', '')
                latency_ms = row.get('latency_ms', '0')
                try:
                    latency = float(latency_ms)
                except ValueError:
                    latency = 0.0
                
                # Hanya ambil latency > 0 agar cache/skipped tidak ikut (sesuai instruksi sebelumnya)
                if latency > 0 and scenario_id in STAGE_MAP:
                    all_data.append({
                        "stage": STAGE_MAP[scenario_id],
                        "latency_ms": latency_ms
                    })

# 2. Gather F08 from the specific verification file (30 normal executions)
if os.path.exists(verif_file):
    with open(verif_file, mode='r', encoding='utf-8') as infile:
        reader = csv.DictReader(infile)
        for row in reader:
            latency_ms = row.get('latency_ms', '0')
            try:
                latency = float(latency_ms)
            except ValueError:
                latency = 0.0
            
            if latency > 0:
                all_data.append({
                    "stage": F08_LABEL,
                    "latency_ms": latency_ms
                })

out_path = "/home/andrian/sistem-ijazah/pengujian/pengujian-final/latency_raw.csv"
with open(out_path, mode='w', encoding='utf-8', newline='') as outfile:
    writer = csv.DictWriter(outfile, fieldnames=["stage", "latency_ms"])
    writer.writeheader()
    for row in all_data:
        writer.writerow(row)

print(f"Generated {out_path} with {len(all_data)} records")
