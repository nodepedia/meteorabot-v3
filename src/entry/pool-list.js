import fs from "fs";
import path from "path";
import config from "../config/index.js";
import { parseBidaskSolRange } from "../config/bidask-sol-range.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";
import { getPoolAlias } from "./runtime.js";

export function poolListFilePath() {
  return path.resolve(ROOT, config.entry.poolListFile);
}

function poolListPath() {
  return poolListFilePath();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Kunci file supaya entry bot dan worker-entry tidak saling timpa pool.txt.
function acquirePoolLock(file, timeoutMs = 5000) {
  const target = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(target, "wx");
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(target);
        if (Date.now() - st.mtimeMs > 15000) fs.unlinkSync(target);
      } catch {
        // kunci sudah hilang
      }
      sleepSync(20);
    }
  }
  throw new Error("pool.txt lock timeout");
}

function releasePoolLock(file, fd) {
  try {
    fs.closeSync(fd);
  } catch {
    // sudah tertutup
  }
  try {
    fs.unlinkSync(`${file}.lock`);
  } catch {
    // sudah dilepas
  }
}

function withPoolListLock(file, fn) {
  const fd = acquirePoolLock(file);
  try {
    return fn();
  } finally {
    releasePoolLock(file, fd);
  }
}

function atomicReplace(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function hasActiveFirstColumn(raw, address) {
  if (!address) return false;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.split(",")[0].trim() === address) return true;
  }
  return false;
}

const TIER_MULTIPLIERS = {
  "1x": 1,
  "1.25x": 1.25,
  "1.5x": 1.5,
  tier1: 1,
  tier2: 1.25,
  tier3: 1.5,
};

function resolveSizeSol(sizeRaw, defaultSize) {
  if (!sizeRaw) return defaultSize;
  const key = sizeRaw.toLowerCase();
  if (key in TIER_MULTIPLIERS) {
    return Number((defaultSize * TIER_MULTIPLIERS[key]).toFixed(6));
  }
  if (key.endsWith("x")) {
    const mult = Number(key.slice(0, -1));
    if (Number.isFinite(mult) && mult > 0) {
      return Number((defaultSize * mult).toFixed(6));
    }
    return NaN;
  }
  return Number(sizeRaw);
}

// Token `now` (huruf besar/kecil): masuk begitu harga terbaca, bukan harga target.
export function isBidaskSolNow(value, unit) {
  if (String(unit || "").toLowerCase() === "now") return true;
  if (value && typeof value === "object") {
    if (value.entryNow === true) return true;
    if (String(value.entryPriceUnit || "").toLowerCase() === "now") return true;
    return (
      String(value.entryPrice ?? "")
        .trim()
        .toLowerCase() === "now"
    );
  }
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "now"
  );
}

// Harga entry bidask:sol. Kosong / usd = USD per token. Akhiran sol = SOL per token.
// now = masuk begitu harga terbaca. null = kolom kosong. { ok:false } = tidak valid.
export function parseEntryPrice(raw) {
  if (raw == null) return null;
  const body = String(raw).split("#")[0].trim();
  if (!body) return null;
  if (/^now$/i.test(body)) return { ok: true, entryNow: true, entryPrice: null, entryPriceUnit: "now" };
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*([A-Za-z]+))?$/.exec(body);
  if (!m) return { ok: false, reason: "invalid" };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "invalid" };
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "" || suffix === "usd") return { ok: true, entryPrice: n, entryPriceUnit: "usd" };
  if (suffix === "sol") return { ok: true, entryPrice: n, entryPriceUnit: "sol" };
  return { ok: false, reason: "suffix", suffix };
}

// bidask:sol hanya sah bersama kolom `ca` dan harga entry positif (usd atau sol),
// atau token `now`. Tanpa itu kembalikan null supaya pemanggil melewati baris.
function resolveEntryMode(modeRaw, { isCa = false, entryPrice = null, entryNow = false } = {}) {
  if (!modeRaw) return "bidask:double";
  const key = String(modeRaw).trim().toLowerCase();
  if (key === "spot") return "spot";
  if (key === "bidask" || key === "bidask:double") return "bidask:double";
  if (key === "bidask:sol") {
    if (isCa && (entryNow || (Number.isFinite(entryPrice) && entryPrice > 0))) return "bidask:sol";
    return null;
  }
  return null;
}

// Baris `alamat` saja memakai ENTRY_DEFAULT_SIZE_SOL.
// Format lama `alamat,size,max[,mode[,ca]]` tetap terbaca: kolom ke-3 (max
// entry seumur hidup) diabaikan. Mode tetap kolom ke-4.
// bidask:sol: `CA,size,,bidask:sol,ca,HARGA` (usd atau sol) atau `...,now`.
// Kolom ke-7 opsional: rentang `bawah/atas`, contoh `-30/15`. Kosong = strat.conf.
export function parsePoolList(raw) {
  const defaultSize = Number(config.entry.defaultSizeSol);
  const entries = [];

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(",").map((s) => s.trim());
    const address = parts[0];
    const sizeRaw = parts[1];
    const modeRaw = parts[3];
    const kindRaw = parts[4];
    const parsedPrice = parseEntryPrice(parts[5]);
    const parsedRange = parseBidaskSolRange(parts[6]);
    const entryNow = Boolean(parsedPrice?.entryNow);
    const entryPrice = parsedPrice?.ok && !entryNow ? parsedPrice.entryPrice : null;
    const entryPriceUnit = entryNow ? "now" : parsedPrice?.ok ? parsedPrice.entryPriceUnit : null;
    if (!address) continue;
    // Kolom ke-5 `ca`: kolom pertama adalah CA token (mint), pool dipilih saat entry.
    const isCa = Boolean(kindRaw && kindRaw.split(/[\s#]/)[0].toLowerCase() === "ca");
    if (kindRaw && !isCa) {
      log.warn(`Pool ${address.slice(0, 8)} skipped: kolom ke-5 invalid "${kindRaw}" (hanya ca)`);
      continue;
    }

    const secondIsSpot = Boolean(sizeRaw && sizeRaw.toLowerCase() === "spot" && !modeRaw);
    const modeKey = String(modeRaw || "")
      .trim()
      .toLowerCase();
    const mode = secondIsSpot ? "spot" : resolveEntryMode(modeRaw, { isCa, entryPrice, entryNow });
    if (!mode) {
      if (modeKey === "bidask:sol") {
        if (parsedPrice?.reason === "suffix") {
          log.warn(
            `Pool ${address.slice(0, 8)} skipped: bidask:sol satuan harga "${parsedPrice.suffix}" tidak dikenal (pakai angka, usd, atau sol)`
          );
        } else {
          log.warn(
            `Pool ${address.slice(0, 8)} skipped: bidask:sol butuh kolom ca dan harga entry positif, atau now (CA,size,,bidask:sol,ca,0.0012 atau 0.0000123sol atau now)`
          );
        }
      } else {
        log.warn(
          `Pool ${address.slice(0, 8)} skipped: entry_mode invalid "${modeRaw ?? ""}" (gunakan spot atau bidask:double)`
        );
      }
      continue;
    }

    const sizeSol = secondIsSpot ? defaultSize : resolveSizeSol(sizeRaw, defaultSize);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      log.warn(
        `Pool ${address.slice(0, 8)} skipped: entry_size invalid "${sizeRaw ?? ""}" (set ENTRY_DEFAULT_SIZE_SOL atau tulis alamat,size)`
      );
      continue;
    }

    if (mode === "bidask:sol") {
      if (parsedRange && !parsedRange.ok) {
        const shown = String(parts[6] || "")
          .split("#")[0]
          .trim()
          .slice(0, 40);
        log.warn(
          `Pool ${address.slice(0, 8)} skipped: bidask:sol rentang "${shown}" tidak valid (bawah -99..-1, atas 0..100, contoh -30/15)`
        );
        continue;
      }
      const row = { pool: address, sizeSol, mode, ca: true, entryPrice, entryPriceUnit };
      if (entryNow) row.entryNow = true;
      if (parsedRange?.ok) {
        row.lowerPct = parsedRange.lowerPct;
        row.upperPct = parsedRange.upperPct;
      }
      entries.push(row);
    } else if (isCa) {
      entries.push({ pool: address, sizeSol, mode, ca: true });
    } else {
      entries.push({ pool: address, sizeSol, mode });
    }
  }
  return entries;
}

export function loadPoolList() {
  const file = poolListPath();
  if (!fs.existsSync(file)) {
    log.warn(`Pool list not found: ${file}`);
    return [];
  }
  return parsePoolList(fs.readFileSync(file, "utf8"));
}

// Beri `#` di depan semua baris aktif milik pool ini agar tidak dipantau lagi
// (menu manual: hapus `#` untuk mengaktifkan kembali). Return false hanya bila
// penulisan gagal, supaya pemanggil bisa fallback ke skip runtime.
export function commentPoolInList(poolAddress, alias = getPoolAlias(poolAddress), file = poolListPath()) {
  if (!poolAddress) return false;
  // Pool hasil resolve baris CA: '#' baris CA-nya. Kolom pertama yang cocok,
  // termasuk baris CA 6 kolom dengan akhiran sol/usd.
  const targets = new Set([poolAddress, alias].filter(Boolean));
  if (!file) file = poolListPath();
  try {
    return withPoolListLock(file, () => {
      if (!fs.existsSync(file)) return false;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      let active = false;
      const out = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        if (!targets.has(trimmed.split(",")[0].trim())) return line;
        active = true;
        return `#${line}`;
      });
      if (!active) return true;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, out.join("\n"));
      fs.renameSync(tmp, file);
      return true;
    });
  } catch (err) {
    log.warn(`Gagal menandai pool ${poolAddress.slice(0, 8)} di ${config.entry.poolListFile}: ${err.message}`);
    return false;
  }
}

// Ganti alamat pool aktif di pool.txt dengan pool baru yang lebih efisien saat reposisi
// (mempertahankan konfigurasi size/multiplier/mode pada baris tersebut).
export function replacePoolInList(oldPoolAddress, newPoolAddress) {
  if (!oldPoolAddress || !newPoolAddress || oldPoolAddress === newPoolAddress) return false;
  const file = poolListPath();
  try {
    return withPoolListLock(file, () => {
      if (!fs.existsSync(file)) return false;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const hasNewActive = lines.some((line) => {
        const t = line.trim();
        return t && !t.startsWith("#") && t.split(",")[0].trim() === newPoolAddress;
      });
      let changed = false;
      const out = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const parts = trimmed.split(",");
        if (parts[0].trim() !== oldPoolAddress) return line;
        changed = true;
        if (hasNewActive) return `#${line}`;
        parts[0] = newPoolAddress;
        return parts.join(",");
      });
      if (!changed) return true;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, out.join("\n"));
      fs.renameSync(tmp, file);
      return true;
    });
  } catch (err) {
    log.warn(
      `Gagal mengganti pool ${oldPoolAddress.slice(0, 8)} -> ${newPoolAddress.slice(0, 8)} di ${config.entry.poolListFile}: ${err.message}`
    );
    return false;
  }
}

// Tambah satu baris CA di akhir. Header bot tetap, baris lain tidak diubah.
// Tolak bila kolom pertama yang sama masih aktif (belum diberi #).
export function appendCaEntryLine(line, file = poolListPath()) {
  const text = String(line || "").trim();
  if (!text || text.startsWith("#") || /[\r\n]/.test(text)) return { ok: false, error: "invalid" };
  const mint = text.split(",")[0].trim();
  if (!mint) return { ok: false, error: "invalid" };
  try {
    return withPoolListLock(file, () => {
      const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (hasActiveFirstColumn(raw, mint)) return { ok: false, duplicate: true };
      const headed = applyPoolListHeader(raw).next;
      const body = headed.endsWith("\n") || headed === "" ? headed : `${headed}\n`;
      atomicReplace(file, `${body}${text}\n`);
      return { ok: true, line: text };
    });
  } catch (err) {
    log.warn(`Gagal menambah baris di pool.txt: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Cari size entry terkonfigurasi untuk pool (atau alias CA-nya) dari pool.txt.
// Dipakai sebagai fallback re-entry / adopsi posisi on-chain bila entrySizeSol hilang.
// Mencakup baris aktif dan baris yang sudah diberi '#' (arsip).
export function lookupConfiguredEntrySizeSol(poolAddress, opts = {}) {
  if (!poolAddress) return null;
  const alias = opts.alias !== undefined ? opts.alias : getPoolAlias(poolAddress);
  const targets = new Set([poolAddress, alias].filter(Boolean));
  const file = opts.filePath || poolListPath();
  let raw = opts.raw;
  if (raw == null) {
    try {
      if (!fs.existsSync(file)) return null;
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  const defaultSize = Number(config.entry.defaultSizeSol);
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const body = trimmed.startsWith("#") ? trimmed.replace(/^#+\s*/, "") : trimmed;
    if (!body || body.startsWith("#")) continue;
    const [address, sizeRaw, , modeRaw] = body.split(",").map((s) => s.trim());
    if (!targets.has(address)) continue;
    const secondIsSpot = Boolean(sizeRaw && sizeRaw.toLowerCase() === "spot" && !modeRaw);
    const sizeSol = secondIsSpot ? defaultSize : resolveSizeSol(sizeRaw, defaultSize);
    if (Number.isFinite(sizeSol) && sizeSol > 0) return Number(sizeSol.toFixed(6));
  }
  if (Number.isFinite(defaultSize) && defaultSize > 0) return Number(defaultSize.toFixed(6));
  return null;
}

// Blok komentar di puncak pool.txt. Bot menimpa teks di antara penanda bila
// format berubah, dan tidak mengubah baris di luar blok itu.
export const POOL_LIST_HEADER_START = "# === FORMAT (dikelola bot) ===";
export const POOL_LIST_HEADER_END = "# === END FORMAT ===";

export function poolListHeaderLines() {
  return [
    POOL_LIST_HEADER_START,
    "# Blok ini ditulis ulang oleh bot bila teksnya berubah. Jangan diedit.",
    "# Baris di luar blok ini tidak disentuh.",
    "#",
    "# Kolom: alamat_atau_CA, size, (kolom ke-3 diabaikan), mode, ca, harga_entry, rentang",
    "# Kolom ke-3 (max entry lama) diabaikan.",
    "# Size: angka SOL (contoh 0.5), kelipatan 1x / 1.25x / 1.5x, atau tier1 / tier2 / tier3.",
    "# Kosong = ENTRY_DEFAULT_SIZE_SOL. Kelipatan dan tier dikali default itu.",
    "#",
    "# spot, alamat pool:",
    "#   POOL_ADDRESS,1x,,spot",
    "# spot, CA token (pool dipilih bot):",
    "#   TOKEN_CA,1x,,spot,ca",
    "# bidask:double, alamat pool:",
    "#   POOL_ADDRESS,0.5,,bidask:double",
    "# bidask:double, CA token:",
    "#   TOKEN_CA,1.25x,,bidask:double,ca",
    "# bidask:sol (hanya CA + harga entry per token, tanpa Supertrend):",
    "#   TOKEN_CA,1x,,bidask:sol,ca,0.00123",
    "#   TOKEN_CA,1x,,bidask:sol,ca,0.00123usd",
    "#   TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol",
    "#   TOKEN_CA,1x,,bidask:sol,ca,now",
    "#   TOKEN_CA,1x,,bidask:sol,ca,now,-30/15",
    "#   TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol,-20/15",
    "#   Kolom ke-7 opsional, hanya bidask:sol: bawah/atas. Contoh -30/15 atau -20/+15.",
    "#   Bawah -99 sampai -1, atas 0 sampai 100. Kosong = BIDASK_SOL_ENTRY_LOWER_PCT / UPPER_PCT.",
    "#   Di luar rentang itu, baris dilewati.",
    "#   Tanpa akhiran atau usd = USD per token. Akhiran sol = SOL per token (huruf besar/kecil).",
    "#   now (huruf besar/kecil) = masuk begitu harga terbaca. Bukan harga target.",
    "#   Arah sentuh tidak disimpan. Lebar posisi dihitung dari harga bin aktif saat entry.",
    "#   Akhiran lain, nol, atau negatif = baris dilewati.",
    "#   Sentuh: harga pertama di bawah target menunggu naik sampai target.",
    "#   Harga pertama di atas target menunggu turun sampai target.",
    "#   Harga pertama tepat di target masuk sekarang. Harga belum terbaca belum masuk.",
    "#   Arah itu disimpan dan tahan restart. Ubah harga atau hapus baris menghapus arah.",
    "#   Setelah entry berhasil baris ini diberi #. Kolom pertama adalah mint, bukan pool.",
    POOL_LIST_HEADER_END,
  ];
}

// Murni: sisipkan atau ganti blok format. Baris di luar penanda tetap apa adanya.
export function applyPoolListHeader(raw) {
  const header = poolListHeaderLines();
  const text = String(raw ?? "");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const start = lines.findIndex((line) => line.trim() === POOL_LIST_HEADER_START);
  const end = start >= 0 ? lines.findIndex((line, i) => i > start && line.trim() === POOL_LIST_HEADER_END) : -1;
  const nextLines =
    start >= 0 && end > start ? [...lines.slice(0, start), ...header, ...lines.slice(end + 1)] : [...header, ...lines];
  const next = `${nextLines.join(nl)}${nl}`;
  return { next, changed: next !== text };
}

// Tulis header ke pool.txt secara atomik. Tidak menulis ulang bila teksnya sama.
export function ensurePoolListHeader(file = poolListPath()) {
  return withPoolListLock(file, () => {
    let raw = "";
    if (fs.existsSync(file)) raw = fs.readFileSync(file, "utf8");
    const { next, changed } = applyPoolListHeader(raw);
    if (!changed) return false;
    atomicReplace(file, next);
    return true;
  });
}
