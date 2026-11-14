import config from "../config/index.js";
import { nonRefundableCost, exceedsNonRefundable, openSpotSolPosition } from "./spot-position.js";

/**
 * Pure: range re-entry bidask:sol.
 * Lebar (upper − lower) dipertahankan dan harus tetap di bawah maxSpan
 * (SPOT_MIN_BINS) supaya classifyMode tidak mengubahnya jadi spot.
 * Bila offset terhadap bin aktif saat buka diketahui, range baru duduk
 * dengan cara yang sama terhadap bin aktif yang baru. Bila tidak, seluruh
 * bin berada di atau di bawah bin aktif (range berakhir di bin aktif).
 */
export function bidaskSolReentryBinRange({
  activeBinId,
  binSpan,
  binsBelow = null,
  binsAbove = null,
  maxSpan = Infinity,
} = {}) {
  const active = Math.trunc(Number(activeBinId));
  const span = Math.floor(Number(binSpan));
  const cap = Number(maxSpan);
  if (!Number.isFinite(active) || !Number.isFinite(span) || span <= 0) return null;
  if (Number.isFinite(cap) && span >= cap) return null;

  let below = span;
  let above = 0;
  const knownBelow = Number(binsBelow);
  const knownAbove = Number(binsAbove);
  if (
    Number.isFinite(knownBelow) &&
    Number.isFinite(knownAbove) &&
    knownBelow >= 0 &&
    knownAbove >= 0 &&
    Math.floor(knownBelow) + Math.floor(knownAbove) === span
  ) {
    below = Math.floor(knownBelow);
    above = Math.floor(knownAbove);
  }

  return {
    minBinId: active - below,
    maxBinId: active + above,
    binsBelow: below,
    binsAbove: above,
    binSpan: span,
  };
}

/**
 * Buka posisi BidAsk SOL-only pada [minBinId..maxBinId].
 * Sewa non-refundable ditolak seperti re-entry spot. Distribusi SOL memakai
 * helper buka posisi yang sudah ada, dengan strategyType BidAsk dan deposit
 * menutup seluruh range (bukan tangga persen spot).
 */
export async function openBidaskSolPosition({
  pool,
  connection,
  wallet,
  feePlan,
  baseIsX,
  solLamports,
  minBinId,
  maxBinId,
  strategyType,
  slippage = config.entry.activeBinSlippagePct,
  sendAndConfirmFn,
  newPositionKeypair = null,
  skipNonRefundable = true,
  maxNonRefundableSol = 0,
} = {}) {
  if (!pool) return { ok: false, error: "pool kosong" };
  if (strategyType === undefined || strategyType === null) {
    return { ok: false, error: "strategi BidAsk tidak tersedia" };
  }

  if (typeof pool.quoteCreatePosition === "function") {
    const quote = await pool.quoteCreatePosition({ strategy: { minBinId, maxBinId } });
    const nonRef = nonRefundableCost(quote);
    if (skipNonRefundable && exceedsNonRefundable(nonRef, maxNonRefundableSol)) {
      return {
        ok: false,
        nonRefundable: true,
        nonRefundableSol: nonRef,
        error: `akan kena sewa non-refundable ${nonRef.toFixed(6)} SOL (binArray=${Number(quote?.binArrayCost ?? 0).toFixed(6)}, bitmap=${Number(quote?.bitmapExtensionCost ?? 0).toFixed(6)}) > batas ${maxNonRefundableSol} SOL — batalkan re-entry`,
      };
    }
  }

  const openRes = await openSpotSolPosition({
    pool,
    connection,
    wallet,
    feePlan,
    baseIsX,
    solLamports,
    minBinId,
    maxBinId,
    depositMinBinId: minBinId,
    depositMaxBinId: maxBinId,
    strategyType,
    slippage,
    sendAndConfirmFn,
    newPositionKeypair,
  });

  return { ok: true, ...openRes };
}
