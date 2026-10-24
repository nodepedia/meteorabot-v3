import path from "path";
import { fileURLToPath } from "url";
import config, { BINS_BELOW, BINS_ABOVE, STRATEGY } from "./config/index.js";
import log from "./core/logger.js";
import * as tg from "./notify/telegram.js";
import { startEntryScanner, getPoolNames } from "./entry/index.js";
import { startDcaWatcher } from "./entry/dca.js";

const STRATEGY_LABEL = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const pmExec = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
  return arg1 === self || pmExec === self;
}

export async function startEntryWorker() {
  log.info("========================================");
  log.info("  Meteora Worker [1/3]: ENTRY + DCA");
  log.info(`  Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} (dari .env) | SOL_MODE: ${config.solMode} (strat.conf/.env)`);
  log.info(
    `  Entry: per-pool size from ${config.entry.poolListFile} | split ${config.entry.sizeSplit} | bins -34/+34 BidAsk | kandidat ${config.entry.scanIntervalSec}s | Jupiter poll ${config.jupiterPollIntervalSec}s`
  );
  log.info("========================================");

  if (!config.walletPrivateKey) {
    log.error("WALLET_PRIVATE_KEY is not set — exiting");
    process.exit(1);
  }

  const poolNames = await getPoolNames();

  tg.notifyStartup({
    mode: config.dryRun ? "DRY RUN" : "LIVE",
    strategy: STRATEGY_LABEL[STRATEGY] || STRATEGY,
    binsBelow: BINS_BELOW,
    binsAbove: BINS_ABOVE,
    sizeSplit: config.entry.sizeSplit,
    scanIntervalSec: config.entry.scanIntervalSec,
    jupiterPollIntervalSec: config.jupiterPollIntervalSec,
    timeframe: config.entry.timeframe,
    expiryHours: config.entry.expiryHours,
    poolNames,
  });

  const scanner = startEntryScanner();
  const dca = startDcaWatcher();

  const shutdown = (sig) => {
    log.info(`Entry worker menerima ${sig} — menghentikan timer...`);
    if (scanner?.slowTimer) clearInterval(scanner.slowTimer);
    if (scanner?.fastTimer) clearInterval(scanner.fastTimer);
    if (dca?.timer) clearInterval(dca.timer);
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return { scanner, dca };
}

if (isDirectRun(import.meta.url)) {
  startEntryWorker().catch((err) => {
    log.error(`Fatal error in worker-entry: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
