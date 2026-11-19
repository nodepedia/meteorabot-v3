import path from "path";
import { fileURLToPath } from "url";
import config from "./config/index.js";
import log from "./core/logger.js";
import { WSOL_MINT } from "./core/constants.js";
import { sleep } from "./core/utils.js";
import { fetchMintPools } from "./entry/ca-resolve.js";
import { bidaskSolQuotePrice } from "./entry/bidask-sol-entry.js";
import { appendCaEntryLine, commentPoolInList, poolListFilePath } from "./entry/pool-list.js";
import { getPrices } from "./market/jupiter-price.js";
import { readRuntimeStateStrict } from "./entry/runtime.js";
import { readState } from "./state/store.js";
import fs from "fs";
import { createTelegramApi } from "./entrybot/api.js";
import { handleEntrybotTurn } from "./entrybot/flow.js";
import { entryLogFiles, takeNewActions, takeNewLogLines } from "./entrybot/logs.js";
import { commitReview, reviewQueue, symbolFromPools } from "./entrybot/logic.js";
import { loadEntrybotState, saveEntrybotState } from "./entrybot/store.js";

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const pmExec = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
  return arg1 === self || pmExec === self;
}

function updateToTurn(update) {
  if (update?.callback_query) {
    const query = update.callback_query;
    return {
      type: "callback",
      chatId: query.message?.chat?.id,
      data: query.data,
      callbackId: query.id,
    };
  }
  if (update?.message?.text) {
    return { type: "text", chatId: update.message.chat?.id, text: update.message.text };
  }
  return null;
}

async function quoteMint(mint) {
  const prices = await getPrices([mint, WSOL_MINT], { force: true });
  const usd = prices.get(mint);
  const sol = bidaskSolQuotePrice({ tokenUsd: usd, solUsd: prices.get(WSOL_MINT), entryPriceUnit: "sol" }).price;
  let pools = [];
  try {
    pools = await fetchMintPools(mint);
  } catch (err) {
    log.warn(`Entry bot gagal ambil pool ${String(mint).slice(0, 8)}: ${err.message}`);
  }
  return {
    symbol: symbolFromPools(pools, mint),
    priceUsd: Number.isFinite(Number(usd)) ? Number(usd) : null,
    priceSol: Number.isFinite(Number(sol)) ? Number(sol) : null,
    pools,
  };
}

function readPoolText() {
  const file = poolListFilePath();
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readPositions() {
  return readState()?.positions || {};
}

function readActions() {
  try {
    return readRuntimeStateStrict().recentActions || [];
  } catch {
    return [];
  }
}

async function idle(deps) {
  if (deps.once || deps.shouldStop?.()) return { idle: true };
  while (!deps.shouldStop?.()) await sleep(deps.idleMs ?? 60_000);
  return { idle: true };
}

async function monitor(state, deps) {
  const readLogs =
    deps.readNewLogs || ((cursors) => takeNewLogLines(entryLogFiles(new Date(deps.now?.() ?? Date.now())), cursors));
  const { lines, cursors } = readLogs(state.logCursors || {});
  const actionRead = deps.readActions || readActions;
  const taken = takeNewActions(actionRead(), state.actionCursor, deps.now?.() ?? Date.now());
  let poolText = "";
  try {
    poolText = (deps.readPoolText || readPoolText)();
  } catch {
    return { ...state, logCursors: cursors, actionCursor: taken.cursor };
  }
  const reviewed = reviewQueue(
    state.items,
    {
      poolText,
      positions: (deps.readPositions || readPositions)(),
      logLines: lines,
      actions: taken.lines,
    },
    deps.now?.() ?? Date.now()
  );
  const send = deps.sendText;
  const delivered = [];
  for (const note of reviewed.notes) {
    const sent = await send(note.text);
    if (sent) delivered.push(note.id);
  }
  const allDelivered = reviewed.notes.every((note) => delivered.includes(note.id));
  return {
    ...state,
    items: commitReview(state.items, reviewed, delivered),
    logCursors: allDelivered ? cursors : state.logCursors || {},
    actionCursor: allDelivered ? taken.cursor : state.actionCursor,
  };
}

export async function runEntrybot(deps = {}) {
  const logFn = deps.log || log;
  const token = deps.token ?? config.entrybotTelegramToken;
  const chatId = deps.chatId ?? (config.entrybotTelegramChatId || config.telegramChatId);
  if (!token) {
    logFn.error("ENTRYBOT_TELEGRAM_TOKEN kosong — entry bot idle, tidak mem-poll Telegram.");
    return idle(deps);
  }
  if (!chatId) {
    logFn.error("Chat id kosong — isi TELEGRAM_CHAT_ID atau ENTRYBOT_TELEGRAM_CHAT_ID. Entry bot idle.");
    return idle(deps);
  }

  const api =
    deps.api ||
    createTelegramApi({
      token,
      request: deps.request,
    });
  const load = deps.loadState || loadEntrybotState;
  const save = deps.saveState || saveEntrybotState;
  let state = load();
  const timeoutSec = deps.timeoutSec ?? 30;

  const turnDeps = () => ({
    now: deps.now || (() => Date.now()),
    allowedChatId: chatId,
    defaultSizeSol: deps.defaultSizeSol ?? config.entry.defaultSizeSol,
    quoteMint: deps.quoteMint || quoteMint,
    appendLine: deps.appendLine || ((line) => appendCaEntryLine(line)),
    readPoolText: deps.readPoolText || readPoolText,
    commentAddress: deps.commentAddress || ((address) => commentPoolInList(address, null)),
    newId: deps.newId,
    previewOpts: deps.previewOpts,
  });

  const sendText = async (text, keyboard) => {
    const fn = deps.sendMessage || ((...args) => api.sendMessage(chatId, ...args));
    const res = await fn(text, keyboard);
    return Boolean(res && res.ok !== false);
  };

  const watch = async () => {
    try {
      state = await monitor(state, { ...deps, sendText: (text) => sendText(text) });
      save(state);
    } catch (err) {
      logFn.warn(`Entry bot pantauan gagal: ${err.message}`);
    }
  };

  await watch();

  while (!deps.shouldStop?.()) {
    let res = null;
    try {
      const getUpdates = deps.getUpdates || ((opts) => api.getUpdates(opts));
      res = await getUpdates({ offset: state.offset, timeoutSec });
    } catch (err) {
      logFn.warn(`Entry bot getUpdates gagal: ${err.message}`);
      if (deps.once) break;
      await sleep(deps.retryMs ?? 3000);
      continue;
    }
    if (res == null || res.ok === false) {
      if (deps.once) break;
      await sleep(deps.retryMs ?? 3000);
      continue;
    }
    for (const update of Array.isArray(res.result) ? res.result : []) {
      if (Number.isFinite(Number(update?.update_id))) state.offset = Number(update.update_id) + 1;
      const turn = updateToTurn(update);
      if (!turn) continue;
      try {
        const result = await handleEntrybotTurn(state, turn, turnDeps());
        state = result.state;
        if (result.ignored) continue;
        if (turn.callbackId) {
          const answer = deps.answerCallback || ((id, text) => api.answerCallback(id, text));
          await answer(turn.callbackId, result.toast || "");
        }
        for (const message of result.replies) {
          await sendText(message.text, message.keyboard);
        }
      } catch (err) {
        logFn.warn(`Entry bot gagal olah update: ${err.message}`);
      }
    }
    await watch();
    if (deps.once) break;
  }
  return { idle: false, offset: state.offset };
}

export async function startEntrybotWorker() {
  log.info("========================================");
  log.info("  Meteora Worker: ENTRY BOT");
  const chat = config.entrybotTelegramChatId || config.telegramChatId || "?";
  log.info(`  Antre entry lewat Telegram | chat ${chat}`);
  log.info("  Tidak membuka posisi. Hanya menulis baris pool.txt.");
  log.info("========================================");
  await runEntrybot();
}

if (isDirectRun(import.meta.url)) {
  startEntrybotWorker().catch((err) => {
    log.error(`Fatal error in worker-entrybot: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
