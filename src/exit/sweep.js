import config from "../config/index.js";
import { getEntryInProgressMints, getClosingMints, recordAction } from "../entry/runtime.js";
import { sweepToSol } from "../solana/swap.js";

const sweepFailedUntil = new Map();

// Safety sweep: swap every token balance to SOL except the configured
// exclusions (default USDC), WSOL, tokens being acquired by an in-flight
// entry/DCA/fallback, and tokens currently being closed/swapped by exit.
// Mints that fail to swap get a per-mint backoff.
export async function runSafetySweep() {
  const now = Date.now();
  const exclude = new Set(config.swap.excludeMints || []);
  for (const mint of getEntryInProgressMints()) exclude.add(mint);
  for (const mint of getClosingMints()) exclude.add(mint);
  for (const [mint, until] of sweepFailedUntil) {
    if (now < until) exclude.add(mint);
    else sweepFailedUntil.delete(mint);
  }

  const excludedMints = [...exclude];
  const result = await sweepToSol({ excludeMints: excludedMints });

  const cooldownMs = Math.max(0, Number(config.swap.failureCooldownSec) || 0) * 1000;
  if (cooldownMs > 0) {
    for (const mint of result?.failedMints || []) {
      sweepFailedUntil.set(mint, Date.now() + cooldownMs);
    }
  }

  if (result?.swapped > 0) {
    recordAction(`SWEEP ${result.swapped} token yatim → SOL`);
  }

  return { ...(result || { swapped: 0, totalAmount: 0, failedMints: [] }), excludedMints };
}
