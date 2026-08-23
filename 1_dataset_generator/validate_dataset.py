#!/usr/bin/env python3
"""
Validator dataset sintetis sebelum diimpor ke basis data.

Memeriksa students.csv dan diplomas.csv terhadap batasan skema Prisma
(panjang kolom, enum, presisi desimal, keunikan, integritas relasi) serta
konsistensi logis antar-kolom.

Pemakaian:
    python validate_dataset.py

Keluar dengan kode 0 bila lolos, 1 bila ada GAGAL.
"""

import csv
import sys
from collections import Counter
from datetime import date

ENUM_JK = {"L", "P"}
ENUM_PDDIKTI = {"unverified", "eligible", "ineligible"}
ENUM_MESIN = {"SIAP_DITERBITKAN", "DRAFT"}
ENUM_BLOCKCHAIN = {"pending", "verified", "revoked"}

gagal, peringatan = [], []


def cek(kondisi, pesan, keras=True):
    if not kondisi:
        (gagal if keras else peringatan).append(pesan)


def parse_tanggal(s):
    try:
        return date.fromisoformat(s)
    except Exception:
        return None


def desimal_muat(nilai, presisi, skala):
    """Cek apakah nilai muat di Decimal(presisi, skala)."""
    try:
        utuh, _, pecah = nilai.partition(".")
        return len(utuh.lstrip("-")) <= (presisi - skala) and len(pecah) <= skala
    except Exception:
        return False


def main():
    students = list(csv.DictReader(open("students.csv", encoding="utf-8")))
    diplomas = list(csv.DictReader(open("diploma_plan.csv", encoding="utf-8")))

    print(f"students.csv : {len(students)} baris")
    print(f"diploma_plan.csv : {len(diplomas)} baris\n")

    # ---------- STUDENTS ----------
    nims = [r["nim"] for r in students]
    dup_nim = {k: v for k, v in Counter(nims).items() if v > 1}
    cek(len(students) == 212, f"Jumlah student harus 212, ada {len(students)}")
    # NIM wajib unik: record duplikasi NIM sengaja TIDAK di-seed karena
    # menyebabkan ketidaksepakatan pemilik NIM antar-subsistem.
    cek(not dup_nim, f"NIM harus unik, ditemukan duplikat: {list(dup_nim)[:5]}")

    for r in students:
        sid = r["id"]
        cek(len(r["nim"]) <= 20, f"student {sid}: nim > 20 char")
        cek(0 < len(r["name"]) <= 255, f"student {sid}: name kosong / > 255 char")
        cek(0 < len(r["major"]) <= 255, f"student {sid}: major kosong / > 255 char")
        cek(r["jenisKelamin"] in ENUM_JK, f"student {sid}: jenisKelamin tidak valid")
        cek(r["pddiktiStatus"] in ENUM_PDDIKTI, f"student {sid}: pddiktiStatus tidak valid")
        cek(r["statusMesin"] in ENUM_MESIN, f"student {sid}: statusMesin tidak valid")
        cek(desimal_muat(r["ipk"], 4, 2), f"student {sid}: ipk tidak muat Decimal(4,2)")
        cek(parse_tanggal(r["tanggalLahir"]) is not None, f"student {sid}: tanggalLahir invalid")
        cek(parse_tanggal(r["tanggalSkYudisium"]) is not None, f"student {sid}: tglSkYudisium invalid")
        # Kondisi mentah: semua harus unverified + DRAFT.
        cek(r["pddiktiStatus"] == "unverified",
            f"student {sid}: kondisi awal harus unverified, bukan {r['pddiktiStatus']}")
        cek(r["statusMesin"] == "DRAFT",
            f"student {sid}: kondisi awal harus DRAFT, bukan {r['statusMesin']}")

    # ---------- RENCANA IJAZAH (input untuk createDiploma) ----------
    nim_ada = {r["nim"] for r in students}
    for r in diplomas:
        u = r["urutan"]
        cek(r["nim"] in nim_ada, f"rencana {u}: nim {r['nim']} tidak ada di students.csv")
        cek(desimal_muat(r["ipk"], 3, 2), f"rencana {u}: ipk tidak muat Decimal(3,2)")
        cek(0 < len(r["major"]) <= 255, f"rencana {u}: major kosong / > 255 char")
        g = parse_tanggal(r["graduationDate"])
        cek(g is not None, f"rencana {u}: graduationDate invalid")
        srec = next(s for s in students if s["nim"] == r["nim"])
        y = parse_tanggal(srec["tanggalSkYudisium"])
        if g and y:
            cek(g >= y, f"rencana {u}: graduationDate mendahului tanggalSkYudisium")

    urut = [r["urutan"] for r in diplomas]
    cek(len(set(urut)) == len(urut), "kolom urutan tidak unik")
    nims_plan = [r["nim"] for r in diplomas]
    cek(len(set(nims_plan)) == len(nims_plan), "satu NIM muncul lebih dari sekali di rencana")

    # ---------- RINGKASAN ----------
    komposisi = Counter(r.get("_kelompok", "?").split("_rep")[0] for r in diplomas)
    print("Komposisi kelompok (rencana input):")
    for k, val in sorted(komposisi.items()):
        print(f"  {k:16s} {val:>4d}")
    print("\nSeluruh mahasiswa berstatus unverified/DRAFT — kondisi mentah.")
    print("NINA tidak ada di dataset; seluruhnya dari reservasi Mock PISN.\n")

    if peringatan:
        print("PERINGATAN:")
        for p in peringatan[:20]:
            print("  !", p)
        print()

    if gagal:
        print(f"GAGAL — {len(gagal)} masalah ditemukan:")
        for g in gagal[:30]:
            print("  x", g)
        if len(gagal) > 30:
            print(f"  ... dan {len(gagal) - 30} lainnya")
        return 1

    print("LOLOS — dataset siap diimpor.")
    print("Ingat: hanya students.csv yang diimpor; diploma_plan.csv adalah input aplikasi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
