# Replication Package: Verifikasi Ijazah Dua Lapis (Dual-Layer) berbasis Blockchain dan Registri Nasional

Repositori ini merupakan **Replication Package** resmi untuk penelitian skripsi yang mengusulkan arsitektur *dual-layer* (registri terpusat + *smart contract* blockchain) guna memitigasi celah *stale state* (kegagalan sinkronisasi) pada pencabutan ijazah elektronik di Indonesia.

## 1. Kode Sumber Subsistem (Tautan Eksternal)
Sesuai dengan arsitektur mikrolayanan yang disimulasikan, kode sumber untuk ketiga subsistem utama dipisahkan ke dalam repositori GitHub masing-masing. Silakan kloning (*clone*) repositori berikut untuk menjalankan subsistem:

1. **SIA Simulasi (Kampus)**: [https://github.com/andrianxm/sistem-ijazah-sia](https://github.com/andrianxm/sistem-ijazah-sia)
2. **PDDikti / PISN Mock (Kementerian)**: [https://github.com/andrianxm/sistem-ijazah-pddikti-pisn](https://github.com/andrianxm/sistem-ijazah-pddikti-pisn)
3. **SIVIL Simulasi (Verifikator Nasional)**: [https://github.com/andrianxm/sistem-ijazah-sivil](https://github.com/andrianxm/sistem-ijazah-sivil)

*(Catatan Reproduktibilitas: Pastikan Anda berada di commit hash yang tercantum pada Tabel 2 di naskah publikasi untuk menjamin hasil yang identik).*

## 2. Struktur Direktori Replication Package Ini
Repositori ini difokuskan untuk menyediakan data mentah (*raw data*), generator, kontrak pintar, dan alat replikasi metrik pengukuran.

### 📁 `1_dataset_generator`
Berisi skrip `.sql` untuk membangkitkan data (*seeding*) dengan *seed* tetap (*fixed seed*). Ini menjamin bahwa setiap kali pengujian diulang, data mahasiswa dan Nomor Ijazah Nasional (NINA) yang digunakan selalu persis sama dengan yang ada di dalam naskah.

### 📁 `2_smart_contract`
Berisi proyek *Hardhat* dan kode sumber Solidity (`IjazahNFT.sol`) yang dide-deploy ke jaringan Polygon Amoy. Termasuk skrip konfigurasi dan mekanisme akses *Role-Based Access Control* (RBAC) untuk otoritas penerbit (Rektor).

### 📁 `3_raw_measurements`
Menyediakan bukti terukur (*empirical evidence*) dari pengujian yang dibahas dalam naskah:
*   `latency_raw.csv`: Data mentah untuk waktu pemrosesan penerbitan (Tabel 5 & 6) dan pemrosesan verifikasi (Tabel 7).
*   `14_cascading_revoke_final_10.csv`: Data hasil pengujian injeksi kegagalan (Tabel 8). Bukti empiris mengenai ancaman *stale state* pada pencabutan ijazah (`REV-SYNCFAIL`).
*   `matrix-latency-results.csv`: Metrik latensi tambahan dan hasil dari *Decision Matrix*.
*   `08_modifikasi_artefak_6_kasus.csv`: Bukti hasil deteksi modifikasi artefak (Bab 3.2), menguji integritas dekripsi dan *plaintext-hash mismatch*.

### 📁 `4_plotting_scripts`
Berisi skrip Python (menggunakan `matplotlib` dan `pandas`) yang digunakan untuk mengonversi data dari folder `3_raw_measurements` menjadi grafik yang dipublikasikan di dalam naskah (misalnya `plot_figure5_latency.py`).

---

## 🚀 Cara Menjalankan Ulang Pengujian

1. **Deploy Smart Contract**: Masuk ke folder `2_smart_contract`, lakukan instalasi dependensi (`npm install`), isi `.env` dengan *private key*, dan jalankan skrip *deploy* Hardhat ke jaringan Polygon Amoy.
2. **Setup Database & Seed**: Jalankan MySQL/PostgreSQL dan impor berkas SQL dari `1_dataset_generator` ke *database* masing-masing subsistem.
3. **Jalankan Subsistem**: *Clone* ketiga repositori subsistem dari tautan di atas. Jalankan `sia-simulasi` (Port 3000), `mock-pddikti-pisn` (Port 8000), dan `sivil-simulasi` (Port 8001).
4. **Validasi Metrik**: Jalankan skrip Python di folder `4_plotting_scripts` dengan merujuk ke data di folder `3_raw_measurements` untuk menghasilkan grafik latensi secara mandiri.
