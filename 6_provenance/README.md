# Petunjuk Analisis Inti

Folder ini adalah paket mandiri final. Dua puluh CSV pada akar folder digunakan
untuk perhitungan; bukti mentah, checkpoint, skrip reproduksi, dan
artefak keamanan ditempatkan pada subdirektori terpisah.

## Urutan yang disarankan

1. Mulai dari `01_ringkasan_hasil.csv`.
2. Gunakan `03_alur_fungsional_207_attempt.csv` untuk SCR langkah dan latensi.
3. Gunakan `04_batch_detail_10_run.csv` untuk statistik per repetisi dan
   `05_batch_agregat_per_ukuran.csv` untuk ringkasan ukuran batch.
4. Gunakan file 06–08 dan 16 untuk pengujian negatif.
5. Gunakan file 11–17 untuk latensi, matriks keputusan, dan SCR-revoke.
6. Bandingkan `10_snapshot_212_mahasiswa.csv` (setelah penerbitan) dengan
   `18_snapshot_pasca_domain4_final_212.csv` (setelah mutasi Domain 4).
7. Gunakan file 19 untuk receipt dan gas seluruh transaksi revoke final.
8. Gunakan file 20 untuk dua transaksi negatif smart contract: RBAC dan
   penolakan transfer.

## Aturan perhitungan

- `analysis_role=final_first_pass` dipakai untuk SCR first pass.
- `analysis_role=final_with_recovery` dipakai untuk SCR eventual.
- Receipt 0 pada duplikat NINA adalah PASS karena transaksi memang diharapkan
  direvert.
- Receipt 0 pada file 20 juga merupakan PASS: revert RBAC dan transfer sesuai
  aturan kontrak, sementara state sebelum–sesudah tetap sama.
- Kelompok gangguan SIVIL memiliki strict first-attempt 0/5 secara disengaja;
  metrik keselamatan dan SCR-revoke eventual masing-masing 10/10.
- Kasus timeout receipt RPC pada file 15 adalah auxiliary dan tidak masuk
  denominator inti cascading revoke n=10.
- Mahasiswa pada filter Lulus Terbit Ijazah ditentukan oleh diploma
  `statusBlockchain=verified`; `statusMesin=SIAP_DITERBITKAN` bukan kegagalan.

## Batas cakupan

Folder ini hanya memuat kampanye kontrak dan dataset final. Matriks verifikasi,
uji NIM duplikat aplikasi, serta V01 yang lama tetap dikecualikan; file 11–20
berasal dari pengujian ulang current-final dengan run marker baru.

Semua CSV memakai UTF-8, delimiter koma, dan header pada baris pertama.

## Paket mandiri lengkap

Folder ini sekarang merupakan satu-satunya folder yang diperlukan untuk
analisis dan audit pengujian final:

- `01_...csv` sampai `20_...csv`: tabel siap hitung dan siap impor.
- `raw/`: 43 file sumber mentah current-final yang disalin byte-for-byte.
- `RAW_MANIFEST.csv`: pemetaan sumber → salinan beserta dua SHA-256.
- `EXCLUDED.md`: mendokumentasikan lampiran UI, visualisasi hasil, jejak token, dan diagram arsitektur yang sengaja dikeluarkan dari paket rilis publik.
- `scripts/`: skrip pengujian, recovery, dan builder.
- `security-static/`: sumber kontrak, settings compiler, laporan mentah Slither,
  dan rekaman versi toolchain final.
- `CODE_VERSION.txt`: hash commit dan tree Git final untuk SIA, SIVIL, dan
  mock PDDIKTI/PISN; nilai yang sama juga direkam secara terstruktur dalam
  `PROVENANCE_FINAL.json`.
- `FILE_MANIFEST.csv`: daftar seluruh berkas di dalam paket.
- `checksums.sha256`: checksum seluruh isi paket kecuali file checksum itu sendiri.

### Aturan penggunaan raw

Gunakan `analysis_role` pada `RAW_MANIFEST.csv`. Kegagalan startup dan
recovery timeout receipt adalah bukti dari kampanye final, bukan data lama.
Keduanya disertakan agar audit tidak hanya berisi kasus sukses, tetapi tidak
dimasukkan ke denominator inti kecuali dinyatakan eksplisit pada file analisis.

Paket historis `paket-analisis-final-20260809/`, log global
`experiment_logs.csv`, dan run pengembangan `fullflow-auto29-r1` tidak ada
di dalam folder ini.

