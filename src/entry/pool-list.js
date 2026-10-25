import fs from "fs";
import path from "path";
import config from "../config/index.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";

function poolListPath() {
  return path.resolve(ROOT, config.entry.poolListFile);
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

function resolveEntryMode(modeRaw) {
  if (!modeRaw) return "bidask:double";
  const key = String(modeRaw).trim().toLowerCase();
  if (key === "spot") return "spot";
  if (key === "bidask" || key === "bidask:double") return "bidask:double";
  return null;
}

// Baris `alamat` saja memakai default dari .env (ENTRY_DEFAULT_SIZE_SOL /
// ENTRY_DEFAULT_MAX_POSITION); `alamat,size,max` atau `alamat,size,max,spot` meng-override.
export function parsePoolList(raw) {
  const defaultSize = Number(config.entry.defaultSizeSol);
  const defaultMax = Number(config.entry.defaultMaxPositions);
  const entries = [];

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [address, sizeRaw, maxRaw, modeRaw] = trimmed.split(",").map((s) => s.trim());
    if (!address) continue;

    const secondIsSpot = Boolean(sizeRaw && sizeRaw.toLowerCase() === "spot" && !modeRaw);
    const mode = secondIsSpot ? "spot" : resolveEntryMode(modeRaw);
    if (!mode) {
      log.warn(`Pool ${address.slice(0, 8)} skipped: entry_mode invalid "${modeRaw ?? ""}" (gunakan spot atau bidask:double)`);
      continue;
    }

    const sizeSol = secondIsSpot ? defaultSize : resolveSizeSol(sizeRaw, defaultSize);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      log.warn(
        `Pool ${address.slice(0, 8)} skipped: entry_size invalid "${sizeRaw ?? ""}" (set ENTRY_DEFAULT_SIZE_SOL atau tulis alamat,size,max)`
      );
      continue;
    }

    const maxNum = maxRaw ? Number(maxRaw) : defaultMax;
    const maxPositions = Number.isFinite(maxNum) && maxNum > 0 ? Math.floor(maxNum) : defaultMax;
    entries.push({ pool: address, sizeSol, maxPositions, mode });
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
export function commentPoolInList(poolAddress) {
  if (!poolAddress) return false;
  const file = poolListPath();
  try {
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let active = false;
    const out = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (trimmed.split(",")[0].trim() !== poolAddress) return line;
      active = true;
      return `#${line}`;
    });
    if (!active) return true;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, out.join("\n"));
    fs.renameSync(tmp, file);
    return true;
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
  } catch (err) {
    log.warn(`Gagal mengganti pool ${oldPoolAddress.slice(0, 8)} -> ${newPoolAddress.slice(0, 8)} di ${config.entry.poolListFile}: ${err.message}`);
    return false;
  }
}
