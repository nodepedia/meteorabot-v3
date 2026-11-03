import config from "../config/index.js";
import { WSOL_MINT, USDC_MINT } from "../core/constants.js";
import { readRuntimeStateStrict } from "../entry/runtime.js";
import { readStateStrict } from "../state/store.js";
import { getOpenPositionMints } from "../meteora/positions.js";

// Satu-satunya sumber kebenaran "mint mana yang TIDAK BOLEH di-swap".
// Dipakai oleh swap pasca-close (base + reward), swap tertunda, dan safety sweep.
//
// Sumber proteksi:
//  - WSOL, USDC, SWEEP_EXCLUDE_MINTS                       → "excluded"
//  - entryInProgressMints (entry/DCA in flight, rebalance
//    token BidAsk, reentry OOR kanan, fallback OOR kiri)    → "in_progress"
//  - protectedMints (`mint::tag`, TTL 30 menit)             → tag (mis. "oor_kanan_reentry")
//  - closingMints (close lain sedang berjalan)              → "closing"
//  - posisi terbuka di state.json (closed !== true)         → "open_position_state"
//  - posisi DLMM on-chain wallet (mint X & Y pool)          → "open_position_onchain"
//
// Bila salah satu sumber gagal dibaca (file rusak / RPC error) → throw
// ProtectionUnavailableError. Pemanggil WAJIB tidak swap (fail closed).

export class ProtectionUnavailableError extends Error {
  constructor(msg) {
    super(`proteksi swap tidak dapat ditentukan: ${msg}`);
    this.name = "ProtectionUnavailableError";
  }
}

const ONCHAIN_CACHE_MS = 10_000;
let onchainCache = { at: 0, data: null };

export function resetProtectionCache() {
  onchainCache = { at: 0, data: null };
}

function add(map, mint, reason) {
  if (!mint || mint === "SOL") return;
  if (!map.has(mint)) map.set(mint, new Set());
  map.get(mint).add(reason);
}

/**
 * @param {object} opts
 * @param {string[]} [opts.ignorePositions] posisi yang sedang ditutup oleh pemanggil (mint-nya tidak dihitung "terbuka")
 * @param {boolean} [opts.ignoreClosingLocks] abaikan closingMints (pemanggil = pemilik lock close)
 * @param {boolean} [opts.useCache] boleh pakai cache on-chain (≤10s)
 * @returns {Promise<Map<string, Set<string>>>} mint → alasan proteksi
 */
export async function getProtectedMints({
  ignorePositions = [],
  ignoreClosingLocks = false,
  useCache = true,
  deps = {},
} = {}) {
  const readRuntime = deps.readRuntime || readRuntimeStateStrict;
  const readState = deps.readState || readStateStrict;
  const fetchOnchain = deps.fetchOnchain || getOpenPositionMints;
  const now = deps.now ?? Date.now();
  const ignore = new Set(ignorePositions.filter(Boolean));
  const out = new Map();

  add(out, WSOL_MINT, "excluded");
  add(out, USDC_MINT, "excluded");
  for (const m of config.swap.excludeMints || []) add(out, String(m).trim(), "excluded");

  let rt;
  try {
    rt = readRuntime(now);
  } catch (err) {
    throw new ProtectionUnavailableError(err.message);
  }
  for (const m of Object.keys(rt.entryInProgressMints || {})) add(out, m, "in_progress");
  for (const key of Object.keys(rt.protectedMints || {})) {
    const idx = key.indexOf("::");
    add(out, idx > 0 ? key.slice(0, idx) : key, idx > 0 ? key.slice(idx + 2) : "protected");
  }
  if (!ignoreClosingLocks) for (const m of Object.keys(rt.closingMints || {})) add(out, m, "closing");

  let st;
  try {
    st = readState();
  } catch (err) {
    throw new ProtectionUnavailableError(err.message);
  }
  for (const p of Object.values(st.positions || {})) {
    if (!p || p.closed === true || ignore.has(p.position)) continue;
    add(out, p.baseMint, "open_position_state");
  }

  let onchain;
  if (useCache && onchainCache.data && now - onchainCache.at < ONCHAIN_CACHE_MS) {
    onchain = onchainCache.data;
  } else {
    try {
      onchain = await fetchOnchain();
    } catch (err) {
      throw new ProtectionUnavailableError(`posisi on-chain: ${err.message}`);
    }
    if (!Array.isArray(onchain)) throw new ProtectionUnavailableError("posisi on-chain tidak terbaca");
    onchainCache = { at: now, data: onchain };
  }
  for (const p of onchain) {
    if (ignore.has(p.position)) continue;
    for (const m of p.mints || []) add(out, m, "open_position_onchain");
  }

  return out;
}

export function describeProtection(map, mint) {
  return [...(map.get(mint) || [])].join(",");
}
