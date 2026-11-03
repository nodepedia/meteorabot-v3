import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getPendingSwaps, recordAction } from "../entry/runtime.js";
import { sweepToSol } from "../solana/swap.js";
import { getProtectedMints } from "./protection.js";

const sweepFailedUntil = new Map();
// Token tanpa harga yang terus gagal di-swap: berhenti setelah N siklus + alert.
const unpricedFailures = new Map();
const unpricedGaveUp = new Set();

export function resetSweepState() {
  sweepFailedUntil.clear();
  unpricedFailures.clear();
  unpricedGaveUp.clear();
}

// Safety sweep: swap token yatim (Token Program klasik + Token-2022) ke SOL.
// Mint yang dilindungi (exit/protection.js) TIDAK disentuh; dicek di awal dan
// ulang tepat sebelum tiap swap. Proteksi tak terbaca → sweep dilewati (fail closed).
// Mint di antrean swap tertunda ditangani exit/pending-swaps.js, bukan sweep.
export async function runSafetySweep(deps = {}) {
  const protectionFn = deps.getProtectedMints || getProtectedMints;
  const sweepFn = deps.sweepToSol || sweepToSol;
  const notifyGiveUp = deps.notifySwapGiveUp || tg.notifySwapGiveUp;
  const now = Date.now();

  let prot;
  try {
    prot = await protectionFn();
  } catch (err) {
    log.warn(`Safety sweep dilewati: ${err.message} (fail closed)`);
    return { swapped: 0, totalAmount: 0, failedMints: [], excludedMints: [], skipped: true, failClosed: true };
  }

  const exclude = new Set(prot.keys());
  for (const mint of Object.keys(getPendingSwaps())) exclude.add(mint);
  for (const mint of unpricedGaveUp) exclude.add(mint);
  for (const [mint, until] of sweepFailedUntil) {
    if (now < until) exclude.add(mint);
    else sweepFailedUntil.delete(mint);
  }

  const excludedMints = [...exclude];
  const result = await sweepFn({
    excludeMints: excludedMints,
    // Cek ulang sebelum tiap swap (lock rebalance/reentry bisa muncul di tengah sweep).
    isProtected: async (mint) => {
      const fresh = await protectionFn();
      return fresh.has(mint) || Object.prototype.hasOwnProperty.call(getPendingSwaps(), mint);
    },
  });

  const cooldownMs = Math.max(0, Number(config.swap.failureCooldownSec) || 0) * 1000;
  if (cooldownMs > 0) {
    for (const mint of result?.failedMints || []) sweepFailedUntil.set(mint, Date.now() + cooldownMs);
  }

  const maxUnpriced = Math.max(1, Number(config.swap.unpricedMaxAttempts) || 3);
  const unpriced = new Set(result?.unpricedFailedMints || []);
  for (const mint of unpriced) {
    const n = (unpricedFailures.get(mint) || 0) + 1;
    unpricedFailures.set(mint, n);
    if (n >= maxUnpriced && !unpricedGaveUp.has(mint)) {
      unpricedGaveUp.add(mint);
      log.error(`Sweep ${mint.slice(0, 8)} DIHENTIKAN — token tanpa harga gagal ${n}x`);
      notifyGiveUp({ mint, pair: null, attempts: n, reason: `sweep: token tidak punya harga (gagal ${n}x)` });
    }
  }

  if (result?.swapped > 0) recordAction(`SWEEP ${result.swapped} token yatim → SOL`);

  return { ...(result || { swapped: 0, totalAmount: 0, failedMints: [] }), excludedMints };
}
