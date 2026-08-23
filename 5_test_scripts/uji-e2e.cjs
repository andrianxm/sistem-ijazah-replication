/**
 * uji-e2e.cjs — eksperimen alur penuh end-to-end
 *
 * PRINSIP UTAMA
 * Skrip ini TIDAK PERNAH menulis ke basis data dan TIDAK PERNAH memanggil
 * kontrak secara langsung. Seluruh tahap dijalankan oleh server action yang
 * sama dengan yang dipakai antarmuka, melalui route /api/eksperimen dengan
 * sesi rektor yang sah. Skrip hanya mengurutkan pemanggilan dan mencatat log.
 *
 * ALUR PER KREDENSIAL
 *   1. laporDataMahasiswa      -> data masuk ke Mock PDDikti
 *   2. laporKelulusan          -> status menjadi eligible
 *   3. createPisnReservation   -> antrean reservasi NINA
 *   4. approve di Kementerian  -> NINA terbit  (HTTP ke Mock PISN)
 *   5. cekStatusPisn           -> NINA tersimpan di SIAKAD
 *   6. createDiploma           -> record ijazah + PDF (Puppeteer)
 *   7. prepareBatchMint        -> enkripsi + unggah IPFS, menghasilkan CID
 *   8. mintDiplomaToBlockchain -> transaksi mint, token terbit
 *
 * Pemakaian:
 *   node uji-e2e.cjs --kelompok alur_penuh --jumlah 30
 *   node uji-e2e.cjs --kelompok alur_penuh --mulai 2 --jumlah 29 --token-awal 1002
 *   node uji-e2e.cjs --kelompok ineligible --jumlah 10   (berhenti di tahap 3)
 *
 * Variabel lingkungan yang dibutuhkan:
 *   SIAKAD_URL       (default http://localhost:3000)
 *   PISN_URL         (default http://localhost:8000)
 *   REKTOR_EMAIL, REKTOR_PASSWORD
 */

const fs = require("fs");
const path = require("path");
const { mulai } = require("./experiment-logger.cjs");

const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const EMAIL = process.env.REKTOR_EMAIL;
const PASSWORD = process.env.REKTOR_PASSWORD;
const RENCANA = process.env.RENCANA || path.join(__dirname, "..", "pengujian", "diploma_plan.csv");
const PINATA_GATEWAY = (process.env.PINATA_GATEWAY || "")
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");
const SIVIL_PUBLIC_URL = (process.env.SIVIL_PUBLIC_URL || "http://localhost:8001").replace(/\/+$/, "");

let COOKIE = "";

class FatalCampaignError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalCampaignError";
  }
}

// ---------------------------------------------------------------- utilitas
function argv(nama, bawaan) {
  const i = process.argv.indexOf(`--${nama}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
}

function bacaCsv(berkas) {
  const baris = fs.readFileSync(berkas, "utf8").trim().split(/\r?\n/);
  const kolom = baris[0].split(",");
  return baris.slice(1).map((b) => {
    const nilai = b.split(",");
    return Object.fromEntries(kolom.map((k, i) => [k.trim(), (nilai[i] ?? "").trim()]));
  });
}

function ambilCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const potong = c.split(";")[0];
    if (/^(authjs|next-auth)\./.test(potong)) {
      const nama = potong.split("=")[0];
      COOKIE = COOKIE.split("; ").filter((x) => x && !x.startsWith(nama + "=")).concat(potong).join("; ");
    }
  }
}

// ------------------------------------------------------------------ login
async function login() {
  if (!EMAIL || !PASSWORD) throw new Error("REKTOR_EMAIL / REKTOR_PASSWORD belum diset");

  const csrfRes = await fetch(`${SIAKAD}/api/auth/csrf`);
  ambilCookie(csrfRes);
  const { csrfToken } = await csrfRes.json();

  const body = new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, redirect: "false" });
  const res = await fetch(`${SIAKAD}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: COOKIE },
    body,
    redirect: "manual",
  });
  ambilCookie(res);

  const cek = await (await fetch(`${SIAKAD}/api/eksperimen`, { headers: { Cookie: COOKIE } })).json();
  if (!cek.terautentikasi) throw new Error("Login gagal: sesi tidak terbentuk");
  if (cek.role !== "master") throw new Error(`Role harus master untuk mint, diperoleh: ${cek.role}`);
  console.log(`Login berhasil: ${cek.email} (role ${cek.role})\n`);
}

async function aksi(nama, params = {}) {
  const res = await fetch(`${SIAKAD}/api/eksperimen`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ aksi: nama, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${nama}: ${json.error}`);
  return json.hasil;
}

// -------------------------------------------------------------- pengaman
// Menghentikan eksekusi bila artefak tidak sah. Tanpa ini, CID palsu atau
// PDF yang tidak terbentuk akan lolos diam-diam sampai seluruh dataset habis.
async function pastikanArtefakSah({ cid, txHash, tokenId, pdfPath }) {
  if (cid !== undefined && !/^b[a-z2-7]{58}$/.test(cid))
    throw new Error(`CID tidak sah (bukan CIDv1 base32 59 karakter): ${cid}`);
  if (txHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(txHash))
    throw new Error(`TxHash tidak sah: ${txHash}`);
  if (tokenId !== undefined && !(Number(tokenId) > 0))
    throw new Error(`Token ID tidak sah: ${tokenId}`);

  if (cid !== undefined) {
    if (!PINATA_GATEWAY) throw new Error("PINATA_GATEWAY wajib diisi untuk memverifikasi CID nyata");
    const url = `https://${PINATA_GATEWAY}/ipfs/${cid}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`CID tidak dapat diambil dari gateway (HTTP ${res.status}): ${cid}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error(`CID menghasilkan artefak kosong: ${cid}`);
  }

  // PDF diperiksa lewat HTTP, bukan filesystem. Aplikasi berjalan di dalam
  // container sedangkan skrip di host, sehingga berkas tidak terlihat oleh
  // fs.existsSync kecuali direktori public di-mount. Pemeriksaan HTTP juga
  // membuktikan berkas benar-benar dapat diakses pengguna.
  if (pdfPath !== undefined) {
    if (!pdfPath) throw new Error("generatedImagePath kosong — PDF tidak terbentuk");
    const url = `${SIAKAD}/${String(pdfPath).replace(/^\//, "")}`;
    const res = await fetch(url, {
      method: "GET",
      headers: COOKIE ? { Cookie: COOKIE } : {},
    });
    if (!res.ok) throw new Error(`PDF tidak dapat diakses (HTTP ${res.status}): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error(`PDF terlalu kecil (${buf.length} byte): ${url}`);
    if (buf.subarray(0, 4).toString() !== "%PDF")
      throw new Error(`Berkas bukan PDF yang sah: ${url}`);
  }
}

async function verifikasiSivil(nina, nama, nim, tokenId) {
  const url = `${SIVIL_PUBLIC_URL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(nama)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const html = await res.text();
  if (!res.ok) throw new Error(`SIVIL gagal (HTTP ${res.status}) untuk ${nina}`);
  if (!/Data Terverifikasi/i.test(html)) throw new Error(`SIVIL tidak menyatakan Data Terverifikasi untuk ${nina}`);
  if (!html.includes(String(tokenId))) throw new Error(`SIVIL tidak menampilkan token #${tokenId}`);
  if (!html.includes(nim)) throw new Error(`SIVIL tidak menampilkan NIM ${nim}`);
  if (!html.includes(nama)) throw new Error(`SIVIL tidak menampilkan nama ${nama}`);
  return url;
}

// --------------------------------------------------------------- tahapan
async function approveNina(reservationId) {
  const res = await fetch(`${PISN}/api/pisn/approve/${reservationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`approve NINA gagal (HTTP ${res.status})`);
  return res.json();
}

async function prosesSatu(rencana, urutan, total, berhentiSetelahLaporData, runLabel, expectedTokenId) {
  const label = `[${urutan}/${total}] ${rencana.nim} (${rencana._kelompok})`;
  console.log(label);

  const daftarAwal = await aksi("getStudents", { query: rencana.nim });
  const mahasiswaAwal = daftarAwal.find((s) => s.nim === rencana.nim);
  if (!mahasiswaAwal) throw new Error("mahasiswa tidak ditemukan di SIAKAD");

  const dasar = {
    kelompok: rencana._kelompok,
    nim: rencana.nim,
    student_name: mahasiswaAwal.name,
    notes: `run=${runLabel}`,
  };
  let studentId, studentName, reservationId, nina, diplomaId;
  studentId = mahasiswaAwal.id;
  studentName = mahasiswaAwal.name;

  // --- 1. lapor data
  let r = mulai({ ...dasar, scenario_id: "F01", domain: "integrasi", expected: "data masuk PDDikti" });
  try {
    if (mahasiswaAwal.pddiktiStatus !== "unverified") {
      r.set({ sia_status: mahasiswaAwal.pddiktiStatus, notes: `run=${runLabel}; resume=already_reported` })
        .lulus("sudah tercatat di PDDikti");
    } else {
      const h = await aksi("laporDataMahasiswa", { studentId });
      if (!h.success) throw new Error(h.error);
      r.set({ sia_status: "dilaporkan" }).lulus("terkirim ke PDDikti");
    }
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log("  lapor data      : ok");

  if (berhentiSetelahLaporData) {
    // Kelompok ineligible: sengaja tidak lapor kelulusan, lalu reservasi
    // NINA diuji dan harus ditolak.
    r = mulai({ ...dasar, scenario_id: "F06", domain: "integrasi", expected: "reservasi ditolak" });
    let galatF06;
    try {
      const h = await aksi("createPisnReservation", { studentId });
      if (h.success) {
        throw new Error("SIAKAD melaporkan reservasi berhasil padahal mahasiswa belum lulus");
      } else {
        const antrean = await aksi("getPisnReservations", {});
        const reservasiLokal = antrean.find((x) => Number(x.student?.id) === Number(studentId));
        const mahasiswa = (await aksi("getStudents", { query: rencana.nim }))
          .find((x) => x.nim === rencana.nim);
        if (reservasiLokal) throw new Error(`reservasi lokal tetap terbentuk (ID ${reservasiLokal.id})`);
        if (mahasiswa?.statusMesin === "MENUNGGU_NINA") {
          throw new Error("statusMesin berubah menjadi MENUNGGU_NINA");
        }
        r.set({
          actual: "ditolak sebelum reservasi lokal dibuat",
          http_status: h.httpStatus || "",
          mock_pisn_status: "ditolak",
          sia_status: mahasiswa?.pddiktiStatus || "ineligible",
        }).gagal(new Error(h.error), { diharapkan: true });
      }
    } catch (e) {
      galatF06 = e;
      r.gagal(e);
    }
    await r.selesai();
    if (galatF06) throw galatF06;
    console.log("  reservasi       : ditolak (sesuai harapan)\n");
    return null;
  }

  // --- 2. lapor kelulusan
  r = mulai({ ...dasar, scenario_id: "F02", domain: "integrasi", expected: "status eligible" });
  try {
    if (mahasiswaAwal.pddiktiStatus === "eligible") {
      r.set({ mock_pisn_status: "eligible", notes: `run=${runLabel}; resume=already_eligible` }).lulus("eligible");
    } else {
      const h = await aksi("laporKelulusan", {
        studentId, ipk: Number(rencana.ipk),
        tanggalLulus: rencana.graduationDate,
        nomorSkYudisium: `SK-YUD/2026/${String(rencana.urutan).padStart(4, "0")}`,
        tanggalSkYudisium: "2026-05-20",
      });
      if (!h.success) throw new Error(h.error);
      r.set({ mock_pisn_status: "eligible" }).lulus("eligible");
    }
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log("  lapor lulus     : ok");

  // --- 3 & 4. reservasi + approve NINA
  r = mulai({ ...dasar, scenario_id: "F03", domain: "integrasi", expected: "NINA terbit" });
  try {
    if (mahasiswaAwal.nina) {
      nina = mahasiswaAwal.nina;
      const antrean = await aksi("getPisnReservations", {});
      const res = antrean.find((x) => Number(x.student?.id) === Number(studentId));
      reservationId = res ? Number(res.id) : undefined;
      r.set({ notes: `run=${runLabel}; resume=already_has_nina` });
    } else {
      const h = await aksi("createPisnReservation", { studentId });
      if (!h.success) throw new Error(h.error);
      const antrean = await aksi("getPisnReservations", {});
      const res = antrean.find((x) => Number(x.student?.id) === Number(studentId));
      if (!res) throw new Error("reservasi tidak ditemukan pada antrean");
      reservationId = Number(res.id);

      await approveNina(reservationId);
      const status = await aksi("cekStatusPisn", { reservationId });
      nina = status.nina;
    }
    if (!/^\d{15}$/.test(nina || "")) throw new Error(`NINA tidak sah: ${nina}`);
    r.set({ reservation_id: reservationId, nina, registry_status: "aktif" }).lulus(nina);
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log(`  NINA            : ${nina}`);

  // --- 5. buat ijazah + PDF
  r = mulai({ ...dasar, scenario_id: "F04", domain: "kriptografi", nina, expected: "PDF terbentuk" });
  try {
    let dips = await aksi("getDiplomas", { query: rencana.nim });
    let dip = dips.find((d) => d.student?.nim === rencana.nim);
    if (!dip) {
      const h = await aksi("createDiploma", {
        diplomaNumber: `IJZ-2026-${String(4100 + Number(rencana.urutan)).padStart(4, "0")}`,
        studentId, nina, major: rencana.major,
        jenjangPendidikan: rencana.jenjangPendidikan, akreditasi: rencana.akreditasi,
        ipk: rencana.ipk, graduationDate: rencana.graduationDate,
        gelar: rencana.gelar, gelarSingkat: rencana.gelarSingkat,
        predikat: rencana.predikat, facultyId: rencana.facultyId,
      });
      if (!h.success) throw new Error(h.error);
      dips = await aksi("getDiplomas", { query: rencana.nim });
      dip = dips.find((d) => d.student?.nim === rencana.nim);
    } else {
      r.set({ notes: `run=${runLabel}; resume=existing_diploma` });
    }
    if (!dip) throw new Error("ijazah tidak ditemukan setelah dibuat");
    diplomaId = dip.id;
    await pastikanArtefakSah({ pdfPath: dip.generatedImagePath });
    r.set({ notes: `run=${runLabel}; pdf=${dip.generatedImagePath}` }).lulus("PDF terbentuk");
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log("  PDF             : ok");

  // --- 6. enkripsi + unggah IPFS
  r = mulai({ ...dasar, scenario_id: "F05", domain: "kriptografi", nina, expected: "CID diperoleh" });
  let cid;
  try {
    const h = await aksi("prepareBatchMint", { diplomaIds: [diplomaId] });
    if (!h.success) throw new Error(h.error);
    cid = h.cidList?.[0];
    await pastikanArtefakSah({ cid });
    r.set({ cid }).lulus(cid);
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log(`  IPFS CID        : ${cid}`);

  // --- 7. mint
  r = mulai({ ...dasar, scenario_id: "F07", domain: "smart_contract", nina, expected: "token terbit" });
  let mintedTokenId;
  try {
    const dips = await aksi("getDiplomas", { query: rencana.nim });
    const currentDip = dips.find((d) => d.student?.nim === rencana.nim);
    if (currentDip?.statusBlockchain === "verified" && currentDip.tokenId && currentDip.txHash) {
      await pastikanArtefakSah({ txHash: currentDip.txHash, tokenId: currentDip.tokenId });
      if (expectedTokenId !== undefined && Number(currentDip.tokenId) !== Number(expectedTokenId)) {
        throw new FatalCampaignError(`Token existing tidak sesuai urutan: diharapkan #${expectedTokenId}, diperoleh #${currentDip.tokenId}`);
      }
      mintedTokenId = Number(currentDip.tokenId);
      r.set({ tx_hash: currentDip.txHash, token_id: currentDip.tokenId, cid, blockchain_status: "aktif", notes: `run=${runLabel}; resume=already_minted` })
        .lulus(`token ${currentDip.tokenId}`);
      console.log(`  mint            : token #${currentDip.tokenId} (sudah ada)\n`);
    } else {
      const h = await aksi("mintDiplomaToBlockchain", { diplomaId });
      if (!h.success) throw new Error(h.error);
      try {
        await pastikanArtefakSah({ txHash: h.txHash, tokenId: h.tokenId });
        if (expectedTokenId !== undefined && Number(h.tokenId) !== Number(expectedTokenId)) {
          throw new Error(`Urutan token salah: diharapkan #${expectedTokenId}, diperoleh #${h.tokenId}`);
        }
      } catch (error) {
        throw new FatalCampaignError(`Mint telah dilaporkan sukses tetapi verifikasi gagal: ${error.message}`);
      }
      mintedTokenId = Number(h.tokenId);
      r.set({ tx_hash: h.txHash, token_id: h.tokenId, cid, blockchain_status: "aktif" })
       .lulus(`token ${h.tokenId}`);
      console.log(`  mint            : token #${h.tokenId}  tx ${h.txHash.slice(0, 12)}...\n`);
    }
  } catch (e) {
    const fatal = e instanceof FatalCampaignError
      ? e
      : new FatalCampaignError(`Status mint tidak boleh dilanjutkan tanpa rekonsiliasi: ${e.message}`);
    r.gagal(fatal);
    await r.selesai();
    throw fatal;
  }
  await r.selesai();

  r = mulai({ ...dasar, scenario_id: "F08", domain: "verifikasi", nina, expected: "valid" });
  try {
    const sivilUrl = await verifikasiSivil(nina, studentName, rencana.nim, mintedTokenId);
    r.set({ student_name: studentName, token_id: mintedTokenId, cid, final_verification: "valid", verification_mode: "live", notes: `run=${runLabel}; sivil=${sivilUrl}` })
      .lulus("valid");
  } catch (e) { r.gagal(e); await r.selesai(); throw e; }
  await r.selesai();
  console.log("  verifikasi SIVIL: valid\n");

  return mintedTokenId;
}

// ------------------------------------------------------------------ main
(async () => {
  const kelompok = argv("kelompok", "alur_penuh");
  const jumlah = Number(argv("jumlah", "30"));
  const mulaiDari = Number(argv("mulai", "1"));
  let expectedTokenId = Number(argv("token-awal", "0")) || undefined;
  const runLabel = argv("run", new Date().toISOString().replace(/[:.]/g, "-"));
  const berhenti = kelompok === "ineligible";

  if (!Number.isInteger(mulaiDari) || mulaiDari < 1) throw new Error("--mulai harus bilangan bulat minimal 1");
  if (!Number.isInteger(jumlah) || jumlah < 1) throw new Error("--jumlah harus bilangan bulat minimal 1");

  const rencana = bacaCsv(RENCANA)
    .filter((r) => r._kelompok === kelompok || r._kelompok.startsWith(kelompok))
    .slice(mulaiDari - 1, mulaiDari - 1 + jumlah);

  if (!rencana.length) throw new Error(`Tidak ada rencana untuk kelompok "${kelompok}"`);

  console.log(`Kelompok : ${kelompok}`);
  console.log(`Mulai    : ${mulaiDari}`);
  console.log(`Jumlah   : ${rencana.length}\n`);
  console.log(`Run      : ${runLabel}\n`);

  await login();

  let ok = 0, gagal = 0, gagalBeruntun = 0;
  for (let i = 0; i < rencana.length; i++) {
    try {
      const tokenId = await prosesSatu(rencana[i], i + 1, rencana.length, berhenti, runLabel, expectedTokenId);
      if (tokenId !== null && tokenId !== undefined) expectedTokenId = Number(tokenId) + 1;
      ok++;
      gagalBeruntun = 0;
    } catch (e) {
      gagal++;
      gagalBeruntun++;
      console.error(`  BERHENTI: ${e.message}\n`);
      if (e instanceof FatalCampaignError) {
        console.error("Kampanye dihentikan: state mint harus direkonsiliasi sebelum lanjut.");
        break;
      }
      if (gagalBeruntun >= 3) {
        console.error("Tiga kegagalan berturut-turut. Eksekusi dihentikan agar dataset tidak terbakar.");
        break;
      }
    }
  }

  console.log(`\nSelesai — berhasil ${ok}, gagal ${gagal}`);
  console.log("Ringkasan log: node experiment-logger.cjs");
})().catch((e) => {
  console.error("Kesalahan fatal:", e.message);
  process.exit(1);
});
