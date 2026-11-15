import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-bidask-sol-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.IMPORTANT_LOG_FILE = path.join(TMP, "important.log");
process.env.IMPORTANT_EVENTS_FILE = path.join(TMP, "important-events.jsonl");

const { Keypair } = await import("@solana/web3.js");
const { default: config } = await import("../src/config/index.js");
const { readState, writeState } = await import("../src/state/store.js");
const {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  setBidaskSolOpenOffset,
  noteBidaskSolOpenOffset,
  getSpotReentryCount,
  setExitWarmupStartedAt,
  setSpotReentryCount,
  resolveExitWarmupStartedAt,
} = await import("../src/state/positions.js");
const { evaluateExit, isExitWarmup, indicatorAction } = await import("../src/exit/rules.js");
const { armIndicatorTrailing } = await import("../src/state/trailing.js");
const { handleClose } = await import("../src/exit/close.js");
const { processTrailing } = await import("../src/exit/trailing.js");
const { shouldReenter } = await import("../src/exit/spot-reentry.js");
const {
  bidaskSolReentryBinRange,
  shouldBidaskSolReenter,
  canBidaskSolReenter,
  planBidaskSolOorKananReentry,
  handleBidaskSolOorKananReentry,
  setLastBidaskSolReentryAt,
  clearBidaskSolReentryCooldown,
  readBidaskSolOpenOffset,
} = await import("../src/exit/bidask-sol-reentry.js");
const { buildCloseMessage, buildBidaskSolReentryMessage, buildBidaskSolReentryFailedMessage } =
  await import("../src/notify/telegram.js");
const { resetRuntimeState } = await import("../src/entry/runtime.js");

const POOL = "PoolBidaskSol11111111111111111111111111111";
const POS = "PosBidaskSol111111111111111111111111111111";
const MINT = "MintBidaskSol11111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  resetRuntimeState();
  clearBidaskSolReentryCooldown();
}

function makePos(overrides = {}) {
  return {
    position: POS,
    pool: POOL,
    pair: "TOK-SOL",
    mode: "bidask:sol",
    baseMint: MINT,
    activeBin: 120,
    lowerBin: 100,
    upperBin: 140,
    binSpan: 40,
    pnlPct: 0,
    solAmountUi: 0.42,
    ...overrides,
  };
}

function closesToCandles(closes) {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 900,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

function risingCandles(n = 30) {
  const closes = Array.from({ length: n }, (_, i) => i + 1);
  closes.push(0.01);
  return closesToCandles(closes);
}

function fallingCandles(n = 30) {
  const closes = Array.from({ length: n }, (_, i) => n - i);
  closes.push(n + 50);
  return closesToCandles(closes);
}

function signalCandles() {
  return Array.from({ length: 41 }, (_, i) => ({
    time: 1_700_000_000 + i * 900,
    open: 1.1 ** i,
    high: 1.1 ** (i + 1),
    low: 1.1 ** i,
    close: 1.1 ** (i + 0.9),
    volume: 1,
  }));
}

function patchTracked(fields) {
  const state = readState();
  Object.assign(state.positions[POS], fields);
  writeState(state);
}

test("aturan bidask:sol: stop loss -40, trailing 10, warmup 30, OOR kiri/yield/bounce mati", () => {
  const rules = config.rulesFor("bidask:sol");
  assert.equal(rules.enableStopLoss, true);
  assert.equal(rules.stopLossPct, -40);
  assert.equal(rules.trailingTakeProfit, true);
  assert.equal(rules.trailingTriggerPct, 10);
  assert.equal(rules.trailingDropRatioPct, 8);
  assert.equal(rules.trailingDropPct, 1.5);
  assert.equal(rules.enableOOR, false);
  assert.equal(rules.enableIndicators, config.bidaskSol.enableIndicators);
  assert.equal(rules.enableIndicators, false);
  assert.equal(rules.rsiPeriod, 2);
  assert.equal(rules.macdFast, 12);
  assert.equal(rules.macdSlow, 26);
  assert.equal(rules.macdSignal, 9);
  assert.equal(rules.bbPeriod, 20);
  assert.equal(rules.bbStddev, 2);
  assert.equal(rules.exitWarmupMinutes, 30);
  assert.equal(rules.yieldCloseBelowPct, 0);
  assert.equal(rules.enableBounceRecovery, false);
  assert.equal(rules.oorKananMinutes, config.spot.oorKananMinutes);
  assert.equal(rules.oorKananFastMinutes, config.spot.oorKananFastMinutes);
  assert.equal(rules.oorKananHighVol5mUsd, config.spot.oorKananHighVol5mUsd);
  assert.equal(config.rulesFor("spot").exitWarmupMinutes, 60);
});

test("stop loss -40 menutup, di atasnya tidak", () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const hit = evaluateExit(makePos({ pnlPct: -40, activeBin: 120 }), null);
  assert.equal(hit.action, "close");
  assert.equal(hit.reason, "stop_loss");

  const above = evaluateExit(makePos({ pnlPct: -39.99, activeBin: 120 }), null);
  assert.equal(above.action, "hold");
  assert.notEqual(above.reason, "stop_loss");
});

test("warmup 30 menit menahan trailing, stop loss dan OOR kanan tetap jalan", () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const now = Date.now();
  const started = now - 10 * 60 * 1000;
  setExitWarmupStartedAt(POS, started);
  const minutes = config.rulesFor("bidask:sol").exitWarmupMinutes;
  assert.equal(minutes, 30);
  assert.equal(isExitWarmup(started, minutes, now), true);
  assert.equal(isExitWarmup(now - 30 * 60 * 1000, minutes, now), false);

  const sl = evaluateExit(makePos({ pnlPct: -40 }), null, { warmup: true });
  assert.equal(sl.action, "close");
  assert.equal(sl.reason, "stop_loss");

  const oor = evaluateExit(makePos({ activeBin: 141, pnlPct: 5 }), null, { warmup: true });
  assert.equal(oor.action, "hold");
  assert.match(oor.reason, /^oor_kanan_/);

  const state = readState();
  state.positions[POS].lastPnlPeak = 20;
  writeState(state);
  const warmup = isExitWarmup(started, minutes, now);
  const tracked = getTrackedPosition(POS);
  if (!warmup) processTrailing(makePos({ pnlPct: 12 }), tracked, "TOK-SOL", async () => {});
  assert.equal(getTrackedPosition(POS).trailingActive, false);

  processTrailing(makePos({ pnlPct: 20 }), getTrackedPosition(POS), "TOK-SOL", async () => {});
  assert.equal(getTrackedPosition(POS).trailingActive, true);
});

test("OOR kanan bidask:sol memakai timer dan cooldown yang sama dengan spot", () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const minutes = config.bidaskSol.oorKananMinutes;
  assert.equal(minutes, 2);

  let res = evaluateExit(makePos({ activeBin: 141 }), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);

  const state = readState();
  state.positions[POS].oorSejak = Date.now() - (minutes + 0.1) * 60000;
  state.positions[POS].oorArah = "kanan";
  writeState(state);
  res = evaluateExit(makePos({ activeBin: 141 }), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");

  setLastBidaskSolReentryAt(POOL, Date.now());
  const cooled = evaluateExit(makePos({ activeBin: 200 }), null);
  assert.equal(cooled.action, "hold");
  assert.match(cooled.reason, /^oor_kanan_cooldown_/);

  const fastState = readState();
  fastState.positions[POS].oorSejak = Date.now() - 70_000;
  fastState.positions[POS].oorArah = "kanan";
  writeState(fastState);
  clearBidaskSolReentryCooldown(POOL);
  const fast = evaluateExit(makePos({ activeBin: 200, volume5m: 150_000 }), null);
  assert.equal(fast.action, "close");
  assert.equal(fast.reason, "oor_kanan");
});

test("OOR kiri tetap mati", () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const left = evaluateExit(makePos({ activeBin: 90 }), null);
  assert.equal(left.action, "hold");
  assert.notEqual(left.reason, "oor_kiri");
});

test("range re-entry: lebar sama, offset dikenal, fallback berakhir di bin aktif, span spot ditolak", () => {
  const known = bidaskSolReentryBinRange({
    activeBinId: 500,
    binSpan: 40,
    binsBelow: 10,
    binsAbove: 30,
    maxSpan: config.spotMinBins,
  });
  assert.equal(known.maxBinId - known.minBinId, 40);
  assert.equal(known.minBinId, 490);
  assert.equal(known.maxBinId, 530);

  const unknown = bidaskSolReentryBinRange({
    activeBinId: 500,
    binSpan: 40,
    maxSpan: config.spotMinBins,
  });
  assert.equal(unknown.minBinId, 460);
  assert.equal(unknown.maxBinId, 500);
  assert.equal(unknown.binSpan, 40);

  assert.equal(
    bidaskSolReentryBinRange({ activeBinId: 500, binSpan: config.spotMinBins, maxSpan: config.spotMinBins }),
    null
  );
});

test("gerbang re-entry bidask:sol tidak memakai gerbang spot, dan sebaliknya", () => {
  const cfg = { enabled: true, maxReentries: 50 };
  assert.equal(
    shouldBidaskSolReenter({
      mode: "bidask:sol",
      reason: "oor_kanan",
      span: 40,
      count: 0,
      sizeSol: 0.4,
      cfg,
      maxSpan: 200,
    }),
    true
  );
  assert.equal(
    shouldBidaskSolReenter({
      mode: "spot",
      reason: "oor_kanan",
      span: 40,
      count: 0,
      sizeSol: 0.4,
      cfg,
      maxSpan: 200,
    }),
    false
  );
  assert.equal(
    shouldBidaskSolReenter({
      mode: "bidask:double",
      reason: "oor_kanan",
      span: 40,
      count: 0,
      sizeSol: 0.4,
      cfg,
      maxSpan: 200,
    }),
    false
  );
  assert.equal(
    shouldBidaskSolReenter({
      mode: "bidask:sol",
      reason: "oor_kanan",
      span: 200,
      count: 0,
      sizeSol: 0.4,
      cfg,
      maxSpan: 200,
    }),
    false
  );
  assert.equal(
    shouldReenter({ mode: "bidask:sol", reason: "oor_kanan", span: 40, count: 0, cfg: { ...cfg, sizeSol: 1 } }),
    false
  );
});

test("RSI >= ambang membatalkan re-entry; candle kosong tetap re-entry", async () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  recordTrackedRange(POS, 100, 140);
  const pos = makePos();
  assert.equal(canBidaskSolReenter(pos, "oor_kanan"), true);

  const hot = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async (_mint, _pool, opts) => {
      assert.equal(opts.resolution, "15m");
      assert.equal(opts.priority, "exit");
      return risingCandles();
    },
  });
  assert.equal(hot.willReenter, false);
  assert.match(hot.reentrySkipReason, /RSI\(2\)/);
  assert.match(hot.reentrySkipReason, />= 90/);

  const missing = [];
  const cold = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async () => null,
    log: { warn: (m) => missing.push(m), info: () => {} },
  });
  assert.equal(cold.willReenter, true);
  assert.equal(cold.reentrySkipReason, null);
  assert.match(missing[0], /tidak tersedia/);
});

test("re-entry membuka bidask:sol SOL-only dengan lebar bin yang sama dan warmup diwariskan", async () => {
  resetState();
  const t0 = Date.now() - 5 * 60 * 1000;
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol", false, { exitWarmupStartedAt: t0 });
  recordTrackedRange(POS, 100, 140);
  setBidaskSolOpenOffset(POS, 10, 30);
  assert.deepEqual(readBidaskSolOpenOffset(getTrackedPosition(POS)), { binsBelow: 10, binsAbove: 30 });

  const wallet = Keypair.generate();
  let opened = null;
  const mockPool = {
    async getActiveBin() {
      return { binId: 500 };
    },
    async quoteCreatePosition() {
      return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.05 };
    },
    async initializePositionAndAddLiquidityByStrategy(args) {
      opened = args;
      return { tx: "init" };
    },
  };

  const res = await handleBidaskSolOorKananReentry(makePos(), {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: mockPool,
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
      collectFeeMode: 0,
    }),
    getDlmmSdk: async () => ({ StrategyType: { Spot: 0, BidAsk: 2 } }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 0.002 }),
    sendAndConfirmRobust: async () => "sig_bidask_sol",
    notifyBidaskSolReentry: async () => {},
    notifyBidaskSolReentryFailed: async () => {},
  });

  assert.equal(res.success, true);
  assert.equal(res.mode, "bidask:sol");
  assert.equal(res.maxBinId - res.minBinId, 40);
  assert.equal(res.minBinId, 490);
  assert.equal(res.maxBinId, 530);
  assert.equal(opened.strategy.strategyType, 2);
  assert.equal(opened.strategy.minBinId, 490);
  assert.equal(opened.strategy.maxBinId, 530);
  assert.equal(opened.totalXAmount.toString(), "0");
  assert.equal(opened.totalYAmount.toString(), String(Math.floor(0.42 * 1e9)));

  const child = getTrackedPosition(res.position);
  assert.equal(child.mode, "bidask:sol");
  assert.equal(child.binSpan, 40);
  assert.equal(child.lowerBin, 490);
  assert.equal(child.upperBin, 530);
  assert.equal(child.exitWarmupStartedAt, t0);
  assert.equal(getSpotReentryCount(res.position), 1);
  assert.equal(child.openBinsBelow, 10);
  assert.equal(child.openBinsAbove, 30);
  assert.notEqual(child.mode, "spot");
  assert.notEqual(child.mode, "bidask:double");
});

test("offset tidak diketahui: re-entry berakhir di bin aktif", async () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  recordTrackedRange(POS, 100, 140);
  noteBidaskSolOpenOffset(POS, 200, 100, 140);
  assert.equal(getTrackedPosition(POS).openBinOffsetNoted, true);
  assert.equal(getTrackedPosition(POS).openBinsBelow, null);

  let opened = null;
  const res = await handleBidaskSolOorKananReentry(makePos(), {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: {
        async getActiveBin() {
          return { binId: 500 };
        },
        async quoteCreatePosition() {
          return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0 };
        },
        async initializePositionAndAddLiquidityByStrategy(args) {
          opened = args;
          return { tx: "init" };
        },
      },
      baseMint: MINT,
      baseIsX: false,
      unsupported: false,
    }),
    getDlmmSdk: async () => ({ StrategyType: { BidAsk: 2 } }),
    getConnection: () => ({}),
    getWallet: () => Keypair.generate(),
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true }),
    sendAndConfirmRobust: async () => "sig2",
    notifyBidaskSolReentry: async () => {},
    notifyBidaskSolReentryFailed: async () => {},
  });

  assert.equal(res.success, true);
  assert.equal(opened.strategy.minBinId, 460);
  assert.equal(opened.strategy.maxBinId, 500);
  assert.equal(opened.totalYAmount.toString(), "0");
  assert.equal(getTrackedPosition(res.position).mode, "bidask:sol");
  assert.equal(getTrackedPosition(res.position).binSpan, 40);
});

test("telegram re-entry bidask:sol menyebut SOL-only", () => {
  const ok = buildBidaskSolReentryMessage({
    pair: "TOK-SOL",
    pool: POOL,
    sizeSol: 0.42,
    count: 1,
    max: 50,
    minBin: 490,
    maxBin: 530,
    span: 40,
  });
  assert.match(ok, /RE-ENTRY bidask:sol SOL-only TOK-SOL \(1\/50\)/);
  assert.match(ok, /490\.\.530 \(span 40\)/);

  const fail = buildBidaskSolReentryFailedMessage({
    pair: "TOK-SOL",
    pool: POOL,
    count: 1,
    max: 50,
    reason: "saldo SOL kurang",
  });
  assert.match(fail, /RE-ENTRY bidask:sol SOL-only TOK-SOL TIDAK dibuka/);

  const close = buildCloseMessage("TOK-SOL", "oor_kanan", 1, null, null, null, {
    willReenter: true,
    nextCount: 2,
    max: 50,
    mode: "bidask:sol",
  });
  assert.match(close, /Akan re-entry bidask:sol SOL-only \(2\/50\)/);

  const skipped = buildCloseMessage("TOK-SOL", "oor_kanan", 1, null, null, null, {
    willReenter: false,
    mode: "bidask:sol",
    skipReason: "re-entry dilewati karena RSI(2) 95 >= 90",
  });
  assert.match(skipped, /Tidak re-entry bidask:sol SOL-only: re-entry dilewati karena RSI\(2\)/);

  const spot = buildCloseMessage("TOK-SOL", "oor_kanan", 1, null, null, null, {
    willReenter: true,
    nextCount: 2,
    max: 50,
    mode: "spot",
  });
  assert.match(spot, /Akan re-entry \(2\/50\)/);
  assert.doesNotMatch(spot, /bidask:sol/);
});

const TIME_LIMIT_MSG = "OOR kanan — batas waktu re-entry 3j tercapai, exit + swap ke SOL";
const HOUR_MS = 3_600_000;

function armBidask() {
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  recordTrackedRange(POS, 100, 140);
  return makePos();
}

test("indikator bidask:sol meng-arm trailing setelah warmup dan menahan saat warmup", () => {
  resetState();
  trackPosition(POS, POOL, "TOK-SOL", MINT, null, "bidask:sol");
  const rules = config.rulesFor("bidask:sol");
  const savedIndicators = rules.enableIndicators;
  rules.enableIndicators = true;
  try {
    const now = Date.now();
    const started = now - 10 * 60 * 1000;
    setExitWarmupStartedAt(POS, started);
    assert.equal(isExitWarmup(resolveExitWarmupStartedAt(getTrackedPosition(POS)), rules.exitWarmupMinutes, now), true);

    const held = evaluateExit(makePos({ pnlPct: 4 }), signalCandles(), { warmup: true, now });
    assert.equal(held.action, "hold");
    assert.equal(held.reason, "warmup");
    assert.equal(getTrackedPosition(POS).trailingArmedBy, null);

    assert.deepEqual(indicatorAction("bidask:sol", "rsi_macd", { indicatorExit: "immediate" }), {
      action: "arm_indicator_trailing",
      reason: "rsi_macd",
    });

    const savedPeriod = rules.rsiPeriod;
    rules.rsiPeriod = 500;
    try {
      const quiet = evaluateExit(makePos({ pnlPct: 4 }), signalCandles(), { warmup: false, now });
      assert.equal(quiet.action, "hold");
      assert.equal(quiet.reason, "no_signal");
    } finally {
      rules.rsiPeriod = savedPeriod;
    }

    patchTracked({ exitWarmupStartedAt: now - rules.exitWarmupMinutes * 60 * 1000 });
    assert.equal(
      isExitWarmup(resolveExitWarmupStartedAt(getTrackedPosition(POS)), rules.exitWarmupMinutes, now),
      false
    );
    const armed = evaluateExit(makePos({ pnlPct: 4 }), signalCandles(), { warmup: false, now });
    assert.equal(armed.action, "arm_indicator_trailing");
    assert.match(armed.reason, /^rsi_(macd|bb)$/);
    armIndicatorTrailing(POS, armed.reason, 4);
    assert.equal(getTrackedPosition(POS).trailingActive, true);
    assert.equal(getTrackedPosition(POS).trailingArmedBy, armed.reason);
    rules.enableIndicators = false;
    const off = evaluateExit(makePos({ pnlPct: 4 }), signalCandles(), { warmup: false, now });
    assert.equal(off.action, "hold");
    assert.equal(off.reason, "indicators_disabled");
  } finally {
    rules.enableIndicators = savedIndicators;
  }
});

test("bidask:sol di bawah batas waktu tetap re-entry", async () => {
  resetState();
  const now = Date.now();
  const pos = armBidask();
  patchTracked({ exitWarmupStartedAt: now - HOUR_MS, firstSeenAt: now });
  const plan = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    now,
    fetchCandles: async () => fallingCandles(),
  });
  assert.equal(plan.willReenter, true);
  assert.equal(canBidaskSolReenter(pos, "oor_kanan", { now }), true);

  const opened = await handleBidaskSolOorKananReentry(pos, {
    dryRun: true,
    getPoolInfo: async () => ({
      pool: {
        async getActiveBin() {
          return { binId: 500 };
        },
      },
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
    }),
    notifyBidaskSolReentry: async () => {},
    notifyBidaskSolReentryFailed: async () => {},
  });
  assert.equal(opened.success, true);
  assert.equal(opened.dryRun, true);
  assert.equal(opened.mode, "bidask:sol");
});

test("bidask:sol tepat/lewat batas waktu: tutup + swap ke SOL, tanpa re-entry", async () => {
  resetState();
  const now = Date.now();
  const pos = armBidask();
  patchTracked({ exitWarmupStartedAt: now - 3 * HOUR_MS, firstSeenAt: now });
  const logs = [];
  let candleCalls = 0;
  const plan = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    now,
    fetchCandles: async () => {
      candleCalls += 1;
      return risingCandles();
    },
    log: { info: (m) => logs.push(m), warn: () => {} },
  });
  assert.equal(candleCalls, 0);
  assert.equal(plan.willReenter, false);
  assert.equal(plan.reentrySkipReason, TIME_LIMIT_MSG);
  assert.match(logs[0], /bidask:sol SOL-only OOR kanan — batas waktu re-entry 3j/);

  const swaps = [];
  const notices = [];
  const closeRes = await handleClose(pos, "oor_kanan", {
    skipDeactivate: false,
    willReenter: false,
    reentrySkipReason: plan.reentrySkipReason,
    deps: {
      closePosition: async () => ({ success: true, baseMint: MINT, rewardMints: [] }),
      waitClosedPositionPnl: async () => 2,
      deactivatePool: () => {},
      notifyClose: (...args) => notices.push(buildCloseMessage(...args)),
      swapDeps: {
        getProtectedMints: async () => new Map(),
        getTokenBalance: async () => 3.25,
        getTokenValueUsd: async () => 4,
        swapToSol: async (mint, amount) => {
          swaps.push([mint, amount]);
          return { success: true };
        },
      },
    },
  });
  assert.equal(closeRes.success, true);
  assert.deepEqual(swaps, [[MINT, 3.25]]);
  assert.match(notices[0], /Tidak re-entry bidask:sol SOL-only: OOR kanan — batas waktu re-entry 3j tercapai/);

  let poolCalls = 0;
  const skipped = await handleBidaskSolOorKananReentry(pos, {
    getPoolInfo: async () => {
      poolCalls += 1;
      return {};
    },
  });
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(poolCalls, 0);
});

test("bidask:sol batas waktu 0 tetap re-entry, batas jumlah tetap jalan", async () => {
  resetState();
  const now = Date.now();
  const pos = armBidask();
  patchTracked({ exitWarmupStartedAt: null, firstSeenAt: now - 4 * HOUR_MS });
  const adopted = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    now,
    fetchCandles: async () => fallingCandles(),
  });
  assert.equal(adopted.willReenter, false);
  assert.equal(adopted.reentrySkipReason, TIME_LIMIT_MSG);

  const saved = config.spotReentry.maxHours;
  config.spotReentry.maxHours = 0;
  try {
    const unlimited = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
      now,
      fetchCandles: async () => fallingCandles(),
    });
    assert.equal(unlimited.willReenter, true);
  } finally {
    config.spotReentry.maxHours = saved;
  }

  patchTracked({ exitWarmupStartedAt: now - 10 * 60 * 1000, firstSeenAt: now });
  setSpotReentryCount(POS, config.spotReentry.maxReentries);
  const counted = await planBidaskSolOorKananReentry(pos, "oor_kanan", {
    now,
    fetchCandles: async () => fallingCandles(),
  });
  assert.equal(counted.willReenter, false);
  assert.equal(counted.reentrySkipReason, "max re-entry tercapai");
});
