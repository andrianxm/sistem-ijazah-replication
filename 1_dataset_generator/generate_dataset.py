#!/usr/bin/env python3
"""
Generator dataset sintetis untuk eksperimen PoC otentikasi ijazah digital.

Bersifat DETERMINISTIK: seed dikunci, sehingga menjalankan skrip ini
menghasilkan 315 record yang identik setiap saat. Ini yang membuat
dataset dapat direproduksi pihak ketiga.

Keluaran:
    students.csv            - data induk mahasiswa (tabel Student)
    diplomas.csv            - data ijazah (tabel Diploma)
    dataset_manifest.json   - ringkasan komposisi + parameter untuk naskah

Pemakaian:
    pip install faker
    python generate_dataset.py
"""

import csv
import json
import re
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from faker import Faker

# ============================================================
#  PARAMETER TETAP  (ubah hanya sebelum eksperimen dimulai)
# ============================================================
SEED = 42                    # kunci reproduksibilitas — JANGAN diubah setelah eksperimen mulai
KODE_PT = "041058"           # 6 digit, diverifikasi dari NINA aktual: 040410582600004
TAHUN_LULUS = 2026
KODE_JENJANG = {"D3": "03", "S1": "04", "S2": "05", "S3": "06"}
JENJANG = "S1"
FACULTY_ID = 1

# Komposisi dataset (sesuai Subbagian 3.1 naskah)
N_ALUR_PENUH = 30            # mint tunggal, NINA diperoleh saat reservasi (dikosongkan)
# Sapuan ukuran batch. Ukuran 50 hanya satu pengulangan karena kapasitas
# layanan penyematan IPFS membatasi jumlah artefak yang dapat disimpan;
# setiap kredensial menghasilkan dua artefak (PDF dan metadata JSON).
BATCH_PLAN = [(5, 3), (10, 3), (25, 3), (50, 1)]   # (ukuran, pengulangan) -> 170 kredensial
N_INELIGIBLE = 10
N_DUPLIKAT_NINA = 2

PRODI = [
    "Teknik Informatika", "Sistem Informasi", "Teknik Elektro",
    "Manajemen", "Akuntansi", "Ilmu Komunikasi",
]
AKREDITASI = ["Unggul", "Baik Sekali", "Baik"]

fake = Faker("id_ID")
Faker.seed(SEED)

# CATATAN PENTING
# Pada Faker locale id_ID, fake.name_male() terbukti mengembalikan nama
# perempuan (mis. "Ciaobella Wastuti", "Sadina Palastri") karena templat
# namanya tercampur, dan keluarannya kerap disisipi gelar akademik
# ("S.T.", "M.Pd") maupun gelar kebangsawanan/keagamaan ("KH.", "Cut").
# Karena itu nama dirakit sendiri dari komponen first_name_male /
# first_name_female + last_name, yang terverifikasi bersih dari gelar dan
# konsisten terhadap jenis kelamin.


def nama_bersih(jk: str) -> str:
    """Nama dua kata, tanpa gelar, konsisten dengan jenis kelamin."""
    depan = fake.first_name_male() if jk == "L" else fake.first_name_female()
    return f"{depan} {fake.last_name()}"


def buat_nina(sequence: int) -> str:
    """[2 jenjang][6 kode PT][2 tahun][5 sequence] = 15 digit."""
    nina = (
        KODE_JENJANG[JENJANG]
        + KODE_PT
        + str(TAHUN_LULUS)[-2:]
        + str(sequence).zfill(5)
    )
    assert len(nina) == 15, f"NINA harus 15 digit, diperoleh {len(nina)}: {nina}"
    return nina


def predikat_dari_ipk(ipk: Decimal) -> str:
    if ipk >= Decimal("3.51"):
        return "Dengan Pujian (Cumlaude)"
    if ipk >= Decimal("3.01"):
        return "Sangat Memuaskan"
    return "Memuaskan"


def buat_ipk(low: float, high: float) -> Decimal:
    return Decimal(str(round(fake.random.uniform(low, high), 2))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def buat_mahasiswa(idx: int, nim: str, eligible: bool) -> dict:
    jk = fake.random_element(["L", "P"])
    nama = nama_bersih(jk)
    lahir = fake.date_between(date(2000, 1, 1), date(2003, 12, 31))
    ipk = buat_ipk(3.00, 3.95) if eligible else buat_ipk(1.80, 2.40)

    return {
        "id": idx,
        "nim": nim,
        "name": nama,
        "major": fake.random_element(PRODI),
        "tempatLahir": fake.city(),
        "tanggalLahir": lahir.isoformat(),
        "jenisKelamin": jk,
        "facultyId": FACULTY_ID,
        "ipk": str(ipk),
        "nomorSkYudisium": f"SK-YUD/{TAHUN_LULUS}/{str(idx).zfill(4)}",
        "tanggalSkYudisium": date(TAHUN_LULUS, 5, 20).isoformat(),
        # KONDISI MENTAH. Mesin status ditentukan aplikasi, bukan dataset:
        #   unverified  -> belum pernah lapor data ke PDDikti
        #   ineligible  -> sudah lapor data, belum lapor kelulusan
        #   eligible    -> sudah lapor kelulusan (dari laporKelulusan)
        # statusMesin berpindah ke SIAP_DITERBITKAN setelah NINA terbit.
        # Karena itu seluruh mahasiswa dimulai dari titik yang sama; kelompok
        # "ineligible" hanya berbeda perlakuan (dihentikan setelah lapor data),
        # bukan berbeda nilai awal.
        "pddiktiStatus": "unverified",
        "statusMesin": "DRAFT",
    }


def buat_ijazah(dip_id: int, student: dict, nina: str | None, kelompok: str) -> dict:
    ipk = Decimal(student["ipk"])
    return {
        "id": dip_id,
        "diplomaNumber": f"IJZ-{TAHUN_LULUS}-{str(dip_id).zfill(4)}",
        "nina": nina or "",
        "studentId": student["id"],
        "major": student["major"],
        "jenjangPendidikan": JENJANG,
        "akreditasi": fake.random_element(AKREDITASI),
        "ipk": str(ipk),
        "graduationDate": date(TAHUN_LULUS, 6, 3).isoformat(),
        "gelar": "Sarjana Komputer",
        "gelarSingkat": "S.Kom.",
        "predikat": predikat_dari_ipk(ipk),
        "statusBlockchain": "pending",
        "_kelompok": kelompok,          # kolom bantu, hapus sebelum impor
    }


def main() -> None:
    students: list[dict] = []
    diplomas: list[dict] = []
    sid = dip_id = 1
    nim_counter = 1

    def nim_baru() -> str:
        nonlocal nim_counter
        n = f"{TAHUN_LULUS - 5}{str(nim_counter).zfill(4)}"
        nim_counter += 1
        return n

    # --- A. Alur penuh: NINA dikosongkan, diperoleh saat reservasi ---
    grup_a = []
    for _ in range(N_ALUR_PENUH):
        s = buat_mahasiswa(sid, nim_baru(), eligible=True)
        d = buat_ijazah(dip_id, s, None, "alur_penuh")
        students.append(s); diplomas.append(d); grup_a.append((s, d))
        sid += 1; dip_id += 1

    # --- B. Sapuan batch: NINA sudah terisi ---
    rincian_batch = []
    for size, repeats in BATCH_PLAN:
        for rep in range(1, repeats + 1):
            label = f"batch{size}_rep{rep}"
            for _ in range(size):
                s = buat_mahasiswa(sid, nim_baru(), eligible=True)
                # NINA DIKOSONGKAN. Versi sebelumnya mengisi NINA di sini
                # sebagai jalan pintas, tetapi itu menciptakan kondisi yang
                # mustahil di sistem nyata: SIAKAD memegang NINA yang tidak
                # pernah diterbitkan PISN, sehingga verifikasi dua lapis akan
                # menghasilkan "registri tidak ditemukan" untuk seluruh
                # kelompok batch. Kelompok ini kini menempuh reservasi, PDF,
                # enkripsi, dan unggah IPFS yang sama dengan alur penuh;
                # perbedaannya hanya pada pemanggilan mint kolektif.
                d = buat_ijazah(dip_id, s, None, label)
                students.append(s); diplomas.append(d)
                sid += 1; dip_id += 1
            rincian_batch.append({"ukuran": size, "pengulangan": rep, "label": label})

    # --- C. Tidak eligible ---
    for _ in range(N_INELIGIBLE):
        s = buat_mahasiswa(sid, nim_baru(), eligible=False)
        d = buat_ijazah(dip_id, s, None, "ineligible")
        students.append(s); diplomas.append(d)
        sid += 1; dip_id += 1

    # --- D. Kasus duplikat NIM: TIDAK di-seed ke basis data manapun ---
    # PENTING: record ini sebelumnya ditulis ke students.csv dan menyebabkan
    # cacat data. Kolom `nim` bersifat UNIQUE di SIAKAD sehingga record ditolak,
    # tetapi Mock PDDikti tidak punya constraint serupa sehingga record tetap
    # masuk. Akibatnya kedua subsistem memiliki pemilik berbeda untuk NIM yang
    # sama, dan NINA milik record duplikat ikut terpakai oleh mahasiswa asli.
    # Karena itu kasus duplikasi NIM hanya diterbitkan sebagai spesifikasi uji
    # tataran kontrak (berkas terpisah), bukan sebagai baris basis data.
    kasus_dup_nim = []
    for i in range(3):
        src_s, src_d = grup_a[i]
        kasus_dup_nim.append({
            "id_uji": f"F-DUP-NIM-SC-{i+1}",
            "nim_target": src_s["nim"],
            "pemilik_sah": src_s["name"],
            "nina_baru": buat_nina(9500 + i),
            "ekspektasi_aplikasi": "ditolak (unique constraint / validasi aplikasi)",
            "ekspektasi_kontrak": "diterima; token baru terbentuk (kontrak tidak memeriksa NIM)",
        })

    # --- E. Kasus duplikat NINA (tetap sebagai record) ---
    dup_notes = []
    for i in range(N_DUPLIKAT_NINA):
        src_s, src_d = grup_a[i]
        s = buat_mahasiswa(sid, nim_baru(), eligible=True)
        d = buat_ijazah(dip_id, s, "<SALIN_NINA_DARI_" + src_d["diplomaNumber"] + ">",
                        "duplikat_nina")
        students.append(s); diplomas.append(d)
        dup_notes.append({"diplomaNumber": d["diplomaNumber"], "jenis": "duplikat_nina",
                          "referensi": src_d["diplomaNumber"]})
        sid += 1; dip_id += 1

    # --- Tulis berkas ---
    with open("students.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(students[0].keys()))
        w.writeheader(); w.writerows(students)

    # diplomas.csv TIDAK LAGI di-seed ke basis data.
    # Pada alur asli, record ijazah dibuat oleh createDiploma() yang sekaligus
    # membangkitkan PDF. Menyuntikkannya lewat SQL berarti melewati pembuatan
    # PDF dan pencatatan log — persis penyebab record "Menunggu ACC" tanpa PDF.
    # Berkas ini kini berperan sebagai RENCANA INPUT: nilai yang akan dikirim
    # ke createDiploma() untuk tiap kredensial.
    # diplomaNumber sengaja dikosongkan karena dibangkitkan aplikasi.
    kolom_rencana = ["urutan", "_kelompok", "nim", "major", "jenjangPendidikan",
                     "akreditasi", "ipk", "graduationDate", "gelar",
                     "gelarSingkat", "predikat", "facultyId"]
    with open("diploma_plan.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=kolom_rencana)
        w.writeheader()
        for d in diplomas:
            s = next(x for x in students if x["id"] == d["studentId"])
            w.writerow({
                "urutan": d["id"], "_kelompok": d["_kelompok"], "nim": s["nim"],
                "major": d["major"], "jenjangPendidikan": d["jenjangPendidikan"],
                "akreditasi": d["akreditasi"], "ipk": d["ipk"],
                "graduationDate": d["graduationDate"], "gelar": d["gelar"],
                "gelarSingkat": d["gelarSingkat"], "predikat": d["predikat"],
                "facultyId": FACULTY_ID,
            })

    manifest = {
        "seed": SEED,
        "faker_locale": "id_ID",
        "kode_pt": KODE_PT,
        "jenjang": JENJANG,
        "tahun_lulus": TAHUN_LULUS,
        "format_nina": "[2 jenjang][6 kode PT][2 tahun][5 sequence]",
        "contoh_nina": buat_nina(4),
        "komposisi": {
            "alur_penuh": N_ALUR_PENUH,
            "sapuan_batch": sum(u * r for u, r in BATCH_PLAN),
            "tidak_eligible": N_INELIGIBLE,
            "duplikat_nina": N_DUPLIKAT_NINA,
            "duplikat_nim_uji_kontrak": 3,
            "total": len(students),
        },
        "rincian_batch": rincian_batch,
        "kasus_duplikat_nina": dup_notes,
        "kasus_duplikat_nim": kasus_dup_nim,
        "catatan": [
            "Kelompok batch menempuh alur yang sama dengan alur penuh; hanya mint yang kolektif.",
            "Ukuran batch 50 hanya satu pengulangan karena batas kapasitas penyematan IPFS.",
            "Seluruh NINA dikosongkan; semua diperoleh dari Mock PISN melalui alur reservasi.",
            "Kasus duplikat_nina memakai penanda placeholder; salin NINA aktual setelah reservasi.",
            "Kasus duplikasi NIM TIDAK di-seed ke basis data; lihat kasus_duplikat_nim dan uji langsung ke kontrak.",
            "Kolom _kelompok hanya penanda eksperimen, hapus sebelum impor ke basis data.",
        ],
    }
    with open("dataset_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"students.csv          : {len(students)} baris")
    print(f"diploma_plan.csv      : {len(diplomas)} baris (rencana input, bukan seed)")
    print(f"dataset_manifest.json : ditulis")
    print(f"\nContoh NINA batch     : {diplomas[N_ALUR_PENUH]['nina']}")


if __name__ == "__main__":
    main()
