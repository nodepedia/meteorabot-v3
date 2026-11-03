import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getTokenBalanceStrict, getTokenValueUsd } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { getOpenTrackedPositions } from "../state/positions.js";
import { getPendingSwaps, upsertPendingSwap, removePendingSwap, recordAction } from "../entry/runtime.js";
import { deactivatePool } from "../entry/index.js";
import { getProtectedMints, describeProtection } from "./protection.js";

// Swap token → SOL yang dijaga proteksi (lihat exit/protection.js).
// Return per mint: swapped | protected | empty | failed. Bila proteksi tidak
// bisa ditentukan → semua mint "failed" dengan unavailable=true (fail closed).
export async function swapMintsToSol(mints, opts = {}) {
  const {
    ignorePositions = [],
    swapOpts = {},
    deps = {},
  } = opts;
  const protectionFn = deps.getProtectedMints || getProtectedMints;
  const balanceFn = deps.getTokenBalance || getTokenBalanceStrict;
  const valueFn = deps.getTokenValueUsd || getTokenValueUsd;
  const swapFn = deps.swapToSol || swapToSol;
  const out = { swapped: [], protected: [], empty: [], failed: [], unavailable: false };
  const list = [...new Set((mints || []).filter(Boolean))];
  if (list.length === 0) return out;

  let prot;
  try {
    prot = await protectionFn({ ignorePositions, ignoreClosingLocks: true, useCache: false });
  } catch (err) {
    log.warn(`Swap ditunda: ${err.message}`);
    out.unavailable = true;
    for (const mint of list) out.failed.push({ mint, error: err.message, unpriced: false });
    return out;
  }

  for (const mint of list) {
    if (prot.has(mint)) {
      log.info(`Swap ${mint.slice(0, 8)} dilewati — mint dilindungi (${describeProtection(prot, mint)})`);
      out.protected.push(mint);
      continue;
    }
    let balance;
    try {
      balance = await balanceFn(mint);
    } catch (err) {
      out.failed.push({ mint, error: `saldo tidak terbaca: ${err.message}`, unpriced: false });
      continue;
    }
    if (!(balance > 0)) {
      out.empty.push(mint);
      continue;
    }
    const res = await swapFn(mint, balance, swapOpts);
    if (res?.success) {
      out.swapped.push(mint);
      continue;
    }
    const valueUsd = await valueFn(mint, balance);
    out.failed.push({ mint, error: String(res?.error || "unknown").split("\n")[0], unpriced: valueUsd == null });
  }
  return out;
}

export function enqueuePendingSwap({ mint, pool, pair, reason, deactivate = true, now = Date.now() }) {
  if (!mint) return;
  const cur = getPendingSwaps()[mint];
  const pools = new Set(cur?.pools || []);
  if (pool) pools.add(pool);
  const deactivatePools = new Set(cur?.deactivatePools || []);
  if (pool && deactivate) deactivatePools.add(pool);
  upsertPendingSwap(mint, {
    pools: [...pools],
    deactivatePools: [...deactivatePools],
    pair: pair || cur?.pair || "",
    reason: reason || cur?.reason || "",
    attempts: cur?.attempts || 0,
    unpricedAttempts: cur?.unpricedAttempts || 0,
    createdAt: cur?.createdAt || now,
    nextAt: now + retryMs(),
  });
  log.warn(`${pair || mint.slice(0, 8)}: swap ${mint.slice(0, 8)} → SOL TERTUNDA — dicoba ulang tiap ${retryMs() / 1000}s`);
}

function retryMs() {
  return Math.max(10, Number(config.swap.pendingRetrySec) || 90) * 1000;
}

function finalizePools(entry, deps) {
  const deactivate = deps.deactivatePool || deactivatePool;
  const openTracked = (deps.getOpenTrackedPositions || getOpenTrackedPositions)();
  const pending = getPendingSwaps();
  for (const pool of entry.deactivatePools || []) {
    if (openTracked.some((p) => p.pool === pool)) continue;
    const otherPending = Object.values(pending).some(
      (p) => p.mint !== entry.mint && Array.isArray(p.pools) && p.pools.includes(pool)
    );
    if (otherPending) continue;
    deactivate(pool, "entry+exit selesai (swap tuntas)");
  }
}

// Dipanggil tiap siklus exit. Satu percobaan swap per mint yang jatuh tempo.
export async function processPendingSwaps({ now = Date.now(), deps = {} } = {}) {
  const pending = Object.values(getPendingSwaps());
  const due = pending.filter((p) => !(Number(p.nextAt) > now));
  const summary = { resolved: [], gaveUp: [], retry: [], protected: [], unavailable: false };
  if (due.length === 0) return summary;

  const maxAttempts = Math.max(1, Number(config.swap.pendingMaxAttempts) || 10);
  const maxUnpriced = Math.max(1, Number(config.swap.unpricedMaxAttempts) || 3);
  const notifyGiveUp = deps.notifySwapGiveUp || tg.notifySwapGiveUp;

  const res = await swapMintsToSol(
    due.map((p) => p.mint),
    { swapOpts: { maxAttempts: 1 }, deps }
  );
  if (res.unavailable) {
    // Fail closed: tidak swap, tidak hitung percobaan.
    for (const p of due) upsertPendingSwap(p.mint, { nextAt: now + retryMs() });
    summary.unavailable = true;
    return summary;
  }

  const done = new Set([...res.swapped, ...res.empty]);
  for (const p of due) {
    const label = p.pair || p.mint.slice(0, 8);
    if (done.has(p.mint)) {
      removePendingSwap(p.mint);
      log.info(`${label}: swap tertunda ${p.mint.slice(0, 8)} tuntas → SOL`);
      recordAction(`SWAP ${label} tuntas → SOL (tertunda)`);
      finalizePools(p, deps);
      summary.resolved.push(p.mint);
      continue;
    }
    if (res.protected.includes(p.mint)) {
      // Token sedang dibutuhkan (posisi aktif/rebalance) — tunggu, bukan gagal.
      upsertPendingSwap(p.mint, { nextAt: now + retryMs() });
      summary.protected.push(p.mint);
      continue;
    }
    const fail = res.failed.find((f) => f.mint === p.mint);
    const attempts = (p.attempts || 0) + 1;
    const unpricedAttempts = (p.unpricedAttempts || 0) + (fail?.unpriced ? 1 : 0);
    const giveUpReason =
      unpricedAttempts >= maxUnpriced
        ? `token tidak punya harga (gagal ${unpricedAttempts}x)`
        : attempts >= maxAttempts
          ? `gagal ${attempts}x`
          : null;
    if (giveUpReason) {
      removePendingSwap(p.mint);
      log.error(`${label}: swap ${p.mint.slice(0, 8)} DIHENTIKAN — ${giveUpReason}: ${fail?.error || "?"}`);
      recordAction(`SWAP ${label} DIHENTIKAN — ${giveUpReason}`);
      notifyGiveUp({ mint: p.mint, pair: p.pair, attempts, reason: giveUpReason, error: fail?.error });
      finalizePools(p, deps);
      summary.gaveUp.push(p.mint);
      continue;
    }
    upsertPendingSwap(p.mint, { attempts, unpricedAttempts, lastError: fail?.error || null, nextAt: now + retryMs() });
    summary.retry.push(p.mint);
  }
  return summary;
}
