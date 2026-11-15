import path from "path";
import { fileURLToPath } from "url";
import config from "./config/index.js";
import log from "./core/logger.js";
import { sleep } from "./core/utils.js";
import { getUpdates } from "./notify/telegram.js";
import { handleCallbackQuery } from "./notify/telegram-callbacks.js";
import { readTelegramOffset, writeTelegramOffset } from "./notify/telegram-queue.js";

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const pmExec = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
  return arg1 === self || pmExec === self;
}

// Hanya callback_query yang diproses. Update lain diabaikan, offset tetap maju
// supaya antrean Telegram tidak macet.
export async function processTelegramUpdates(updates, deps = {}) {
  const handle = deps.handleCallback || ((query) => handleCallbackQuery(query, deps));
  let nextOffset = deps.offset ?? null;
  for (const update of updates || []) {
    if (update?.callback_query) {
      try {
        await handle(update.callback_query);
      } catch (err) {
        log.warn(`Callback Telegram gagal: ${err.message}`);
      }
    }
    if (Number.isFinite(Number(update?.update_id))) {
      nextOffset = Number(update.update_id) + 1;
    }
  }
  if (nextOffset != null && deps.writeOffset) deps.writeOffset(nextOffset);
  return nextOffset;
}

export async function runTelegramPollLoop(deps = {}) {
  const getUpdatesFn = deps.getUpdates || getUpdates;
  const readOffset = deps.readOffset || readTelegramOffset;
  const writeOffset = deps.writeOffset || writeTelegramOffset;
  const timeoutSec = deps.timeoutSec ?? 30;
  const retryMs = deps.retryMs ?? 3000;
  let offset = readOffset();

  while (!deps.shouldStop?.()) {
    let res = null;
    try {
      res = await getUpdatesFn({ offset, timeoutSec });
    } catch (err) {
      log.warn(`getUpdates gagal: ${err.message}`);
      if (deps.once) break;
      await sleep(retryMs);
      continue;
    }
    if (res == null || res.ok === false) {
      if (deps.once) break;
      await sleep(retryMs);
      continue;
    }
    const updates = Array.isArray(res.result) ? res.result : [];
    if (updates.length) {
      offset = await processTelegramUpdates(updates, { ...deps, offset, writeOffset });
    }
    if (deps.once) break;
  }
  return offset;
}

export async function startTelegramWorker() {
  log.info("========================================");
  log.info("  Meteora Worker: TELEGRAM BUTTONS");
  log.info(
    `  Tombol: ${config.telegramButtonsEnabled ? "ON" : "OFF"} | chat ${config.telegramChatId || "?"} | hanya callback chat ini`
  );
  log.info("========================================");

  if (!config.telegramBotToken || !config.telegramChatId) {
    log.error("TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID kosong — worker telegram berhenti");
    process.exit(1);
  }

  await runTelegramPollLoop();
}

if (isDirectRun(import.meta.url)) {
  startTelegramWorker().catch((err) => {
    log.error(`Fatal error in worker-telegram: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
