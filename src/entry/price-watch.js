import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT } from "../core/constants.js";
import { getPrices } from "../market/jupiter-price.js";
import { ensureSupertrend, getSupertrend, getSupertrendFallback } from "../market/supertrend-state.js";

// Harga Jupiter terakhir per mint (untuk ringkasan log) plus waktu terima.
const lastPrices = new Map();
const lastPriceAt = new Map();
let lastPricesAt = 0;

// Di atas ini, harga cache tidak boleh ditampilkan sebagai "siap entry".
export const PRICE_STALE_MS = 60_000;

const gapSince = new Map();
const gapWarnedAt = new Map();

export function getLastPrices() {
  return lastPrices;
}

export function getLastPricesAt() {
  return lastPricesAt;
}

export function getLastPriceAt(mint) {
  return lastPriceAt.get(mint) || 0;
}

export function rememberPrices(prices, now = Date.now()) {
  let any = false;
  for (const [mint, price] of prices || []) {
    if (!mint || !Number.isFinite(price)) continue;
    lastPrices.set(mint, price);
    lastPriceAt.set(mint, now);
    any = true;
  }
  if (any) lastPricesAt = now;
}

export function forgetPrice(mint) {
  if (!mint) return;
  lastPrices.delete(mint);
  lastPriceAt.delete(mint);
}

// Harga segar untuk ringkasan. Basi: price null + priceStale supaya tidak "siap entry".
export function watchPriceFields(mint, now = Date.now()) {
  const raw = lastPrices.get(mint);
  const at = lastPriceAt.get(mint) || 0;
  const ageMs = at ? Math.max(0, now - at) : null;
  const fresh = Number.isFinite(raw) && ageMs != null && ageMs <= PRICE_STALE_MS;
  return {
    price: fresh ? raw : null,
    priceStale: Number.isFinite(raw) && !fresh,
    priceAgeSec: ageMs == null ? null : Math.round(ageMs / 1000),
  };
}

// Peringatan paling sering sekali per menit per mint. Harga cache yang sudah
// lebih tua dari 60 detik langsung diingatkan. Harga yang belum pernah ada
// baru diingatkan setelah 60 detik terus-menerus hilang. Pulih → timer direset.
export function noteBullishPriceGap(mint, hasFresh, now = Date.now()) {
  if (!mint) return false;
  if (hasFresh) {
    gapSince.delete(mint);
    gapWarnedAt.delete(mint);
    return false;
  }
  if (!gapSince.has(mint)) gapSince.set(mint, now);
  const cachedAt = lastPriceAt.get(mint) || 0;
  const cacheAge = cachedAt ? now - cachedAt : null;
  const missingFor = now - gapSince.get(mint);
  const staleLongEnough = (cacheAge != null && cacheAge > PRICE_STALE_MS) || missingFor > PRICE_STALE_MS;
  if (!staleLongEnough) return false;
  const warned = gapWarnedAt.get(mint) || 0;
  if (now - warned < PRICE_STALE_MS) return false;
  gapWarnedAt.set(mint, now);
  log.warn(`Harga Jupiter ${String(mint).slice(0, 8)} tidak segar lebih dari 60 detik — kandidat bullish dilewati`);
  return true;
}

export function resetPriceWatchState() {
  lastPrices.clear();
  lastPriceAt.clear();
  lastPricesAt = 0;
  gapSince.clear();
  gapWarnedAt.clear();
}

// State machine sinyal entry:
//   1. GMGN 15m (candle tutup) menentukan arah + garis Supertrend.
//   2. Hanya bullish yang dipantau.
//   3. Jupiter memantau harga real-time; harga <= garis -> entry (first_touch).
//
// `candidates`: [{ pool, mint }]
// `deps` (opsional, untuk test): { getSupertrend, getSupertrendFallback, ensureSupertrend, getPrices }
// Mengembalikan: { triggered: [{ pool, mint, line, price, direction }], pending: n }
export async function watchPrices(candidates = [], deps = {}) {
  const getST = deps.getSupertrend || getSupertrend;
  const getSTFallback = deps.getSupertrendFallback || getSupertrendFallback;
  const ensure = deps.ensureSupertrend || ensureSupertrend;
  const fetchPrices = deps.getPrices || getPrices;

  // Picu penyegaran garis (non-blocking) untuk semua kandidat.
  for (const c of candidates) ensure(c.mint);

  const bullish = [];
  for (const c of candidates) {
    // Pakai garis bar terbaru; saat transisi bar (garis belum siap), pakai
    // garis bar sebelumnya agar evaluasi entry tidak terlewat.
    const st = getST(c.mint) || getSTFallback(c.mint);
    if (st && st.direction === "bullish") bullish.push({ ...c, line: st.line });
  }

  if (bullish.length === 0) return { triggered: [], pending: candidates.length };

  // Peta bersama dari watchAndEnter (satu fetch per tick). Tanpa itu, fetch sendiri.
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const prices =
    deps.prices instanceof Map ? deps.prices : await fetchPrices([...bullish.map((b) => b.mint), WSOL_MINT]);
  rememberPrices(prices, now);

  const tolerance = Math.max(0, Number(config.entryTouchTolerancePct) || 0) / 100;
  const triggered = [];

  for (const b of bullish) {
    const price = prices.get(b.mint);
    const fresh = Number.isFinite(price);
    noteBullishPriceGap(b.mint, fresh, now);
    if (!fresh) continue;
    if (price <= b.line * (1 + tolerance)) {
      triggered.push({
        pool: b.pool,
        mint: b.mint,
        line: b.line,
        price,
        solPrice: prices.get(WSOL_MINT),
        direction: "bullish",
      });
    }
  }

  if (triggered.length > 0) {
    log.debug(`[detail] watchPrices: ${triggered.length}/${candidates.length} sentuh garis (bullish)`);
  }

  return { triggered, pending: candidates.length - bullish.length };
}
