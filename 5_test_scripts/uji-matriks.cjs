/**
 * uji-matriks.cjs — matriks verifikasi dua lapis + latensi verifikasi
 *
 * URUTAN FASE (penting, jangan ditukar):
 *   Fase 1  Latensi verifikasi pada kondisi bersih (>=30 pengulangan)
 *   Fase 2  Membangun state tidak sinkron untuk baris 2, 3, 4
 *   Fase 3  Menguji seluruh baris matriks dan mencatat keputusannya
 *
 * Latensi diukur lebih dulu karena Fase 2 merusak sebagian kredensial;
 * mengukur setelahnya akan mencemari distribusi dengan kondisi invalid
 * yang jalur eksekusinya lebih pendek.
 *
 * MANIPULASI STATE PADA FASE 2 DISENGAJA DAN TERDOKUMENTASI.
 * Kondisi "registri dan blockchain tidak sepakat" tidak dapat dicapai
 * melalui alur normal, sehingga harus dibangun secara sengaja. Setiap
 * manipulasi dicatat pada log dengan scenario_id tersendiri.
 *
 * Pemakaian:
 *   export REKTOR_PRIVATE_KEY=...        # WAJIB, tidak ada nilai bawaan
 *   export SIVIL_URL=http://localhost:8001
 *   export CONTRACT_ADDRESS_IJAZAH=<alamat-kontrak-eksperimen>
 *   export POLYGON_RPC_URL=https://polygon-amoy.drpc.org
 *   node uji-matriks.cjs --fase 1        # latensi saja
 *   node uji-matriks.cjs --fase 2        # bangun state
 *   node uji-matriks.cjs --fase 3        # uji matriks
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ethers } = require("ethers");
const { mulai } = require("./experiment-logger.cjs");

// Muat konfigurasi aplikasi tanpa menimpa variabel yang diberikan eksplisit
// pada command line. Nilai rahasia tidak pernah dicetak ke log.
const ENV_FILE = process.env.MATRIX_ENV || path.join(__dirname, "..", "sia-simulasi", ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const SIAKAD = process.env.SIAKAD_URL || "http://localhost:3000";
const SIVIL = process.env.SIVIL_URL || "http://localhost:8001";
const PISN = process.env.PISN_URL || "http://localhost:8000";
const RPC = process.env.POLYGON_RPC_URL || "https://polygon-amoy.drpc.org";
const CONTRACT = process.env.CONTRACT_ADDRESS_IJAZAH;
const CONTRACT_BACA = CONTRACT;
const PRIVKEY = process.env.REKTOR_PRIVATE_KEY;
const EMAIL = process.env.REKTOR_EMAIL;
const PASSWORD = process.env.REKTOR_PASSWORD;
const MYSQL = process.env.MYSQL_CONTAINER || "ijazah-mysql";
const ULANG = Number(process.env.ULANG || 30);
const B5_NIM = process.env.B5_NIM || "20210211";
// Penanda eksekusi. Disisipkan ke kolom notes setiap baris agar hasil dari
// beberapa kali menjalankan fase yang sama dapat dibedakan saat analisis,
// tanpa perlu menyunting log yang sudah tertulis.
const RUN = process.argv.includes("--run")
  ? process.argv[process.argv.indexOf("--run") + 1]
  : new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

// Alokasi kredensial per baris matriks. Kredensial pada baris 2-4 akan
// rusak secara permanen oleh manipulasi, jadi tidak boleh dipakai ulang.
const ALOKASI = {
  baris2_bc_revoked:   ["20210003", "20210004", "20210005"],
  baris3_reg_revoked:  ["20210006", "20210007", "20210008"],
  baris4_reg_hilang:   ["20210009", "20210010", "20210012"],
};

let COOKIE = "";

// ------------------------------------------------------------ utilitas
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

function sql(db, query) {
  const cmd = `docker exec -i ${MYSQL} mysql -u root -ppassword ${db} -N -B -e ${JSON.stringify(query)}`;
  const keluaran = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  // Klien mysql dapat menyisipkan baris informatif seperti
  // "PAGER set to stdout" atau peringatan penggunaan kata sandi. Baris
  // semacam itu pernah terbaca sebagai data dan menghasilkan dua kasus uji
  // semu, sehingga disaring di sini.
  return keluaran
    .split("\n")
    .filter((b) => b.trim() && !/^(PAGER|mysql:|Warning|Logging to)/i.test(b.trim()))
    .join("\n")
    .trim();
}

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error("REKTOR_EMAIL / REKTOR_PASSWORD belum diset");
  const c = await fetch(`${SIAKAD}/api/auth/csrf`);
  for (const ck of c.headers.getSetCookie?.() ?? []) {
    const p = ck.split(";")[0];
    if (/^(authjs|next-auth)\./.test(p)) {
      const nama = p.split("=")[0];
      COOKIE = COOKIE.split("; ").filter((x) => x && !x.startsWith(nama + "=")).concat(p).join("; ");
    }
  }
  const { csrfToken } = await c.json();
  const r = await fetch(`${SIAKAD}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: COOKIE },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, redirect: "false" }),
    redirect: "manual",
  });
  for (const ck of r.headers.getSetCookie?.() ?? []) {
    const p = ck.split(";")[0];
    if (/^(authjs|next-auth)\./.test(p)) {
      const nama = p.split("=")[0];
      COOKIE = COOKIE.split("; ").filter((x) => x && !x.startsWith(nama + "=")).concat(p).join("; ");
    }
  }
  const cek = await (await fetch(`${SIAKAD}/api/eksperimen`, { headers: { Cookie: COOKIE } })).json();
  if (!cek.terautentikasi) throw new Error("Login gagal");
  console.log(`Login: ${cek.email} (${cek.role})\n`);
}

async function aksi(nama, params = {}) {
  const res = await fetch(`${SIAKAD}/api/eksperimen`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ aksi: nama, params }),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`${nama}: ${j.error}`);
  return j.hasil;
}

/** Daftar kredensial ter-mint beserta NINA, token, dan nama pemiliknya. */
async function daftarKredensial() {
  const dips = await aksi("getDiplomas", {});
  return dips
    .filter((d) => d.nina && d.tokenId)
    .map((d) => ({
      nim: d.student?.nim, nama: d.student?.name,
      nina: d.nina, tokenId: Number(d.tokenId),
    }));
}

// -------------------------------------------------- verifikasi ke SIVIL
/**
 * Memanggil portal verifikasi SIVIL. Header X-Test-Mode melewati rate
 * limiter publik sesuai pengecualian yang ditetapkan pada Subbagian 3.3.
 * Latensi yang dikembalikan adalah latensi sisi peladen: registri +
 * penerusan ke SIA + pemanggilan RPC + penggabungan keputusan.
 */
async function verifikasi(nina, nama) {
  const url = `${SIVIL}/verifikasi?nina=${encodeURIComponent(nina)}&nama=${encodeURIComponent(nama)}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { "X-Test-Mode": "1" } });
  const html = await res.text();
  const ms = Date.now() - t0;

  // Keputusan dibaca dari variabel yang diinjeksi peladen ke dalam skrip
  // halaman, BUKAN dari teks yang tampil. Alasannya: berkas Blade memuat
  // fungsi showModal() yang mengandung seluruh varian literal keputusan
  // ("Data Terverifikasi", "Ijazah Dibatalkan"), sehingga pencocokan teks
  // mentah dapat memberi hasil positif palsu.
  const mIsValid = /const\s+isValid\s*=\s*(true|false)/.exec(html);
  const mSivil = /const\s+sivilStatus\s*=\s*['"]([^'"]*)['"]/.exec(html);
  const mBc = /const\s+blockchainData\s*=\s*(\{[^\n]*\})/.exec(html);

  if (!mIsValid) {
    throw new Error("Variabel isValid tidak ditemukan pada respons — penanda deteksi perlu disesuaikan");
  }

  const isValid = mIsValid[1] === "true";
  const sivilStatus = mSivil ? mSivil[1] : "";
  let bcAktif = null;
  try { bcAktif = mBc ? JSON.parse(mBc[1])?.is_active ?? null : null; } catch (_) {}

  const luring = /luring|fallback|offline/i.test(html);

  let keputusan;
  if (isValid) keputusan = "valid";
  else if (sivilStatus === "revoked") keputusan = "tidak valid (registri revoked)";
  else if (bcAktif === false) keputusan = "tidak valid (token revoked)";
  else if (!sivilStatus || sivilStatus === "not_found") keputusan = "tidak valid (registri tidak ditemukan)";
  else if (sivilStatus === "found" && bcAktif === null) keputusan = "tidak valid (token tidak ditemukan)";
  else keputusan = `tidak valid (${sivilStatus})`;

  return { keputusan, sivilStatus, bcAktif, ms, http: res.status, mode: luring ? "fallback" : "live" };
}

// ------------------------------------------------------------- FASE 1
async function fase1() {
  console.log(`FASE 1 — latensi verifikasi, ${ULANG} pengulangan\n`);
  const kredensial = await daftarKredensial();
  if (!kredensial.length) throw new Error("Tidak ada kredensial ter-mint");

  // Hindari kredensial yang akan dirusak pada Fase 2.
  const dipakai = Object.values(ALOKASI).flat();
  const bersih = kredensial.filter((k) => !dipakai.includes(k.nim));
  console.log(`Kredensial bersih tersedia: ${bersih.length}\n`);

  const latensi = [];
  let luring = 0;
  for (let i = 0; i < ULANG; i++) {
    const k = bersih[i % bersih.length];
    const r = mulai({
      scenario_id: "V01", domain: "verifikasi", kelompok: "alur_penuh",
      nim: k.nim, nina: k.nina, expected: "valid",
      verification_mode: "", notes: `run=${RUN}; latensi kondisi normal`,
    });
    try {
      const v = await verifikasi(k.nina, k.nama);
      r.set({
        registry_status: "aktif", blockchain_status: "aktif",
        final_verification: v.keputusan, verification_mode: v.mode,
        token_id: k.tokenId, http_status: v.http,
      });
      if (v.mode === "fallback") luring++;
      else latensi.push(v.ms);
      r.set({ notes: `run=${RUN}; sivilStatus=${v.sivilStatus}` });
      v.keputusan === "valid" ? r.lulus(v.keputusan) : r.gagal(new Error(v.keputusan));
    } catch (e) { r.gagal(e); }
    await r.selesai();
    process.stdout.write(`\r  ${i + 1}/${ULANG}`);
  }

  latensi.sort((a, b) => a - b);
  const p = (q) => latensi[Math.min(latensi.length - 1, Math.floor(latensi.length * q))];
  console.log(`\n\nEksekusi daring : ${latensi.length}`);
  console.log(`Mode luring     : ${luring}  (dikecualikan dari statistik)`);
  if (latensi.length) {
    console.log(`median          : ${p(0.5)} ms`);
    console.log(`IQR             : ${p(0.25)} - ${p(0.75)} ms`);
    console.log(`min - maks      : ${latensi[0]} - ${latensi[latensi.length - 1]} ms`);
    console.log(`p95             : ${p(0.95)} ms`);
  }
}

// -------------------------------------------------------- PERSIAPAN B5
/**
 * Membentuk registri aktif tanpa token dengan alur aplikasi sampai NINA terbit,
 * lalu berhenti sebelum createDiploma/PDF/IPFS/mint. Tahap ini tidak menambah pin.
 */
async function faseB5() {
  if (!CONTRACT_BACA) throw new Error("CONTRACT_ADDRESS_IJAZAH belum diset");
  console.log(`PERSIAPAN B5 — NIM ${B5_NIM}, berhenti setelah NINA\n`);

  let student = (await aksi("getStudents", { query: B5_NIM })).find((x) => x.nim === B5_NIM);
  if (!student) throw new Error(`Mahasiswa ${B5_NIM} tidak ditemukan`);
  const diploma = (await aksi("getDiplomas", { query: B5_NIM })).find((x) => x.student?.nim === B5_NIM);
  if (diploma?.tokenId || diploma?.ipfsHash || diploma?.ipfsJsonHash) {
    throw new Error(`${B5_NIM} sudah memiliki token/CID sehingga tidak sah untuk B5`);
  }

  const r = mulai({
    scenario_id: "V-SETUP-B5", domain: "verifikasi", nim: B5_NIM,
    expected: "registri aktif, token tidak ditemukan, tanpa pin",
    notes: `run=${RUN}; alur dihentikan setelah NINA sebelum PDF/IPFS/mint`,
  });
  try {
    if (student.pddiktiStatus === "unverified") {
      const hasil = await aksi("laporDataMahasiswa", { studentId: student.id });
      if (!hasil.success) throw new Error(hasil.error);
      student = (await aksi("getStudents", { query: B5_NIM })).find((x) => x.nim === B5_NIM);
    }
    if (student.pddiktiStatus !== "eligible") {
      const hasil = await aksi("laporKelulusan", {
        studentId: student.id, ipk: 3.90, tanggalLulus: "2026-06-03",
        nomorSkYudisium: "SK-YUD/2026/0211", tanggalSkYudisium: "2026-05-20",
      });
      if (!hasil.success) throw new Error(hasil.error);
    }

    let antrean = await aksi("getPisnReservations", {});
    let reservasi = antrean.find((x) => Number(x.student?.id) === Number(student.id));
    if (!reservasi) {
      const hasil = await aksi("createPisnReservation", { studentId: student.id });
      if (!hasil.success) throw new Error(hasil.error);
      antrean = await aksi("getPisnReservations", {});
      reservasi = antrean.find((x) => Number(x.student?.id) === Number(student.id));
    }
    if (!reservasi) throw new Error("Reservasi B5 tidak ditemukan setelah dibuat");

    let nina = reservasi.nina || student.nina;
    if (!nina) {
      const approve = await fetch(`${PISN}/api/pisn/approve/${reservasi.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      if (!approve.ok) throw new Error(`approve NINA gagal (HTTP ${approve.status})`);
      const status = await aksi("cekStatusPisn", { reservationId: Number(reservasi.id) });
      nina = status.nina;
    }
    if (!/^\d{15}$/.test(nina || "")) throw new Error(`NINA B5 tidak sah: ${nina}`);

    const registry = sql("sivil_db", `SELECT status FROM sivil_nina_registry WHERE nina='${nina}' LIMIT 1;`);
    if (registry !== "aktif") throw new Error(`Registri B5 tidak aktif: ${registry || "tidak ditemukan"}`);
    const contract = new ethers.Contract(
      CONTRACT_BACA,
      ["function getTokenIdByHashedNina(bytes32) view returns(uint256)"],
      new ethers.JsonRpcProvider(RPC),
    );
    const token = await contract.getTokenIdByHashedNina(ethers.keccak256(ethers.toUtf8Bytes(nina)));
    if (token !== 0n) throw new Error(`Premis B5 gagal: NINA memetakan token #${token}`);

    r.set({
      nina, student_name: student.name, reservation_id: reservasi.id,
      registry_status: "aktif", blockchain_status: "tidak ditemukan",
      actual: "NINA aktif; token 0; diploma/CID tidak dibentuk",
    }).lulus("B5 siap tanpa pin");
    console.log(`B5 siap: ${B5_NIM} -> ${nina}; token=0; pin=0`);
  } catch (e) {
    r.gagal(e);
    throw e;
  } finally {
    await r.selesai();
  }
}

// ------------------------------------------------------------- FASE 2
async function fase2() {
  console.log("FASE 2 — membangun state tidak sinkron\n");
  if (!PRIVKEY) throw new Error("REKTOR_PRIVATE_KEY belum diset");
  if (!CONTRACT) throw new Error("CONTRACT_ADDRESS_IJAZAH belum diset");

  const kredensial = await daftarKredensial();
  const cari = (nim) => kredensial.find((k) => k.nim === nim);

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PRIVKEY, provider);
  const kontrak = new ethers.Contract(
    CONTRACT,
    ["function revokeIjazah(uint256 _tokenId, string memory _reason) external"],
    wallet
  );

  // --- Baris 2: revoke HANYA di blockchain, registri dibiarkan aktif.
  // Memanggil kontrak langsung, bukan revokeDiplomaFromBlockchain, karena
  // fungsi itu ikut menyinkronkan pencabutan ke PISN dan PDDikti.
  for (const nim of ALOKASI.baris2_bc_revoked) {
    const k = cari(nim);
    if (!k) { console.log(`  ${nim}: tidak ditemukan, dilewati`); continue; }
    const r = mulai({
      scenario_id: "V-SETUP-B2", domain: "verifikasi", nim, nina: k.nina,
      expected: "token revoked, registri tetap aktif",
      notes: `run=${RUN}; manipulasi disengaja: revoke langsung ke kontrak tanpa sinkronisasi registri`,
    });
    try {
      const tx = await kontrak.revokeIjazah(k.tokenId, "Uji matriks dua lapis - baris 2");
      const rec = await tx.wait();
      r.dariReceipt(rec, tx).set({ token_id: k.tokenId, blockchain_status: "revoked",
        registry_status: "aktif" }).lulus("token dicabut on-chain");
      console.log(`  ${nim} token #${k.tokenId} dicabut on-chain`);
    } catch (e) { r.gagal(e); console.log(`  ${nim} GAGAL: ${e.message}`); }
    await r.selesai();
  }

  // --- Baris 3: ubah status registri SIVIL saja, token dibiarkan aktif.
  for (const nim of ALOKASI.baris3_reg_revoked) {
    const k = cari(nim);
    if (!k) { console.log(`  ${nim}: tidak ditemukan, dilewati`); continue; }
    const r = mulai({
      scenario_id: "V-SETUP-B3", domain: "verifikasi", nim, nina: k.nina,
      expected: "registri revoked, token tetap aktif",
      notes: `run=${RUN}; manipulasi disengaja: status registri SIVIL diubah tanpa mencabut token`,
    });
    try {
      sql("sivil_db", `UPDATE sivil_nina_registry SET status='revoked' WHERE nina='${k.nina}';`);
      r.set({ token_id: k.tokenId, registry_status: "revoked", blockchain_status: "aktif" })
       .lulus("registri diubah");
      console.log(`  ${nim} registri diubah menjadi revoked`);
    } catch (e) { r.gagal(e); console.log(`  ${nim} GAGAL: ${e.message}`); }
    await r.selesai();
  }

  // --- Baris 4: hapus baris registri, token dibiarkan aktif.
  for (const nim of ALOKASI.baris4_reg_hilang) {
    const k = cari(nim);
    if (!k) { console.log(`  ${nim}: tidak ditemukan, dilewati`); continue; }
    const r = mulai({
      scenario_id: "V-SETUP-B4", domain: "verifikasi", nim, nina: k.nina,
      expected: "registri tidak ditemukan, token tetap aktif",
      notes: `run=${RUN}; manipulasi disengaja: baris registri SIVIL dihapus tanpa mencabut token`,
    });
    try {
      sql("sivil_db", `DELETE FROM sivil_nina_registry WHERE nina='${k.nina}';`);
      r.set({ token_id: k.tokenId, registry_status: "tidak ditemukan", blockchain_status: "aktif" })
       .lulus("baris registri dihapus");
      console.log(`  ${nim} baris registri dihapus`);
    } catch (e) { r.gagal(e); console.log(`  ${nim} GAGAL: ${e.message}`); }
    await r.selesai();
  }
  console.log("\nState siap. Jalankan --fase 3.");
}

// ------------------------------------------------------------- FASE 3
async function fase3() {
  if (!CONTRACT_BACA) throw new Error("CONTRACT_ADDRESS_IJAZAH belum diset");
  console.log("FASE 3 — pengujian matriks\n");
  const kredensial = await daftarKredensial();
  const cari = (nim) => kredensial.find((k) => k.nim === nim);

  const dipakai = Object.values(ALOKASI).flat();
  const baris1 = kredensial.filter((k) => !dipakai.includes(k.nim)).slice(0, 3);

  // Baris 5 tersedia secara organik: NINA terbit tetapi token tidak pernah ada.
  const kandidatB5 = sql("sivil_db", `SELECT s.nina, s.nama_mahasiswa FROM sivil_nina_registry s
    LEFT JOIN siakad_db.diplomas d ON s.nina = d.nina AND d.token_id IS NOT NULL
    WHERE d.nina IS NULL;`)
    .split("\n").filter(Boolean)
    .map((b) => { const [nina, nama] = b.split("\t"); return { nina, nama, nim: "-" }; })
    .filter((x) => /^\d{15}$/.test(x.nina || ""));   // tolak baris non-data

  // token_id NULL di basis data lokal belum membuktikan token tidak ada di
  // rantai karena pemetaan kontrak tetap hidup setelah basis data di-reset.
  // Validasi premis B5 langsung terhadap kontrak sebelum memasukkan kasus.
  const kontrakBaca = new ethers.Contract(
    CONTRACT_BACA,
    ["function getTokenIdByHashedNina(bytes32 _hashedNina) external view returns (uint256)"],
    new ethers.JsonRpcProvider(RPC)
  );
  const hasilKandidatB5 = await Promise.all(kandidatB5.map(async (k) => ({
    ...k,
    tokenOnChain: await kontrakBaca.getTokenIdByHashedNina(
      ethers.keccak256(ethers.toUtf8Bytes(k.nina))
    ),
  })));
  const b5 = hasilKandidatB5.filter((k) => k.tokenOnChain === 0n);
  for (const k of hasilKandidatB5.filter((x) => x.tokenOnChain !== 0n)) {
    console.log(`Kandidat B5 dilewati: ${k.nina} memiliki token on-chain #${k.tokenOnChain}`);
  }

  const kasus = [
    ["B1", "aktif", "aktif", "valid", baris1],
    ["B2", "aktif", "revoked", "tidak valid", ALOKASI.baris2_bc_revoked.map(cari).filter(Boolean)],
    ["B3", "revoked", "aktif", "tidak valid", ALOKASI.baris3_reg_revoked.map(cari).filter(Boolean)],
    ["B4", "tidak ditemukan", "aktif", "tidak valid", ALOKASI.baris4_reg_hilang.map(cari).filter(Boolean)],
    ["B5", "aktif", "tidak ditemukan", "tidak valid", b5],
  ];

  const ringkas = [];
  for (const [kode, reg, bc, harap, daftar] of kasus) {
    console.log(`\n${kode}: registri=${reg} x blockchain=${bc}  -> harap ${harap}`);
    for (const k of daftar) {
      const r = mulai({
        scenario_id: `V-${kode}`, domain: "verifikasi", nim: k.nim, nina: k.nina,
        expected: harap, registry_status: reg, blockchain_status: bc,
        token_id: k.tokenId ?? "",
      });
      try {
        const v = await verifikasi(k.nina, k.nama);
        const cocok = harap === "valid" ? v.keputusan === "valid" : v.keputusan.startsWith("tidak valid");
        r.set({ final_verification: v.keputusan, verification_mode: v.mode, http_status: v.http,
                notes: `run=${RUN}; sivilStatus=${v.sivilStatus} bcAktif=${v.bcAktif}` });
        cocok ? r.lulus(v.keputusan) : r.gagal(new Error(`diperoleh ${v.keputusan}`));
        ringkas.push({ kode, nina: k.nina, hasil: v.keputusan, cocok });
        console.log(`   ${k.nina}  ${v.keputusan.padEnd(28)} ${cocok ? "sesuai" : "TIDAK SESUAI"}`);
      } catch (e) {
        r.gagal(e);
        console.log(`   ${k.nina}  ERROR: ${e.message}`);
      }
      await r.selesai();
    }
  }

  const salah = ringkas.filter((x) => !x.cocok).length;
  console.log(`\nTotal diuji : ${ringkas.length}`);
  console.log(`Sesuai      : ${ringkas.length - salah}`);
  console.log(`Tidak sesuai: ${salah}`);
}

// -------------------------------------------------------------- main
(async () => {
  const fase = arg("fase", "1");
  console.log(`Penanda run : ${RUN}\n`);
  await login();
  if (fase === "1") await fase1();
  else if (fase === "b5") await faseB5();
  else if (fase === "2") await fase2();
  else if (fase === "3") await fase3();
  else throw new Error("--fase harus 1, b5, 2, atau 3");
})().catch((e) => { console.error("\nKesalahan:", e.message); process.exit(1); });
