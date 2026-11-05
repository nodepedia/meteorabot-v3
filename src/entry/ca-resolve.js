// Resolve baris CA pool.txt → pool DLMM paling efisien untuk mint itu.
// Sumber: pool-discovery-api Meteora (sama dengan meteora-pool-monitor), timeframe 30m.
// Tanpa filter efisiensi: pool DLMM X/SOL dengan fee/active TVL 30m tertinggi.
// API kadang menyertakan DAMM v2 meski query pool_type=dlmm — disaring di sini.
// Hasil per mint di-cache CA_POOL_CACHE_SEC (default 60s) supaya hemat request.
import config from "../config/index.js";
import log from "../core/logger.js";

const API = "https://pool-discovery-api.datapi.meteora.ag/pools";
const cache = new Map(); // mint -> { at, pools }
// Pool yang gagal dibaca sebagai DLMM (mis. discriminator DAMM) — jangan dipilih lagi.
const invalidPools = new Map(); // poolAddress -> { at, reason }

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};
const binStepOf = (p) => n(p?.dlmm_params?.bin_step ?? p?.bin_step);
const SOL = "So11111111111111111111111111111111111111112";
const mintsOf = (p) => [p?.token_x?.address, p?.token_y?.address].filter(Boolean);
// API pool-discovery mengembalikan `pool_address`; `address` hanya fallback.
export const addrOf = (p) => p?.pool_address || p?.address || null;
// Bot hanya mendukung pair X/SOL, jadi pool non-SOL tidak dipertimbangkan.
const isMintSolPool = (p, mint) => {
  const m = mintsOf(p);
  return m.includes(SOL) && (!mint || m.includes(mint));
};

// Hanya kandidat DLMM. Query API memakai pool_type=dlmm tetapi respons sering
// masih berisi damm_v2; tanpa filter ini bot bisa memilih pool non-DLMM dan
// gagal terus di DLMM.create ("Invalid account discriminator").
export function isDlmmPool(p) {
  if (!p || typeof p !== "object") return false;
  const t = String(p.pool_type || "").trim().toLowerCase();
  if (t && t !== "dlmm") return false;
  // pool_type kosong/dlmm: damm_v2_params tanpa dlmm_params = bukan DLMM.
  if (p.dlmm_params == null && p.damm_v2_params) return false;
  return true;
}

export function markCaPoolInvalid(poolAddress, reason = "not_dlmm") {
  if (!poolAddress) return;
  invalidPools.set(poolAddress, { at: Date.now(), reason: String(reason || "not_dlmm") });
}

export function isCaPoolInvalid(poolAddress) {
  return Boolean(poolAddress) && invalidPools.has(poolAddress);
}

// Murni: baris CA tidak memakai filter efisiensi — pilih pool DLMM X/SOL dengan
// fee/active TVL 30m tertinggi (pool blacklist Meteora & non-DLMM dilewati).
export function pickBestPool(pools, mint, { exclude = [] } = {}) {
  const excluded = new Set([...(exclude || []), ...invalidPools.keys()].filter(Boolean));
  const own = (pools || []).filter((p) => {
    const addr = addrOf(p);
    if (!addr || excluded.has(addr)) return false;
    if (!isMintSolPool(p, mint)) return false;
    if (p?.is_blacklisted === true) return false;
    if (!isDlmmPool(p)) return false;
    return true;
  });
  if (own.length === 0) return { pool: null, reason: "tidak ada pool DLMM X/SOL untuk CA ini" };
  const best = [...own].sort((a, b) => (n(b.fee_active_tvl_ratio) || 0) - (n(a.fee_active_tvl_ratio) || 0))[0];
  return { pool: addrOf(best), ratio: n(best.fee_active_tvl_ratio), candidates: own.length };
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
  return pickBestPool(hit.pools, mint);
}

// Rate-limit log skip: maksimal 1x per CA per intervalMs (default 10 menit).
const skipLogAt = new Map();
export function shouldLogCaSkip(mint, now = Date.now(), intervalMs = 10 * 60 * 1000) {
  const last = skipLogAt.get(mint);
  if (last !== undefined && now - last < intervalMs) return false;
  skipLogAt.set(mint, now);
  return true;
}

export function _clearCaCache() {
  cache.clear();
  skipLogAt.clear();
  invalidPools.clear();
}
