import { getPoolInfo } from "./pool-info.js";
import { poolPriceSolPerToken } from "./price-guard.js";

// Harga pool (SOL per token) dari bin aktif. Sama dengan sumber `entryPoolPrice`
// saat posisi dibuka, jadi persen turunnya apel-ke-apel.
//
// Bukan harga Jupiter: Jupiter sudah di-poll untuk sinyal entry, tetapi boleh
// selisih dari pool sampai ambang rem harga (ENTRY_MAX_POOL_PRICE_DEVIATION_PCT).
// DCA dan rebalance harus ikut harga pool yang benar-benar dipegang posisi.
//
// Beban RPC: instance DLMM di-cache (create mahal). Tiap baca segar memanggil
// `getActiveBin` sekali per pool (akun lbPair + satu bin array), lalu dipakai
// bersama semua posisi pool itu. Cache harga singkat supaya satu tick tidak
// meminta dua kali, tick berikutnya (DCA 5 dtk / exit ~12 dtk) membaca ulang.

const INSTANCE_TTL_MS = 5 * 60 * 1000;
const PRICE_TTL_MS = 3000;

const instanceCache = new Map();
const priceCache = new Map();

export function resetPoolPriceCache() {
  instanceCache.clear();
  priceCache.clear();
}

export async function readPoolSolPerToken(poolAddress, deps = {}) {
  if (!poolAddress) return null;
  const now = deps.now ?? Date.now();
  const ttl = Number.isFinite(Number(deps.priceTtlMs)) ? Number(deps.priceTtlMs) : PRICE_TTL_MS;
  const hit = priceCache.get(poolAddress);
  if (hit && hit.value != null && now - hit.at < ttl && !deps.force) return hit.value;

  const getInfo = deps.getPoolInfo || getPoolInfo;
  let inst = instanceCache.get(poolAddress);
  if (!inst || now - inst.at > INSTANCE_TTL_MS) {
    const info = await getInfo(poolAddress);
    inst = { pool: info?.pool, baseIsX: info?.baseIsX, unsupported: info?.unsupported === true, at: now };
    instanceCache.set(poolAddress, inst);
  }
  if (inst.unsupported || !inst.pool || typeof inst.pool.getActiveBin !== "function") return null;

  try {
    const activeBin = await inst.pool.getActiveBin();
    const value = poolPriceSolPerToken(activeBin, inst.baseIsX);
    if (value != null) priceCache.set(poolAddress, { at: now, value });
    return value;
  } catch (err) {
    instanceCache.delete(poolAddress);
    priceCache.delete(poolAddress);
    if (deps._retried) throw err;
    return readPoolSolPerToken(poolAddress, { ...deps, _retried: true, force: true });
  }
}
