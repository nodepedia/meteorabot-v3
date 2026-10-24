import path from "path";
import { fileURLToPath } from "url";
import config from "./config/index.js";
import log from "./core/logger.js";
import { sleep, minutes } from "./core/utils.js";
import { clock, fmtPct } from "./core/report.js";
import { getWalletBalances } from "./solana/balances.js";
import { runSafetySweep } from "./exit/sweep.js";
import { readState } from "./state/store.js";
import {
  getEntryInProgressMints,
  getEntryInProgressPools,
  getClosingPools,
  getClosingMints,
  setWalletStatus,
} from "./entry/runtime.js";

const DEFAULT_SWEEP_INTERVAL_SEC = 15;
const LOW_GAS_WARN_COOLDOWN_MS = 5 * 60 * 1000;

let lastLowGasWarnAt = 0;
let lastSummaryAt = 0;
let walletCycleCount = 0;

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const pmExec = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
  return arg1 === self || pmExec === self;
}

export function computeTrackedPnlSummary(stateObj = readState()) {
  const positions = Object.values(stateObj?.positions || {});
  let openCount = 0;
  let closedCount = 0;
  let wins = 0;
  let losses = 0;
  let sumRealizedPct = 0;
  let realizedCount = 0;

  for (const p of positions) {
    if (!p) continue;
    if (p.closed) {
      closedCount++;
      const pnl = Number(p.realizedPnlPct);
      if (Number.isFinite(pnl)) {
        realizedCount++;
        sumRealizedPct += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }
    } else {
      openCount++;
    }
  }

  return {
    openCount,
    closedCount,
    wins,
    losses,
    avgRealizedPct: realizedCount > 0 ? sumRealizedPct / realizedCount : null,
  };
}

export function buildWalletSummary({
  now = Date.now(),
  balances = { sol: 0, tokens: [] },
  gasReserve = Number(config.entry.gasReserve) || 0,
  locks = { entryMints: [], closingMints: [], entryPools: [], closingPools: [] },
  pnl = { openCount: 0, closedCount: 0, wins: 0, losses: 0, avgRealizedPct: null },
} = {}) {
  const bar = "─".repeat(60);
  const sol = Number(balances?.sol) || 0;
  const reserveOk = sol >= gasReserve;
  const lines = [
    bar,
    `  Meteora Wallet Worker — RINGKASAN   ${clock(now)}`,
    bar,
    `Saldo SOL : ${sol.toFixed(4)} SOL | cadangan gas ${gasReserve.toFixed(4)} SOL (${reserveOk ? "AMAN" : "RENDAH"})`,
    `Token SPL : ${balances?.tokens?.length || 0} token non-SOL di wallet`,
  ];

  for (const t of balances?.tokens || []) {
    const usdTxt = t.usd != null ? ` (~$${t.usd.toFixed(2)})` : "";
    lines.push(`  • ${t.symbol || t.mint.slice(0, 8)} : ${t.balance}${usdTxt}`);
  }

  lines.push(
    `Lock Aktif: entryMints=${locks.entryMints.length} | closingMints=${locks.closingMints.length} | entryPools=${locks.entryPools.length} | closingPools=${locks.closingPools.length}`
  );
  const avgTxt = pnl.avgRealizedPct != null ? fmtPct(pnl.avgRealizedPct) : "-";
  lines.push(
    `Stat Posisi: open=${pnl.openCount} | closed=${pnl.closedCount} (W:${pnl.wins} / L:${pnl.losses} | rata-rata PnL ${avgTxt})`
  );

  return lines.join("\n");
}

export async function runWalletCycle({
  sweepFn = runSafetySweep,
  balancesFn = getWalletBalances,
  now = Date.now(),
} = {}) {
  walletCycleCount++;
  log.debug(`[detail] wallet cycle #${walletCycleCount}`);

  const sweepResult = await sweepFn();
  const balances = await balancesFn();

  const sol = Number(balances?.sol) || 0;
  const gasReserve = Number(config.entry.gasReserve) || 0;
  const lowGas = sol < gasReserve;

  if (lowGas && now - lastLowGasWarnAt >= LOW_GAS_WARN_COOLDOWN_MS) {
    lastLowGasWarnAt = now;
    log.warn(`Wallet SOL rendah: ${sol.toFixed(4)} SOL < cadangan gas ${gasReserve.toFixed(4)} SOL`);
  }

  const entryMints = [...getEntryInProgressMints()];
  const closingMints = [...getClosingMints()];
  const entryPools = [...getEntryInProgressPools()];
  const closingPools = [...getClosingPools()];

  const status = {
    sol,
    gasReserve,
    lowGas,
    tokenCount: Array.isArray(balances?.tokens) ? balances.tokens.length : 0,
    tokens: Array.isArray(balances?.tokens) ? balances.tokens : [],
    lastSweepAt: now,
    lastSweepSwapped: sweepResult?.swapped || 0,
    lastSweepFailedMints: sweepResult?.failedMints || [],
    updatedAt: now,
  };
  setWalletStatus(status);

  const summaryIntervalMs = minutes(Number(process.env.WALLET_SUMMARY_INTERVAL_MIN) || config.tgStatusInterval || 5);
  if (lastSummaryAt === 0 || now - lastSummaryAt >= summaryIntervalMs) {
    lastSummaryAt = now;
    const pnl = computeTrackedPnlSummary();
    const block = buildWalletSummary({
      now,
      balances,
      gasReserve,
      locks: { entryMints, closingMints, entryPools, closingPools },
      pnl,
    });
    log.info("\n" + block);
  }

  return { sweepResult, status };
}

export async function startWalletWorker(opts = {}) {
  const intervalSec = Math.max(
    3,
    Number(opts.intervalSec || process.env.WALLET_SWEEP_INTERVAL_SEC || DEFAULT_SWEEP_INTERVAL_SEC)
  );

  log.info("========================================");
  log.info("  Meteora Worker [3/3]: WALLET & SWEEP");
  log.info(`  Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} (dari .env) | SOL_MODE: ${config.solMode} (strat.conf/.env)`);
  log.info(
    `  Wallet: safety sweep tiap ${intervalSec}s | dust <= $${config.swap.dustUsdThreshold} | gas reserve ${config.entry.gasReserve} SOL`
  );
  log.info("========================================");

  if (!config.walletPrivateKey) {
    log.error("WALLET_PRIVATE_KEY is not set — exiting");
    process.exit(1);
  }

  while (true) {
    try {
      await runWalletCycle();
    } catch (err) {
      log.error(`Wallet cycle error: ${err.message}`);
    }
    await sleep(intervalSec * 1000);
  }
}

if (isDirectRun(import.meta.url)) {
  startWalletWorker().catch((err) => {
    log.error(`Fatal error in worker-wallet: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
