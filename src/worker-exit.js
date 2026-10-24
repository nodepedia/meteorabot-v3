import path from "path";
import { fileURLToPath } from "url";
import config from "./config/index.js";
import log from "./core/logger.js";
import { mainLoop } from "./exit/index.js";

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const pmExec = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
  return arg1 === self || pmExec === self;
}

export async function startExitWorker(opts = {}) {
  const { runSweep = process.env.EXIT_INLINE_SWEEP === "true" } = opts;

  log.info("========================================");
  log.info("  Meteora Worker [2/3]: EXIT MONITOR");
  log.info(`  Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} (dari .env) | SOL_MODE: ${config.solMode} (strat.conf/.env)`);
  log.info(
    `  Exit: hold poll ${Math.round(config.pollIntervalHold * 60)}s | idle poll ${config.pollIntervalIdle}m | inline sweep: ${runSweep ? "ON" : "OFF (delegated to worker-wallet)"}`
  );
  log.info("========================================");

  if (!config.walletPrivateKey) {
    log.error("WALLET_PRIVATE_KEY is not set — exiting");
    process.exit(1);
  }

  await mainLoop({ runSweep });
}

if (isDirectRun(import.meta.url)) {
  startExitWorker().catch((err) => {
    log.error(`Fatal error in worker-exit: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
