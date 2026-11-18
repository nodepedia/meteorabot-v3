// Entry manual bidask:sol dari pool.txt (CA + harga USD).
// Posisi standar SDK menyimpan 70 bin (DEFAULT_BIN_PER_POSITION). Lebih lebar
// dari itu, dan juga bila ada bin atas yang dikosongkan, pembukaan memakai
// createExtendedEmptyPosition. SDK mengizinkan satu posisi sampai
// POSITION_MAX_LENGTH (1400 bin). Ambang strategi (default 105) ada di dalam
// batas itu. Setoran likuiditas tetap dipecah per 70 bin.
import config from "../config/index.js";
import { WSOL_MINT } from "../core/constants.js";
import { getPrices } from "../market/jupiter-price.js";
import { getLastPrices } from "./price-watch.js";
import { addrOf, isDlmmPool, isCaPoolInvalid } from "./ca-resolve.js";

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};

function mintsOf(p) {
  return [p?.token_x?.address, p?.token_y?.address].filter(Boolean);
}

function isMintSolPool(p, mint) {
  const m = mintsOf(p);
  return m.includes(WSOL_MINT) && (!mint || m.includes(mint));
}

function tvlUsdOf(p) {
  const t = n(p?.tvl ?? p?.tvlUsd);
  return Number.isFinite(t) ? t : 0;
}

function volumeTvlRatio(p) {
  const direct = n(p?.volume_tvl_ratio);
  if (Number.isFinite(direct)) return direct;
  const volRaw = p?.volume;
  const vol = n(typeof volRaw === "object" && volRaw ? (volRaw["30m"] ?? volRaw["24h"] ?? volRaw.h24) : volRaw);
  const tvl = tvlUsdOf(p);
  if (Number.isFinite(vol) && tvl > 0) return vol / tvl;
  return 0;
}

function binStepOf(p) {
  return n(p?.dlmm_params?.bin_step ?? p?.bin_step);
}

// Jumlah bin untuk bergerak `pct` persen. ceil(|ln(1+pct/100)| / ln(1+binStep/10000)).
export function ceilBinsForPricePct(binStep, pct) {
  const step = Number(binStep);
  const p = Number(pct);
  if (!Number.isFinite(step) || step <= 0) return null;
  if (!Number.isFinite(p) || p <= -100 || p === 0) return null;
  const ratio = 1 + p / 100;
  if (!(ratio > 0)) return null;
  const base = 1 + step / 10000;
  const bins = Math.ceil(Math.abs(Math.log(ratio)) / Math.log(base));
  if (!Number.isFinite(bins) || bins <= 0) return null;
  return bins;
}

// Range posisi: [aktif - bawah .. aktif + atas]. Jumlah bin inklusif.
// Deposit SOL nanti hanya [min .. aktif]; bin di atas aktif kosong.
export function bidaskSolEntryBinPlan({
  binStep,
  activeBinId = null,
  lowerPct = config.entry.bidaskSolLowerPct,
  upperPct = config.entry.bidaskSolUpperPct,
} = {}) {
  const binsBelow = ceilBinsForPricePct(binStep, lowerPct);
  const binsAbove = ceilBinsForPricePct(binStep, upperPct);
  if (binsBelow == null || binsAbove == null) return null;
  const plan = {
    binStep: Number(binStep),
    binsBelow,
    binsAbove,
    binCount: binsBelow + binsAbove + 1,
    lowerPct: Number(lowerPct),
    upperPct: Number(upperPct),
  };
  const active = Number(activeBinId);
  if (Number.isFinite(active)) {
    const activeId = Math.trunc(active);
    plan.activeBinId = activeId;
    plan.minBinId = activeId - binsBelow;
    plan.maxBinId = activeId + binsAbove;
    plan.depositMinBinId = plan.minBinId;
    plan.depositMaxBinId = activeId;
  }
  return plan;
}

// Harga USD di tepi range, dari harga bin aktif.
export function coveredPriceUsd(activeUsd, binStep, binsBelow, binsAbove) {
  const price = Number(activeUsd);
  const step = Number(binStep);
  if (!(price > 0) || !(step > 0)) return null;
  const r = 1 + step / 10000;
  return {
    lowerUsd: price * r ** (-Number(binsBelow) || 0),
    upperUsd: price * r ** (Number(binsAbove) || 0),
  };
}

// Murni: pool DLMM token/SOL, tidak blacklist, TVL >= ambang, lebar bin <= ambang.
// Urutan: fee/active TVL tertinggi, lalu volume/TVL, lalu bin lebih sedikit.
export function pickBidaskSolEntryPool(pools, mint, opts = {}) {
  const minTvl = Math.max(0, Number(opts.minTvlUsd ?? config.entry.bidaskSolMinTvlUsd) || 0);
  const maxBins = Math.max(1, Math.floor(Number(opts.maxBins ?? config.entry.bidaskSolMaxBins) || 105));
  const lowerPct = opts.lowerPct ?? config.entry.bidaskSolLowerPct;
  const upperPct = opts.upperPct ?? config.entry.bidaskSolUpperPct;
  const excluded = new Set([...(opts.exclude || [])].filter(Boolean));

  let lowTvl = 0;
  let tooWide = 0;
  let badStep = 0;
  const ranked = [];

  for (const p of pools || []) {
    const addr = addrOf(p);
    if (!addr || excluded.has(addr) || isCaPoolInvalid(addr)) continue;
    if (!isMintSolPool(p, mint)) continue;
    if (p?.is_blacklisted === true) continue;
    if (!isDlmmPool(p)) continue;
    const step = binStepOf(p);
    const plan = bidaskSolEntryBinPlan({ binStep: step, lowerPct, upperPct });
    if (!plan) {
      badStep += 1;
      continue;
    }
    const tvl = tvlUsdOf(p);
    if (tvl < minTvl) {
      lowTvl += 1;
      continue;
    }
    if (plan.binCount > maxBins) {
      tooWide += 1;
      continue;
    }
    ranked.push({
      pool: addr,
      binStep: plan.binStep,
      tvl,
      feeRatio: n(p.fee_active_tvl_ratio) || 0,
      volumeTvl: volumeTvlRatio(p),
      binCount: plan.binCount,
      binsBelow: plan.binsBelow,
      binsAbove: plan.binsAbove,
    });
  }

  ranked.sort((a, b) => {
    if (b.feeRatio !== a.feeRatio) return b.feeRatio - a.feeRatio;
    if (b.volumeTvl !== a.volumeTvl) return b.volumeTvl - a.volumeTvl;
    if (a.binCount !== b.binCount) return a.binCount - b.binCount;
    return 0;
  });

  if (ranked.length === 0) {
    const own = (pools || []).filter((p) => {
      const addr = addrOf(p);
      return (
        addr &&
        !excluded.has(addr) &&
        !isCaPoolInvalid(addr) &&
        isMintSolPool(p, mint) &&
        p?.is_blacklisted !== true &&
        isDlmmPool(p)
      );
    });
    let reason = "tidak ada pool DLMM X/SOL untuk CA ini";
    if (own.length > 0) {
      const parts = [];
      if (lowTvl) parts.push(`${lowTvl} TVL < ${minTvl}`);
      if (tooWide) parts.push(`${tooWide} butuh > ${maxBins} bin`);
      if (badStep) parts.push(`${badStep} bin step tidak terbaca`);
      reason = parts.length ? `tidak ada pool yang lolos (${parts.join(", ")})` : "tidak ada pool yang lolos";
    }
    return { pool: null, reason, ranked, lowTvl, tooWide, badStep };
  }

  return { pool: ranked[0].pool, reason: null, ranked, lowTvl, tooWide, badStep, ...ranked[0] };
}

// Harga Jupiter <= harga entry → pemicu. Tidak memakai Supertrend.
// Harga terakhir disimpan supaya ringkasan log menampilkan harga yang dipantau.
export async function pollBidaskSolPrices(watches = [], deps = {}) {
  const fetchPrices = deps.getPrices || getPrices;
  const list = (watches || []).filter((w) => w?.mint && Number(w.entryPrice) > 0);
  if (list.length === 0) return { triggered: [] };

  const prices = await fetchPrices([...list.map((w) => w.mint), WSOL_MINT]);
  const last = getLastPrices();
  for (const [mint, value] of prices) {
    if (Number.isFinite(value)) last.set(mint, value);
  }

  const triggered = [];
  for (const w of list) {
    const price = prices.get(w.mint);
    if (!Number.isFinite(price)) continue;
    if (price <= Number(w.entryPrice)) {
      triggered.push({
        ...w,
        price,
        solPrice: prices.get(WSOL_MINT),
      });
    }
  }
  return { triggered };
}
