import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-reentry-guard-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.IMPORTANT_LOG_FILE = path.join(TMP, "important.log");
process.env.IMPORTANT_EVENTS_FILE = path.join(TMP, "important-events.jsonl");

const { Keypair } = await import("@solana/web3.js");
const { buildConfig } = await import("../src/config/index.js");
const { readState, writeState } = await import("../src/state/store.js");
const {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  setEntrySizeSol,
  setExitWarmupStartedAt,
  resolveExitWarmupStartedAt,
} = await import("../src/state/positions.js");
const { isExitWarmup } = await import("../src/exit/rules.js");
const {
  latestClosedRsi,
  spotReentryRsiSkipReason,
  planSpotOorKananReentry,
  handleSpotOorKananReentry,
  clearSpotReentryCooldown,
} = await import("../src/exit/spot-reentry.js");
const { buildCloseMessage } = await import("../src/notify/telegram.js");
const { resetRuntimeState } = await import("../src/entry/runtime.js");

const POOL = "PoolGuard111111111111111111111111111111111";
const POS = "PosGuard1111111111111111111111111111111111";
const MINT = "MintGuard111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  resetRuntimeState();
  clearSpotReentryCooldown();
}

function patchTracked(address, fields) {
  const state = readState();
  Object.assign(state.positions[address], fields);
  writeState(state);
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
  // Candle terakhir = bar berjalan. closedCandles membuangnya.
  closes.push(0.01);
  return closesToCandles(closes);
}

function fallingCandles(n = 30) {
  const closes = Array.from({ length: n }, (_, i) => n - i);
  closes.push(n + 50);
  return closesToCandles(closes);
}

function armSpot(address = POS) {
  trackPosition(address, POOL, "FOOD-SOL", MINT, null, "spot");
  recordTrackedRange(address, 100, 344);
  setEntrySizeSol(address, 0.3);
  return { position: address, pool: POOL, pair: "FOOD-SOL", mode: "spot", baseMint: MINT };
}

async function openReentry(pos) {
  const wallet = Keypair.generate();
  const mockPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 400, pricePerToken: "0.001" };
    },
    async quoteCreatePosition() {
      return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.05 };
    },
    async createExtendedEmptyPosition() {
      return { tx: "init" };
    },
    async addLiquidityByStrategy() {
      return { tx: "add" };
    },
  };
  return handleSpotOorKananReentry(pos, {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: mockPool,
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
      collectFeeMode: 1,
    }),
    getDlmmSdk: async () => ({ StrategyType: { Spot: 0 } }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, estimatedSol: 0, maxSol: 0.002 }),
    sendAndConfirmRobust: async () => "tx_reentry_warmup",
    notifySpotReentry: async () => {},
    notifySpotReentryFailed: async () => {},
  });
}

test("SPOT_REENTRY_MAX_RSI default 90, 0 mematikan", () => {
  assert.equal(buildConfig({}).spotReentry.maxRsi, 90);
  assert.equal(buildConfig({ SPOT_REENTRY_MAX_RSI: "0" }).spotReentry.maxRsi, 0);
  assert.equal(buildConfig({ SPOT_REENTRY_MAX_RSI: "85" }).spotReentry.maxRsi, 85);
});

test("re-entry OOR kanan mewarisi warmup dari entry pertama rantai", async () => {
  resetState();
  const t0 = Date.now() - 70 * 60 * 1000;
  const pos = armSpot(POS);
  patchTracked(POS, { firstSeenAt: t0, exitWarmupStartedAt: null });

  const first = await openReentry(pos);
  assert.equal(first.success, true);
  const child1 = getTrackedPosition(first.position);
  assert.equal(child1.exitWarmupStartedAt, t0);
  assert.ok(child1.firstSeenAt > t0 + 60 * 60 * 1000);
  assert.equal(isExitWarmup(child1.firstSeenAt, 60), true);
  assert.equal(isExitWarmup(resolveExitWarmupStartedAt(child1), 60), false);

  const seenAt = child1.firstSeenAt;
  trackPosition(first.position, POOL, "FOOD-SOL", MINT, 1, "spot");
  trackPosition(first.position, POOL, "FOOD-SOL", MINT, 1, "spot", false, {
    exitWarmupStartedAt: Date.now(),
  });
  const afterDetect = getTrackedPosition(first.position);
  assert.equal(afterDetect.exitWarmupStartedAt, t0);
  assert.equal(afterDetect.firstSeenAt, seenAt);
  assert.equal(setExitWarmupStartedAt(first.position, Date.now()), t0);

  clearSpotReentryCooldown();
  const second = await openReentry({
    position: first.position,
    pool: POOL,
    pair: "FOOD-SOL",
    mode: "spot",
    baseMint: MINT,
  });
  assert.equal(second.success, true);
  const child2 = getTrackedPosition(second.position);
  assert.equal(child2.exitWarmupStartedAt, t0);
  assert.notEqual(child2.exitWarmupStartedAt, child1.firstSeenAt);
  assert.equal(isExitWarmup(resolveExitWarmupStartedAt(child2), 60), false);
});

test("entry baru tidak membawa exitWarmupStartedAt", () => {
  resetState();
  const fresh = "FreshPos11111111111111111111111111111111";
  trackPosition(fresh, POOL, "FOOD-SOL", MINT, null, "spot");
  const tracked = getTrackedPosition(fresh);
  assert.equal(tracked.exitWarmupStartedAt, null);
  assert.equal(resolveExitWarmupStartedAt(tracked), tracked.firstSeenAt);
  assert.equal(isExitWarmup(resolveExitWarmupStartedAt(tracked), 60), true);
});

test("deteksi yang membuat baris lebih dulu tidak menimpa warmup yang diwariskan", () => {
  resetState();
  const t0 = Date.now() - 70 * 60 * 1000;
  const addr = "Detected11111111111111111111111111111111";
  trackPosition(addr, POOL, "FOOD-SOL", MINT, null, "spot");
  const detectedAt = getTrackedPosition(addr).firstSeenAt;
  assert.equal(getTrackedPosition(addr).exitWarmupStartedAt, null);
  assert.equal(setExitWarmupStartedAt(addr, t0), t0);
  trackPosition(addr, POOL, "FOOD-SOL", MINT, null, "spot");
  const tracked = getTrackedPosition(addr);
  assert.equal(tracked.exitWarmupStartedAt, t0);
  assert.equal(tracked.firstSeenAt, detectedAt);
  assert.equal(isExitWarmup(resolveExitWarmupStartedAt(tracked), 60), false);
});

test("RSI candle tutup mengabaikan bar berjalan", () => {
  assert.equal(latestClosedRsi(risingCandles(), 2), 100);
  assert.equal(latestClosedRsi(fallingCandles(), 2), 0);
  assert.equal(latestClosedRsi([{ close: 1 }], 2), null);
  assert.equal(latestClosedRsi(null, 2), null);
});

test("spotReentryRsiSkipReason: >= ambang, di bawah, dan mati", () => {
  assert.equal(spotReentryRsiSkipReason(92, { maxRsi: 90, rsiPeriod: 2 }), "re-entry dilewati karena RSI(2) 92 >= 90");
  assert.equal(spotReentryRsiSkipReason(90, { maxRsi: 90, rsiPeriod: 2 }), "re-entry dilewati karena RSI(2) 90 >= 90");
  assert.equal(spotReentryRsiSkipReason(89.99, { maxRsi: 90, rsiPeriod: 2 }), null);
  assert.equal(spotReentryRsiSkipReason(100, { maxRsi: 0, rsiPeriod: 2 }), null);
  assert.equal(spotReentryRsiSkipReason(Number.NaN, { maxRsi: 90, rsiPeriod: 2 }), null);
});

test("re-entry dilewati saat RSI >= 90 dan alert menyebut angkanya", async () => {
  resetState();
  const pos = armSpot();
  const calls = [];
  const plan = await planSpotOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async (mint, pool, opts) => {
      calls.push({ mint, pool, opts });
      return risingCandles();
    },
  });
  assert.equal(plan.willReenter, false);
  assert.equal(plan.reentrySkipReason, "re-entry dilewati karena RSI(2) 100 >= 90");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mint, MINT);
  assert.equal(calls[0].pool, POOL);
  assert.equal(calls[0].opts.priority, "exit");
  assert.equal(calls[0].opts.resolution, "15m");

  const msg = buildCloseMessage("FOOD-SOL", "oor_kanan", 1.2, { success: true }, null, null, {
    willReenter: false,
    mode: "spot",
    skipReason: spotReentryRsiSkipReason(92, { maxRsi: 90, rsiPeriod: 2 }),
  });
  assert.match(msg, /re-entry dilewati karena RSI\(2\) 92 >= 90/);
});

test("re-entry tetap jalan bila RSI di bawah ambang", async () => {
  resetState();
  const pos = armSpot();
  const plan = await planSpotOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async () => fallingCandles(),
  });
  assert.equal(plan.willReenter, true);
  assert.equal(plan.reentrySkipReason, null);
});

test("re-entry tetap jalan bila SPOT_REENTRY_MAX_RSI mati, tanpa ambil candle", async () => {
  resetState();
  const pos = armSpot();
  let calls = 0;
  const plan = await planSpotOorKananReentry(pos, "oor_kanan", {
    cfg: { maxRsi: 0 },
    fetchCandles: async () => {
      calls += 1;
      return risingCandles();
    },
  });
  assert.equal(calls, 0);
  assert.equal(plan.willReenter, true);
  assert.equal(plan.reentrySkipReason, null);
});

test("candle kosong, gagal, atau kurang data: tetap re-entry dan dicatat", async () => {
  resetState();
  const pos = armSpot();

  const missing = [];
  const empty = await planSpotOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async () => null,
    log: { warn: (m) => missing.push(m), info: () => {} },
  });
  assert.equal(empty.willReenter, true);
  assert.equal(empty.reentrySkipReason, null);
  assert.match(missing[0], /tidak tersedia/);

  const thrown = [];
  const failed = await planSpotOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async () => {
      throw new Error("gmgn down");
    },
    log: { warn: (m) => thrown.push(m), info: () => {} },
  });
  assert.equal(failed.willReenter, true);
  assert.match(thrown[0], /gagal diambil/);
  assert.match(thrown[0], /gmgn down/);

  const shortLog = [];
  const short = await planSpotOorKananReentry(pos, "oor_kanan", {
    fetchCandles: async () => closesToCandles([1]),
    log: { warn: (m) => shortLog.push(m), info: () => {} },
  });
  assert.equal(short.willReenter, true);
  assert.match(shortLog[0], /tidak cukup data/);
});
