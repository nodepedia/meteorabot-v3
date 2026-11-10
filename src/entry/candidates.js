import { LEGACY_MODE } from "../config/rules.js";

// Strategi kuota entry. Semua varian bidask:* (dan label lama) = satu slot "bidask".
export function strategyOfMode(mode) {
  const normalized = LEGACY_MODE[mode] || mode;
  if (normalized === "spot") return "spot";
  if (typeof normalized === "string" && normalized.startsWith("bidask")) return "bidask";
  return null;
}

// Kunci okupansi (pool, strategi). Alamat pool base58 tidak memuat "|".
export function quotaKey(pool, strategy) {
  return `${pool}|${strategy}`;
}

function isOpen(position) {
  return Boolean(position) && position.closed !== true;
}

// Posisi yang mengisi kuota: terbuka, bukan DCA, mode masuk keluarga strategi ini.
export function positionFillsQuota(position, pool, strategy) {
  if (!isOpen(position) || position.isDca === true || !pool || !strategy) return false;
  if (position.pool !== pool) return false;
  return strategyOfMode(position.mode) === strategy;
}

export function countQuotaPositions(positions, pool, strategy) {
  let n = 0;
  for (const p of positions || []) {
    if (positionFillsQuota(p, pool, strategy)) n++;
  }
  return n;
}

export function isQuotaFull(positions, pool, strategy) {
  return countQuotaPositions(positions, pool, strategy) >= 1;
}

// Blokir entry bila mint ini sudah punya posisi di pool lain, atau slot strategi
// ini di pool yang sama sudah terisi (posisi DCA tidak mengisi slot).
export function mintBlocksEntry(positions, { pool, mint, strategy } = {}) {
  if (!pool || !mint || !strategy) return { block: false };
  for (const p of positions || []) {
    if (!isOpen(p) || p.baseMint !== mint) continue;
    if (p.pool && p.pool !== pool) return { block: true, otherPool: true };
    if (p.isDca === true) continue;
    if (strategyOfMode(p.mode) === strategy) return { block: true, sameStrategy: true };
  }
  return { block: false };
}

// Re-entry spot OOR kanan menutup posisi lain pada mint yang sama, kecuali
// strategi lain (bidask, termasuk fallback token & DCA) di pool tujuan.
export function shouldCloseBeforeSpotReentry(position, targetPool) {
  if (!isOpen(position)) return false;
  if (position.pool === targetPool && strategyOfMode(position.mode) !== "spot") return false;
  return true;
}

export function lineWatchId(entry) {
  return `${entry?.pool || ""}|${entry?.mode || ""}|${entry?.ca ? "ca" : ""}`;
}

// Baris yang baru muncul di pool.txt (termasuk `#` yang baru dihapus).
// Pool yang masih punya baris lain yang tetap aktif tidak di-reset, supaya
// timer expiry baris yang tidak berubah tidak mulai dari nol.
export function poolKeysToReset(previousIds, pools) {
  const prev = previousIds || new Set();
  const ids = new Set();
  const still = new Set();
  const fresh = [];
  for (const p of pools || []) {
    if (!p?.pool) continue;
    const id = lineWatchId(p);
    ids.add(id);
    if (prev.has(id)) still.add(p.pool);
    else fresh.push(p.pool);
  }
  const resetKeys = [];
  const seen = new Set();
  for (const pool of fresh) {
    if (still.has(pool) || seen.has(pool)) continue;
    seen.add(pool);
    resetKeys.push(pool);
  }
  return { ids, resetKeys };
}

// Filter kandidat untuk price-watch loop (murni, tanpa I/O).
// `inFlight`/`entered` boleh berisi kunci pool (lock DCA/exit/reentry, atau tes lama)
// atau kunci kuota `pool|strategi`. Slot strategi lain tidak menyaring kandidat ini.
export function selectWatchCandidates(candidates, { inFlight, entered, cooldowns, now = Date.now() } = {}) {
  const inFlightSet = inFlight || new Set();
  const enteredSet = entered || new Set();
  const cooldownMap = cooldowns || new Map();

  return (candidates || []).filter((c) => {
    if (!c?.pool || !c?.mint) return false;
    const strategy = c.strategy || strategyOfMode(c.mode) || "bidask";
    const key = quotaKey(c.pool, strategy);
    if (inFlightSet.has(c.pool) || inFlightSet.has(key)) return false;
    if (enteredSet.has(c.pool) || enteredSet.has(key)) return false;
    const until = cooldownMap.get(c.pool) || cooldownMap.get(key) || 0;
    if (now < until) return false;
    return true;
  });
}
