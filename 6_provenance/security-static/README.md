# Artefak Keamanan Statis Final

Direktori ini memuat artefak asli analisis Slither terhadap sumber kontrak yang
digunakan pada kampanye final:

- `IjazahNFT.sol`: sumber kontrak; salinan byte-for-byte dari direktori analisis.
- `settings.json`: optimizer aktif dengan 200 runs.
- `slither-report.json`: laporan mentah Slither dengan `success=true`.
- `versions.txt`: keluaran versi Slither, Solc, solc-select, serta provenance
  OpenZeppelin Contracts 5.6.0.

`slither-report.json` menyimpan keluaran detector untuk kontrak dan dependensi
OpenZeppelin. Jumlah entri detector tidak boleh langsung ditafsirkan sebagai
jumlah kerentanan tanpa klasifikasi terhadap sumber dan konteks setiap temuan.

Uji dinamis RBAC dan penolakan transfer memang tidak tercakup oleh laporan
statis ini. Keduanya telah dijalankan terpisah sebagai transaksi nyata dan
tersedia pada `../20_smart_contract_negatif_final_2.csv` serta
`../raw/09-smart-contract-negative/`.
