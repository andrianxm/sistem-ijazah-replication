# Lampiran Visual Pengujian Final

Seluruh PNG dibuat setelah eksekusi dari UI aktual atau dari log append-only dan
receipt transaksi aktual. Berkas HTML disertakan agar tabel bukti dapat dibuka,
dicetak, atau diekspor ulang tanpa menyalin data secara manual.

1. `01-F06-tidak-eligible-ui.png` — modal SIAKAD yang menunjukkan tidak ada
   mahasiswa eligible tanpa NINA; tombol pengajuan bernilai nol.
2. `02-DUP-NINA-ringkasan.png` — dua transaksi duplikat NINA dengan receipt 0,
   gas, hash transaksi, revert reason, dan `nextTokenId` tetap #1201.
3. `03-TAMPER-ringkasan.png` — enam CID hasil modifikasi dan jenis deteksi pada
   PDF/metadata dari uji tunggal, batch 5, dan batch 50.
4. `04-REKAP-negatif-final.png` — rekap F06 10/10, duplikat NINA 2/2, modifikasi
   artefak 6/6, dan dampaknya terhadap state.
5. `domain4-final-20260809/` — ringkasan matriks, latensi, cascading revoke,
   recovery timeout receipt RPC, enam screenshot SIVIL aktual (B1–B5 dan
   cascade), serta tiga screenshot form NIM duplikat.
6. `07-jejak-end-to-end-token-1002.png` — jejak faktual tujuh tahap otomatis
   NIM 20210002 dari log final: NINA, CID, TxHash, token #1002, latensi tiap
   tahap, dan keputusan akhir SIVIL. Versi HTML dengan nama dasar yang sama
   disertakan untuk audit dan pencetakan ulang.
7. `08-jejak-token-1002-paper-minimal.png` — versi ringkas 1600×470 untuk
   dimasukkan ke paper: satu alur horizontal, tiga bukti inti, dan satu catatan
   metodologis. Versi HTML disertakan dengan nama dasar yang sama.
8. `09-arsitektur-sistem-final.png` — diagram arsitektur sesuai implementasi:
   SIVIL meminta status on-chain melalui API SIA, SIA membaca dan menulis ke
   Polygon, receipt kembali ke SIA, sedangkan hubungan CID–IPFS ditampilkan
   sebagai referensi logis tanpa komunikasi langsung. SVG vektor dan HTML
   pendamping disertakan untuk penyuntingan serta ekspor ulang.

Berkas sumber visual nomor 2–4 adalah HTML dengan nama dasar yang sama. Skrip
reproduksi berada di `../../ambil-lampiran-final.cjs`.
Visual Domain 4 direproduksi oleh `../../ambil-lampiran-domain4-final.cjs`.
Visual rinci dan versi paper token #1002 direproduksi oleh
`../scripts/buat-visual-jejak-token-1002.cjs` dari CSV analisis dan raw di
dalam paket ini; skrip menolak membuat visual bila tujuh tahap tidak lengkap,
ada tahap non-pass, atau hasil akhir bukan token #1002 yang valid.
