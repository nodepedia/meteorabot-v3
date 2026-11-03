// Resolve baris CA pool.txt → pool DLMM paling efisien untuk mint itu.
// Sumber: pool-discovery-api Meteora (sama dengan meteora-pool-monitor), timeframe 30m.
// Hasil per mint di-cache CA_POOL_CACHE_SEC (default 60s) supaya hemat request.
import config from "../config/index.js";
import log from "../core/logger.js";

const API = "https://pool-discovery-api.datapi.meteora.ag/pools";
const cache = new Map(); // mint -> { at, pools }

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};
const binStepOf = (p) => n(p?.dlmm_params?.bin_step ?? p?.bin_step);
const SOL = "So11111111111111111111111111111111111111112";
const mintsOf = (p) => [p?.token_x?.address, p?.token_y?.address].filter(Boolean);
// Bot hanya mendukung pair X/SOL, jadi pool non-SOL tidak dipertimbangkan.
const isMintSolPool = (p, mint) => {
  const m = mintsOf(p);
  return m.includes(SOL) && (!mint || m.includes(mint));
};

export function poolPassesCaFilter(p, cfg = config.entry) {
  const bs = binStepOf(p);
  return (
    n(p?.volume) >= cfg.caMinVolume30m &&
    n(p?.fee_pct) >= cfg.caMinBaseFeePct &&
    n(p?.fee_active_tvl_ratio) >= cfg.caMinFeeActiveTvlPct &&
    bs >= cfg.caMinBinStep &&
    bs <= cfg.caMaxBinStep
  );
}

// Murni: pilih fee_active_tvl_ratio tertinggi di antara pool mint yang lolos filter.
export function pickBestPool(pools, mint, cfg = config.entry) {
  const own = (pools || []).filter((p) => p?.address && isMintSolPool(p, mint));
  const ok = own.filter((p) => poolPassesCaFilter(p, cfg));
  if (ok.length === 0) {
    return { pool: null, reason: own.length === 0 ? "tidak ada pool DLMM X/SOL untuk CA ini" : `tidak ada dari ${own.length} pool yang lolos filter` };
  }
  ok.sort((a, b) => n(b.fee_active_tvl_ratio) - n(a.fee_active_tvl_ratio));
  return { pool: ok[0].address, ratio: n(ok[0].fee_active_tvl_ratio), candidates: own.length };
}

export async function fetchMintPools(mint, fetchFn = fetch) {
  const url = `${API}?page_size=50&timeframe=30m&pool_type=dlmm&query=${encodeURIComponent(mint)}`;
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`meteora pools HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : j?.data || j?.pools || [];
}

export async function resolveCaPool(mint, { fetchFn = fetch, now = Date.now(), cfg = config.entry } = {}) {
  let hit = cache.get(mint);
  if (!hit || now - hit.at > cfg.caCacheSec * 1000) {
    try {
      hit = { at: now, pools: await fetchMintPools(mint, fetchFn) };
      cache.set(mint, hit);
    } catch (err) {
      log.warn(`CA ${mint.slice(0, 8)} gagal ambil pool Meteora: ${err.message} — skip siklus ini`);
      return { pool: null, reason: err.message };
    }
  }
  return pickBestPool(hit.pools, mint, cfg);
}

export function _clearCaCache() {
  cache.clear();
}
