import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "entry-price-adopted-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

const MINT = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const SOL_MINT = "MintSolWatch11111111111111111111111111111";
const ST_MINT = "MintSuper111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const POS = "9fR3kP2mQ8vL5sT1aY6bN4cD7eH2wJ8uX3pM6qR1sT4u";

const { WSOL_MINT } = await import("../src/core/constants.js");
const { bidaskDoubleTargetKey } = await import("../src/entry/bidask-double-target.js");
const { pollBidaskDoubleTargets } = await import("../src/entry/bidask-double-target.js");
const { collectEntryPriceMints, noteSameStrategySkip, pollSharedEntryPrices, resetSameStrategySkipLog } =
  await import("../src/entry/index.js");
const { watchPrices } = await import("../src/entry/price-watch.js");
const { getPendingSwaps, resetRuntimeState } = await import("../src/entry/runtime.js");
const { bidaskSolTouchKey } = await import("../src/state/bidask-sol-touch.js");
const { getBidaskSolTouchDirection } = await import("../src/state/bidask-sol-touch.js");
const { clearBidaskDoubleTouch, getBidaskDoubleTouch } = await import("../src/state/bidask-double-touch.js");
const { getTrackedPosition, isExternalPosition, trackPosition } = await import("../src/state/positions.js");
const { handleClose } = await import("../src/exit/close.js");
const { processPendingSwaps } = await import("../src/exit/pending-swaps.js");
const config = (await import("../src/config/index.js")).default;

config.telegramBotToken = "";
config.telegramChatId = "";
config.swap.autoSwapAfterClose = true;

function resetState(positions = {}) {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions }));
  resetRuntimeState();
}

function closeDeps(deactivated, swapOk = true) {
  return {
    closePosition: async () => ({ success: true, baseMint: MINT, rewardMints: [] }),
    waitClosedPositionPnl: async () => 1,
    deactivatePool: (pool) => deactivated.push(pool),
    notifyClose: () => {},
    swapDeps: {
      getProtectedMints: async () => new Map(),
      getTokenBalance: async () => 2,
      getTokenValueUsd: async () => 3,
      swapToSol: async () => (swapOk ? { success: true } : { success: false, error: "slippage" }),
    },
  };
}

test("satu tick membagi harga: poll terpisah kelaparan, poll bersama tidak", async () => {
  const key = bidaskDoubleTargetKey(MINT, 1, "usd");
  clearBidaskDoubleTouch(key);
  const book = new Map([
    [MINT, 0.4],
    [SOL_MINT, 3],
    [ST_MINT, 9],
    [WSOL, 100],
  ]);
  let calls = 0;
  const fetchPrices = async (ids) => {
    calls += 1;
    if (calls > 1) return new Map();
    const out = new Map();
    for (const id of ids) if (book.has(id)) out.set(id, book.get(id));
    return out;
  };
  const watch = {
    lineKey: MINT,
    mint: MINT,
    ca: true,
    entryPrice: 1,
    entryPriceUnit: "usd",
    targetKey: key,
  };
  const stDeps = {
    ensureSupertrend: () => {},
    getSupertrend: () => ({ direction: "bullish", line: 20 }),
    getSupertrendFallback: () => null,
    getPrices: fetchPrices,
  };

  await pollBidaskDoubleTargets([watch], { getPrices: fetchPrices });
  const starved = await watchPrices([{ pool: POOL, mint: ST_MINT }], stDeps);
  assert.equal(calls, 2);
  assert.equal(starved.triggered.length, 0);
  assert.equal(getBidaskDoubleTouch(key)?.direction, "up");

  calls = 0;
  clearBidaskDoubleTouch(key);
  const shared = await pollSharedEntryPrices({
    doubleTargets: [watch],
    solWatches: [{ mint: SOL_MINT, entryPrice: 2, entryPriceUnit: "usd" }],
    watchable: [{ pool: POOL, mint: ST_MINT }],
    fetchPrices,
    watchDeps: stDeps,
  });
  assert.equal(calls, 1);
  assert.equal(getBidaskDoubleTouch(key)?.direction, "up");
  assert.equal(shared.watched.triggered.length, 1);
  assert.equal(shared.watched.triggered[0].mint, ST_MINT);
  assert.equal(shared.watched.triggered[0].price, 9);
  assert.equal(shared.sol.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(bidaskSolTouchKey(SOL_MINT, 2, "usd")), "down");
  assert.ok(collectEntryPriceMints({ watchable: [{ mint: ST_MINT }] }).includes(WSOL_MINT));
  assert.ok(collectEntryPriceMints({ doubleTargets: [{ mint: MINT, entryPriceUnit: "sol" }] }).includes(WSOL_MINT));
  assert.equal(
    collectEntryPriceMints({ doubleTargets: [{ mint: MINT, entryPriceUnit: "usd" }] }).includes(WSOL_MINT),
    false
  );
});

test("posisi diadopsi dan state lama tidak menandai pool; posisi bot tetap", async () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol", false, { source: "adopted" });
  const adopted = getTrackedPosition(POS);
  assert.equal(adopted.source, "adopted");
  assert.equal(adopted.openedAt, null);
  assert.equal(isExternalPosition(adopted), true);

  const deactivated = [];
  const closed = await handleClose(
    { position: POS, pool: POOL, baseMint: MINT, pair: "TOK-SOL", pnlPct: -4 },
    "oor_kanan",
    {
      deps: closeDeps(deactivated),
    }
  );
  assert.equal(closed.success, true);
  assert.deepEqual(deactivated, []);

  const legacy = "LegacyPos111111111111111111111111111111111";
  resetState({
    [legacy]: { position: legacy, pool: POOL, baseMint: MINT, closed: false, mode: "bidask:sol" },
  });
  assert.equal(isExternalPosition(getTrackedPosition(legacy)), true);
  const legacyOff = [];
  await handleClose({ position: legacy, pool: POOL, baseMint: MINT, pnlPct: 1 }, "oor_kanan", {
    deps: closeDeps(legacyOff),
  });
  assert.deepEqual(legacyOff, []);

  const bot = "BotPos1111111111111111111111111111111111111";
  resetState();
  trackPosition(bot, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const opened = getTrackedPosition(bot);
  assert.equal(opened.source, "entry");
  assert.ok(opened.openedAt > 0);
  assert.equal(isExternalPosition(opened), false);
  const botOff = [];
  await handleClose({ position: bot, pool: POOL, baseMint: MINT, pnlPct: 2 }, "stop_loss", { deps: closeDeps(botOff) });
  assert.deepEqual(botOff, [POOL]);
});

test("swap tertunda dari posisi diadopsi tidak menandai pool belakangan", async () => {
  resetState();
  const addr = "AdoptSwap11111111111111111111111111111111";
  trackPosition(addr, POOL, "TOK-SOL", MINT, null, "spot", false, { source: "adopted" });
  const deactivated = [];
  const res = await handleClose({ position: addr, pool: POOL, baseMint: MINT, pnlPct: -2 }, "oor_kanan", {
    deps: closeDeps(deactivated, false),
  });
  assert.equal(res.swapPending, true);
  assert.deepEqual(deactivated, []);
  assert.deepEqual(getPendingSwaps()[MINT].deactivatePools, []);

  await processPendingSwaps({
    now: Date.now() + 24 * 60 * 60 * 1000,
    deps: {
      getProtectedMints: async () => new Map(),
      getTokenBalance: async () => 2,
      getTokenValueUsd: async () => 3,
      swapToSol: async () => ({ success: true }),
      deactivatePool: (pool) => deactivated.push(pool),
    },
  });
  assert.deepEqual(deactivated, []);
});

test("log skip strategi yang sama paling sering sekali per 10 menit", () => {
  resetSameStrategySkipLog();
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(String(msg));
  const t0 = 1_700_000_000_000;
  try {
    assert.equal(noteSameStrategySkip(`${MINT}:spot`, `CA ${MINT}`, t0), true);
    assert.equal(noteSameStrategySkip(`${MINT}:spot`, `CA ${MINT}`, t0 + 60_000), false);
    assert.equal(noteSameStrategySkip(`${MINT}:bidask`, `CA ${MINT}`, t0 + 60_000), true);
    assert.equal(noteSameStrategySkip(`${MINT}:spot`, `CA ${MINT}`, t0 + 10 * 60 * 1000), true);
  } finally {
    console.log = orig;
    resetSameStrategySkipLog();
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], new RegExp(`${MINT} skip: token sudah punya posisi aktif dengan strategi yang sama`));
});
