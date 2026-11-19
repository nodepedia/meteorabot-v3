import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bidask-sol-entry-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const { Keypair } = await import("@solana/web3.js");
const {
  ceilBinsForPricePct,
  bidaskSolEntryBinPlan,
  pickBidaskSolEntryPool,
  pollBidaskSolPrices,
  bidaskSolQuotePrice,
  coveredEntryPrices,
  decideBidaskSolTouch,
} = await import("../src/entry/bidask-sol-entry.js");
const { executeBidaskSolEntry, formatTxSignature } = await import("../src/entry/execute.js");
const { runBidaskSolEntry } = await import("../src/entry/index.js");
const { default: config, buildConfig } = await import("../src/config/index.js");
const { getTrackedPosition, getInitialCapitalSol, getEntrySizeSol } = await import("../src/state/positions.js");
const { bidaskSolTouchKey, getBidaskSolTouchDirection, pruneBidaskSolTouch, setBidaskSolTouchDirection } =
  await import("../src/state/bidask-sol-touch.js");

const CA = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const SOL = "So11111111111111111111111111111111111111112";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";

function pool(poolAddress, o = {}) {
  return {
    pool_address: poolAddress,
    token_x: { address: CA },
    token_y: { address: SOL },
    pool_type: "dlmm",
    tvl: 50000,
    fee_active_tvl_ratio: 1,
    volume_tvl_ratio: 1,
    dlmm_params: { bin_step: 100 },
    ...o,
  };
}

test("bin math: binStep 100 sekitar 70 bawah dan 15 atas", () => {
  assert.equal(ceilBinsForPricePct(100, -50), 70);
  assert.equal(ceilBinsForPricePct(100, 15), 15);
  const plan = bidaskSolEntryBinPlan({ binStep: 100, activeBinId: 1000, lowerPct: -50, upperPct: 15 });
  assert.equal(plan.binsBelow, 70);
  assert.equal(plan.binsAbove, 15);
  assert.equal(plan.binCount, 86);
  assert.equal(plan.minBinId, 930);
  assert.equal(plan.maxBinId, 1015);
  assert.equal(plan.depositMinBinId, 930);
  assert.equal(plan.depositMaxBinId, 1000);
});

test("bin plan tiap preset -50/15, -30/15, -20/15", () => {
  assert.deepEqual(config.entry.bidaskSolEntryPresets, [
    { lowerPct: -50, upperPct: 15 },
    { lowerPct: -30, upperPct: 15 },
    { lowerPct: -20, upperPct: 15 },
  ]);
  const plans = config.entry.bidaskSolEntryPresets.map((preset) =>
    bidaskSolEntryBinPlan({ binStep: 100, activeBinId: 1000, ...preset })
  );
  assert.deepEqual(
    plans.map((plan) => plan.binCount),
    [86, 52, 39]
  );
  assert.equal(plans[1].binsBelow, 36);
  assert.equal(plans[2].binsBelow, 23);
  assert.equal(plans[0].minBinId, 930);
  assert.equal(plans[2].minBinId, 977);
  assert.ok(plans.every((plan) => plan.maxBinId === 1015 && plan.depositMaxBinId === 1000));

  const wide = pool("WIDE", { dlmm_params: { bin_step: 80 }, fee_active_tvl_ratio: 9 });
  const blocked = pickBidaskSolEntryPool([wide], CA, { minTvlUsd: 20000, maxBins: 100, lowerPct: -50, upperPct: 15 });
  assert.equal(blocked.pool, null);
  assert.equal(blocked.tooWide, 1);
  const fitted = pickBidaskSolEntryPool([wide], CA, { minTvlUsd: 20000, maxBins: 100, lowerPct: -20, upperPct: 15 });
  assert.equal(fitted.pool, "WIDE");
  assert.equal(fitted.binCount, 48);
});

test("bin math: binStep 80 (106) dan binStep 50 (169) lolos ambang 169", () => {
  assert.equal(config.entry.bidaskSolMaxBins, 169);

  const step80 = bidaskSolEntryBinPlan({ binStep: 80, lowerPct: -50, upperPct: 15 });
  assert.equal(step80.binsBelow, 87);
  assert.equal(step80.binsAbove, 18);
  assert.equal(step80.binCount, 106);
  assert.ok(step80.binCount <= 169);

  const step50 = bidaskSolEntryBinPlan({ binStep: 50, lowerPct: -50, upperPct: 15 });
  assert.equal(step50.binsBelow, 139);
  assert.equal(step50.binsAbove, 29);
  assert.equal(step50.binCount, 169);
  assert.ok(step50.binCount <= 169);
});

test("pilih pool: saring TVL dan lebar bin, urut fee lalu volume/TVL lalu bin lebih sedikit", () => {
  const opts = { minTvlUsd: 20000, maxBins: 169, lowerPct: -50, upperPct: 15 };
  const picked = pickBidaskSolEntryPool(
    [
      pool("LOW", { tvl: 1000, fee_active_tvl_ratio: 99 }),
      pool("STEP40", { tvl: 90000, fee_active_tvl_ratio: 90, dlmm_params: { bin_step: 40 } }),
      pool("STEP50", { tvl: 90000, fee_active_tvl_ratio: 80, dlmm_params: { bin_step: 50 } }),
      pool("STEP80", { tvl: 90000, fee_active_tvl_ratio: 40, dlmm_params: { bin_step: 80 } }),
      pool("BLACK", { fee_active_tvl_ratio: 100, is_blacklisted: true }),
      pool("DAMM", { fee_active_tvl_ratio: 100, pool_type: "damm_v2", dlmm_params: null, damm_v2_params: {} }),
      pool("USDC", { fee_active_tvl_ratio: 100, token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } }),
      pool("FEE_LOW_VOL", { fee_active_tvl_ratio: 2, volume_tvl_ratio: 1, dlmm_params: { bin_step: 100 } }),
      pool("FEE_LOW_VOL_HI", { fee_active_tvl_ratio: 2, volume_tvl_ratio: 5, dlmm_params: { bin_step: 100 } }),
      pool("FEWER_BINS", { fee_active_tvl_ratio: 2, volume_tvl_ratio: 5, dlmm_params: { bin_step: 125 } }),
      pool("BEST_FEE", { fee_active_tvl_ratio: 9, volume_tvl_ratio: 0.1, dlmm_params: { bin_step: 100 } }),
    ],
    CA,
    opts
  );
  assert.equal(picked.pool, "STEP50");
  assert.equal(picked.binCount, 169);
  assert.equal(picked.lowTvl, 1);
  assert.equal(picked.tooWide, 1);
  assert.ok(picked.ranked.every((row) => row.tvl >= 20000 && row.binCount <= 169));
  assert.ok(picked.ranked.some((row) => row.pool === "STEP50" && row.binCount === 169));
  assert.ok(picked.ranked.some((row) => row.pool === "STEP80" && row.binCount === 106));
  const names = picked.ranked.map((row) => row.pool);
  assert.deepEqual(names, ["STEP50", "STEP80", "BEST_FEE", "FEWER_BINS", "FEE_LOW_VOL_HI", "FEE_LOW_VOL"]);
});

test("pilih pool: tidak ada yang lolos → alasan, tanpa pool", () => {
  const r = pickBidaskSolEntryPool(
    [pool("TINY", { tvl: 10, fee_active_tvl_ratio: 9 }), pool("WIDE", { dlmm_params: { bin_step: 40 } })],
    CA,
    { minTvlUsd: 20000, maxBins: 169, lowerPct: -50, upperPct: 15 }
  );
  assert.equal(r.pool, null);
  assert.equal(r.ranked.length, 0);
  assert.match(r.reason, /TVL|bin/);
});

test("executeBidaskSolEntry mencatat mode bidask:sol, modal awal, dan bin atas kosong", async () => {
  const wallet = Keypair.generate();
  const calls = { init: null, chunks: [], quote: null };
  const alerts = [];
  const mockPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.01" };
    },
    async quoteCreatePosition({ strategy }) {
      calls.quote = strategy;
      return { binArrayCost: 0, bitmapExtensionCost: 0 };
    },
    async createExtendedEmptyPosition(min, max) {
      calls.init = { min, max };
      return { tx: "init" };
    },
    async addLiquidityByStrategy({ strategy, totalXAmount, totalYAmount }) {
      calls.chunks.push({
        minBinId: strategy.minBinId,
        maxBinId: strategy.maxBinId,
        strategyType: strategy.strategyType,
        x: totalXAmount.toString(),
        y: totalYAmount.toString(),
      });
      return { tx: "add" };
    },
  };

  const res = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: false,
    tvlUsd: 24653.2,
    triggerPrice: 1,
    solPrice: 100,
    getPoolInfo: async () => ({
      pool: mockPool,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      collectFeeMode: 0,
      pairName: "TOK-SOL",
    }),
    getDlmmSdk: async () => ({ StrategyType: { BidAsk: 2, Spot: 0 } }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0 }),
    sendAndConfirmRobust: async () => "tx_bidask_sol",
    notifyEntry: (payload) => alerts.push(payload),
  });

  assert.equal(res.success, true);
  assert.equal(res.mode, "bidask:sol");
  assert.equal(res.minBinId, 930);
  assert.equal(res.maxBinId, 1015);
  assert.equal(res.binCount, 86);
  assert.ok(res.binCount > 70);
  assert.deepEqual(calls.quote, { minBinId: 930, maxBinId: 1015 });
  assert.equal(res.depositMaxBinId, 1000);
  assert.equal(calls.init.min, 930);
  assert.equal(calls.init.max, 1015);
  assert.ok(calls.chunks.length > 0);
  assert.ok(calls.chunks.every((c) => c.maxBinId <= 1000 && c.minBinId >= 930 && c.strategyType === 2 && c.x === "0"));
  const deposited = calls.chunks.reduce((sum, c) => sum + BigInt(c.y), 0n);
  assert.equal(deposited, 400_000_000n);

  const tracked = getTrackedPosition(res.position);
  assert.equal(tracked.mode, "bidask:sol");
  assert.equal(tracked.initialCapitalSol, 0.4);
  assert.equal(getInitialCapitalSol(res.position), 0.4);
  assert.equal(getEntrySizeSol(res.position), 0.4);
  assert.equal(tracked.binSpan, 85);
  assert.equal(tracked.openBinsBelow, 70);
  assert.equal(tracked.openBinsAbove, 15);
  assert.equal(tracked.entryLowerPct, -50);
  assert.equal(tracked.entryUpperPct, 15);
  assert.equal(alerts[0].priceRangeLabel, "-50%..+15%");

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].modeLabel, "bidask:sol");
  assert.equal(alerts[0].binStep, 100);
  assert.equal(alerts[0].tvlUsd, 24653.2);
  assert.equal(alerts[0].binCount, 86);
  assert.equal(alerts[0].priceUnit, "usd");
  assert.ok(alerts[0].priceFrom > 0 && alerts[0].priceFrom < 1);
  assert.ok(alerts[0].priceTo > 1);

  const rentPool = {
    ...mockPool,
    async quoteCreatePosition() {
      return { binArrayCost: 0.2, bitmapExtensionCost: 0 };
    },
    async createExtendedEmptyPosition() {
      throw new Error("tidak boleh dipanggil");
    },
  };
  const skipped = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: false,
    allowDuplicateMint: true,
    getPoolInfo: async () => ({
      pool: rentPool,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0 }),
    notifyEntry: () => {
      throw new Error("tidak boleh alert");
    },
  });
  assert.equal(skipped.success, false);
  assert.equal(skipped.tryNext, true);
  assert.match(skipped.reason, /non-refundable/);
});

test("executeBidaskSolEntry gagal tertutup bila quoteCreatePosition tidak ada", async () => {
  const wallet = Keypair.generate();
  const noQuote = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.01" };
    },
    async createExtendedEmptyPosition() {
      throw new Error("tidak boleh dipanggil");
    },
  };
  const skipped = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: false,
    allowDuplicateMint: true,
    skipNonRefundable: true,
    getPoolInfo: async () => ({
      pool: noQuote,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0 }),
    notifyEntry: () => {
      throw new Error("tidak boleh alert");
    },
  });
  assert.equal(skipped.success, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.tryNext, true);
  assert.equal(skipped.reason, "quote non-refundable tidak tersedia");

  const allowed = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: true,
    allowDuplicateMint: true,
    skipNonRefundable: false,
    getPoolInfo: async () => ({
      pool: noQuote,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
  });
  assert.equal(allowed.success, true);
  assert.equal(allowed.dryRun, true);
  assert.equal(allowed.binCount, 86);
});

test("quote non-refundable memakai seluruh rentang, juga posisi lebih lebar dari 70 bin", async () => {
  let quoted = null;
  const wide = {
    lbPair: { binStep: 50 },
    async getActiveBin() {
      return { binId: 2000, pricePerToken: "1" };
    },
    async quoteCreatePosition({ strategy }) {
      quoted = strategy;
      return { binArrayCost: 0, bitmapExtensionCost: 0 };
    },
    createExtendedEmptyPosition() {
      throw new Error("tidak boleh dipanggil");
    },
  };
  const res = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: true,
    allowDuplicateMint: true,
    skipNonRefundable: true,
    getPoolInfo: async () => ({
      pool: wide,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
  });
  assert.equal(res.success, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.binCount, 169);
  assert.ok(res.binCount > 70);
  assert.equal(quoted.maxBinId - quoted.minBinId + 1, 169);
  assert.equal(quoted.minBinId, res.minBinId);
  assert.equal(quoted.maxBinId, res.maxBinId);
});

test("pemicu satuan SOL = tokenUsd / solUsd, dan harga SOL hilang tidak memicu", async () => {
  assert.deepEqual(bidaskSolQuotePrice({ tokenUsd: 1, solUsd: 4, entryPriceUnit: "sol" }), {
    unit: "sol",
    price: 0.25,
  });
  assert.equal(bidaskSolQuotePrice({ tokenUsd: 1, solUsd: 0, entryPriceUnit: "sol" }).price, null);
  assert.equal(bidaskSolQuotePrice({ tokenUsd: 1, solUsd: -5, entryPriceUnit: "sol" }).reason, "sol");
  assert.equal(bidaskSolQuotePrice({ tokenUsd: 1, entryPriceUnit: "sol" }).reason, "sol");
  assert.deepEqual(bidaskSolQuotePrice({ tokenUsd: 0.0012, entryPriceUnit: "usd" }), {
    unit: "usd",
    price: 0.0012,
  });

  const other = "MintOther11111111111111111111111111111111";
  let asked = [];
  const hit = await pollBidaskSolPrices(
    [
      { mint: CA, entryPrice: 0.25, entryPriceUnit: "sol", sizeSol: 1 },
      { mint: other, entryPrice: 0.002, entryPriceUnit: "usd", sizeSol: 1 },
    ],
    {
      getPrices: async (ids) => {
        asked = ids;
        return new Map([
          [CA, 1],
          [other, 0.001],
          [SOL, 4],
        ]);
      },
    }
  );
  assert.ok(asked.includes(CA));
  assert.ok(asked.includes(other));
  assert.ok(asked.includes(SOL));
  assert.equal(hit.triggered.length, 1);
  const solHit = hit.triggered.find((row) => row.mint === CA);
  assert.equal(solHit.price, 0.25);
  assert.equal(solHit.priceUsd, 1);
  assert.equal(solHit.solPrice, 4);
  assert.equal(solHit.entryPriceUnit, "sol");
  assert.equal(
    hit.triggered.find((row) => row.mint === other),
    undefined
  );

  const above = await pollBidaskSolPrices([{ mint: CA, entryPrice: 0.2, entryPriceUnit: "sol" }], {
    getPrices: async () =>
      new Map([
        [CA, 1],
        [SOL, 4],
      ]),
  });
  assert.equal(above.triggered.length, 0);

  const missing = await pollBidaskSolPrices([{ mint: CA, entryPrice: 1, entryPriceUnit: "sol" }], {
    now: 1e15,
    getPrices: async () => new Map([[CA, 1]]),
  });
  assert.equal(missing.triggered.length, 0);

  const invalid = await pollBidaskSolPrices([{ mint: CA, entryPrice: 1, entryPriceUnit: "sol" }], {
    getPrices: async () =>
      new Map([
        [CA, 1],
        [SOL, 0],
      ]),
  });
  assert.equal(invalid.triggered.length, 0);

  const negative = await pollBidaskSolPrices([{ mint: CA, entryPrice: 1, entryPriceUnit: "sol" }], {
    getPrices: async () =>
      new Map([
        [CA, 1],
        [SOL, -3],
      ]),
  });
  assert.equal(negative.triggered.length, 0);

  const usdWithoutSol = await pollBidaskSolPrices([{ mint: other, entryPrice: 0.001 }], {
    getPrices: async () => new Map([[other, 0.001]]),
  });
  assert.equal(usdWithoutSol.triggered.length, 1);
  assert.equal(usdWithoutSol.triggered[0].price, 0.001);
  assert.equal(usdWithoutSol.triggered[0].entryPriceUnit, "usd");
});

test("rentang posisi mengikuti satuan target", () => {
  const usd = coveredEntryPrices({
    entryPriceUnit: "usd",
    solPerToken: 0.01,
    solUsd: 100,
    triggerPrice: 1,
    binStep: 100,
    binsBelow: 70,
    binsAbove: 15,
  });
  assert.equal(usd.unit, "usd");
  assert.ok(usd.priceFrom > 0 && usd.priceFrom < 1);
  assert.ok(usd.priceTo > 1);

  const sol = coveredEntryPrices({
    entryPriceUnit: "sol",
    solPerToken: 0.01,
    solUsd: 100,
    triggerPrice: 0.0000123,
    binStep: 100,
    binsBelow: 70,
    binsAbove: 15,
  });
  assert.equal(sol.unit, "sol");
  assert.ok(sol.priceFrom > 0 && sol.priceFrom < 0.01);
  assert.ok(sol.priceTo > 0.01 && sol.priceTo < 0.02);
  assert.ok(Math.abs(usd.priceFrom / sol.priceFrom - 100) < 1e-6);
});

test("executeBidaskSolEntry satuan sol mengirim range SOL ke alert", async () => {
  const wallet = Keypair.generate();
  const alerts = [];
  const mockPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.01" };
    },
    async quoteCreatePosition() {
      return { binArrayCost: 0, bitmapExtensionCost: 0 };
    },
    async createExtendedEmptyPosition() {
      return { tx: "init" };
    },
    async addLiquidityByStrategy() {
      return { tx: "add" };
    },
  };
  const res = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: false,
    allowDuplicateMint: true,
    tvlUsd: 20000,
    entryPriceUnit: "sol",
    triggerPrice: 0.0000123,
    priceUsd: 0.00123,
    solPrice: 100,
    getPoolInfo: async () => ({
      pool: mockPool,
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      collectFeeMode: 0,
      pairName: "TOK-SOL",
    }),
    getDlmmSdk: async () => ({ StrategyType: { BidAsk: 2, Spot: 0 } }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0 }),
    sendAndConfirmRobust: async () => "tx_sol_unit",
    notifyEntry: (payload) => alerts.push(payload),
  });
  assert.equal(res.success, true);
  assert.equal(res.priceUnit, "sol");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].priceUnit, "sol");
  assert.ok(alerts[0].priceFrom > 0 && alerts[0].priceFrom < 0.01);
  assert.ok(alerts[0].priceTo > 0.01 && alerts[0].priceTo < 0.02);
});

const MACCA = "AKotzk1dhcNangAJBtvNKtT9bhbSVZc2mMhRFgkFpump";
const TOUCH_ABOVE = "MintAbove1111111111111111111111111111111";
const TOUCH_MISS = "MintMiss11111111111111111111111111111111";
const TOUCH_RESET = "MintReset1111111111111111111111111111111";

function pricesOf(rows) {
  return async () => new Map(rows);
}

test("arah sentuh: di bawah naik, di atas turun, tepat target masuk sekarang", () => {
  assert.deepEqual(decideBidaskSolTouch(0.00002953, 0.0000379, null), {
    direction: "up",
    triggered: false,
    record: true,
  });
  assert.deepEqual(decideBidaskSolTouch(0.00004, 0.0000379, null), {
    direction: "down",
    triggered: false,
    record: true,
  });
  assert.deepEqual(decideBidaskSolTouch(0.0000379, 0.0000379, null), {
    direction: null,
    triggered: true,
    record: false,
  });
  assert.deepEqual(decideBidaskSolTouch(NaN, 0.0000379, null), {
    direction: null,
    triggered: false,
    record: false,
  });
  assert.equal(decideBidaskSolTouch(0.00003, 0.0000379, "up").triggered, false);
  assert.equal(decideBidaskSolTouch(0.0000379, 0.0000379, "up").triggered, true);
  assert.equal(decideBidaskSolTouch(0.00005, 0.0000379, "up").triggered, true);
  assert.equal(decideBidaskSolTouch(0.00005, 0.0000379, "down").triggered, false);
  assert.equal(decideBidaskSolTouch(0.0000379, 0.0000379, "down").triggered, true);
  assert.equal(decideBidaskSolTouch(0.00001, 0.0000379, "down").triggered, true);
  assert.deepEqual(decideBidaskSolTouch(0.00002953, "now", null), {
    direction: null,
    triggered: true,
    record: false,
  });
  assert.deepEqual(decideBidaskSolTouch(0.00004, "NOW", "up"), {
    direction: null,
    triggered: true,
    record: false,
  });
  assert.deepEqual(decideBidaskSolTouch(NaN, "now", "down"), {
    direction: null,
    triggered: false,
    record: false,
  });
  assert.equal(decideBidaskSolTouch(0, "now", null).triggered, false);
});

test("naik hanya saat harga naik, turun hanya saat harga turun, dan arah tahan dibaca ulang", async () => {
  const upKey = bidaskSolTouchKey(MACCA, 0.0000379, "sol");
  const below = await pollBidaskSolPrices([{ mint: MACCA, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [MACCA, 0.00002953 * 100],
      [SOL, 100],
    ]),
  });
  assert.equal(below.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(upKey), "up");
  const stored = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  assert.equal(stored.bidaskSolTouch[upKey], "up");

  const stillBelow = await pollBidaskSolPrices([{ mint: MACCA, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [MACCA, 0.00003 * 100],
      [SOL, 100],
    ]),
  });
  assert.equal(stillBelow.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(upKey), "up");

  const rose = await pollBidaskSolPrices([{ mint: MACCA, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [MACCA, 0.005],
      [SOL, 100],
    ]),
  });
  assert.equal(rose.triggered.length, 1);
  assert.ok(rose.triggered[0].price >= 0.0000379);
  assert.equal(rose.triggered[0].touchDirection, "up");

  const downKey = bidaskSolTouchKey(TOUCH_ABOVE, 0.0000379, "sol");
  const above = await pollBidaskSolPrices([{ mint: TOUCH_ABOVE, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [TOUCH_ABOVE, 0.00005 * 80],
      [SOL, 80],
    ]),
  });
  assert.equal(above.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(downKey), "down");
  const stillAbove = await pollBidaskSolPrices([{ mint: TOUCH_ABOVE, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [TOUCH_ABOVE, 0.00004 * 80],
      [SOL, 80],
    ]),
  });
  assert.equal(stillAbove.triggered.length, 0);
  const fell = await pollBidaskSolPrices([{ mint: TOUCH_ABOVE, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [TOUCH_ABOVE, 0.002],
      [SOL, 80],
    ]),
  });
  assert.equal(fell.triggered.length, 1);
  assert.equal(fell.triggered[0].touchDirection, "down");
});

test("harga hilang tidak mencatat arah, dan mengubah target tidak memakai arah lama", async () => {
  const missKey = bidaskSolTouchKey(TOUCH_MISS, 0.0000379, "sol");
  const missing = await pollBidaskSolPrices([{ mint: TOUCH_MISS, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([[SOL, 100]]),
  });
  assert.equal(missing.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(missKey), null);

  const oldKey = bidaskSolTouchKey(TOUCH_RESET, 0.0000379, "sol");
  const newKey = bidaskSolTouchKey(TOUCH_RESET, 0.00001, "sol");
  const seeded = await pollBidaskSolPrices([{ mint: TOUCH_RESET, entryPrice: 0.0000379, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [TOUCH_RESET, 0.00002 * 50],
      [SOL, 50],
    ]),
  });
  assert.equal(seeded.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(oldKey), "up");

  const edited = await pollBidaskSolPrices([{ mint: TOUCH_RESET, entryPrice: 0.00001, entryPriceUnit: "sol" }], {
    getPrices: pricesOf([
      [TOUCH_RESET, 0.00002 * 50],
      [SOL, 50],
    ]),
  });
  assert.equal(edited.triggered.length, 0);
  assert.equal(getBidaskSolTouchDirection(newKey), "down");
  assert.equal(getBidaskSolTouchDirection(oldKey), "up");
  pruneBidaskSolTouch([newKey]);
  assert.equal(getBidaskSolTouchDirection(oldKey), null);
  assert.equal(getBidaskSolTouchDirection(newKey), "down");
});

test("baris CA 6 kolom berakhiran sol di-# setelah entry bidask:sol berhasil", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidask-sol-line-"));
  const file = path.join(dir, "pool.txt");
  const line = `${MACCA},1.25x,1,bidask:sol,ca,0.00003790sol`;
  fs.writeFileSync(file, `${line}\n`);
  const key = bidaskSolTouchKey(MACCA, 0.0000379, "sol");
  try {
    const res = await runBidaskSolEntry(
      {
        mint: MACCA,
        sizeSol: 1.25,
        entryPrice: 0.0000379,
        entryPriceUnit: "sol",
        price: 0.0000379,
        solPrice: 100,
        touchDirection: "up",
      },
      {
        dryRun: false,
        poolListFile: file,
        resolveCaPool: async () => ({
          pools: [
            pool("MaccaPool111111111111111111111111111111111", {
              token_x: { address: MACCA },
              token_y: { address: SOL },
            }),
          ],
        }),
        executeBidaskSolEntry: async () => ({ success: true, position: "PosMacca" }),
      }
    );
    assert.equal(res, undefined);
    assert.equal(fs.readFileSync(file, "utf8"), `#${line}\n`);
    assert.equal(getBidaskSolTouchDirection(key), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("token now masuk begitu harga terbaca, termasuk setelah harga bergeser, tanpa arah", async () => {
  const mint = "MintNow111111111111111111111111111111111";
  const key = bidaskSolTouchKey(mint, null, "now");
  assert.equal(key, `${mint}|now`);
  setBidaskSolTouchDirection(key, "up");
  assert.equal(getBidaskSolTouchDirection(key), null);

  const first = await pollBidaskSolPrices(
    [{ mint, entryPrice: null, entryPriceUnit: "now", entryNow: true, sizeSol: 1 }],
    {
      getPrices: pricesOf([
        [mint, 0.004],
        [SOL, 200],
      ]),
    }
  );
  assert.equal(first.triggered.length, 1);
  assert.equal(first.triggered[0].entryNow, true);
  assert.equal(first.triggered[0].entryPrice, null);
  assert.equal(first.triggered[0].entryPriceUnit, "now");
  assert.equal(first.triggered[0].price, 0.004);
  assert.equal(first.triggered[0].touchDirection, null);
  assert.equal(getBidaskSolTouchDirection(key), null);

  const moved = await pollBidaskSolPrices([{ mint, entryNow: true, entryPriceUnit: "now" }], {
    getPrices: pricesOf([
      [mint, 0.0041],
      [SOL, 210],
    ]),
  });
  assert.equal(moved.triggered.length, 1);
  assert.equal(moved.triggered[0].price, 0.0041);

  const unread = await pollBidaskSolPrices([{ mint, entryNow: true }], {
    getPrices: pricesOf([[SOL, 200]]),
  });
  assert.equal(unread.triggered.length, 0);
  const stored = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  const touch = stored.bidaskSolTouch || {};
  assert.equal(
    Object.keys(touch).some((name) => name.startsWith(`${mint}|`)),
    false
  );
});

test("baris now di-# setelah entry, dan tetap menunggu bila pool tidak ada", async () => {
  const mint = "MintNowLine11111111111111111111111111111";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidask-sol-now-"));
  const file = path.join(dir, "pool.txt");
  const line = `${mint},,,bidask:sol,ca,now`;
  fs.writeFileSync(file, `${line}\n`);
  const watch = {
    mint,
    sizeSol: 0.1,
    entryPrice: null,
    entryPriceUnit: "now",
    entryNow: true,
    price: 0.004,
    priceUsd: 0.004,
    solPrice: 200,
  };
  try {
    await runBidaskSolEntry(watch, {
      dryRun: false,
      poolListFile: file,
      resolveCaPool: async () => ({ pools: [] }),
      executeBidaskSolEntry: async () => {
        throw new Error("seharusnya belum membuka posisi");
      },
    });
    assert.equal(fs.readFileSync(file, "utf8"), `${line}\n`);

    let passed = null;
    await runBidaskSolEntry(watch, {
      dryRun: false,
      poolListFile: file,
      resolveCaPool: async () => ({
        pools: [
          pool("NowPool1111111111111111111111111111111111", {
            token_x: { address: mint },
            token_y: { address: SOL },
          }),
        ],
      }),
      executeBidaskSolEntry: async (poolAddress, sizeSol, opts) => {
        passed = { poolAddress, sizeSol, opts };
        return { success: true, position: "PosNow" };
      },
    });
    assert.equal(fs.readFileSync(file, "utf8"), `#${line}\n`);
    assert.equal(passed.sizeSol, 0.1);
    assert.equal(passed.opts.entryPrice ?? null, null);
    assert.equal(passed.opts.entryPriceUnit, "now");
    assert.equal(passed.opts.triggerPrice, 0.004);
    assert.equal(passed.opts.priceUsd, 0.004);
    const plan = bidaskSolEntryBinPlan({ binStep: 100, activeBinId: 1000 });
    assert.equal(plan.lowerPct, config.entry.bidaskSolLowerPct);
    assert.equal(plan.upperPct, config.entry.bidaskSolUpperPct);
    const covered = coveredEntryPrices({
      entryPriceUnit: "now",
      solPerToken: 0.00002,
      solUsd: 200,
      triggerPrice: 0.004,
      priceUsd: 0.004,
      binStep: plan.binStep,
      binsBelow: plan.binsBelow,
      binsAbove: plan.binsAbove,
    });
    assert.equal(covered.unit, "usd");
    assert.ok(Math.abs(covered.priceFrom - 0.004 * 1.01 ** -plan.binsBelow) < 1e-12);
    assert.ok(Math.abs(covered.priceTo - 0.004 * 1.01 ** plan.binsAbove) < 1e-12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("log open bidask:sol mencetak signature transaksi, bukan [object Object]", async () => {
  assert.equal(
    formatTxSignature({ signature: "5RealSigBidaskSol", mode: "priority", attempts: 1 }),
    "5RealSigBidaskSol"
  );
  assert.equal(formatTxSignature("tx_sol_unit"), "tx_sol_unit");
  assert.equal(formatTxSignature({ mode: "priority" }), "");

  const wallet = Keypair.generate();
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(" "));
    orig(...args);
  };
  try {
    const res = await executeBidaskSolEntry(POOL, 0.4, {
      dryRun: false,
      allowDuplicateMint: true,
      getPoolInfo: async () => ({
        pool: {
          lbPair: { binStep: 100 },
          async getActiveBin() {
            return { binId: 1000, pricePerToken: "0.01" };
          },
          async quoteCreatePosition() {
            return { binArrayCost: 0, bitmapExtensionCost: 0 };
          },
          async createExtendedEmptyPosition() {
            return { tx: "init" };
          },
          async addLiquidityByStrategy() {
            return { tx: "add" };
          },
        },
        baseMint: CA,
        baseIsX: true,
        quoteMint: SOL,
        unsupported: false,
        collectFeeMode: 0,
        pairName: "TOK-SOL",
      }),
      getDlmmSdk: async () => ({ StrategyType: { BidAsk: 2, Spot: 0 } }),
      getConnection: () => ({}),
      getWallet: () => wallet,
      getSolBalance: async () => 5,
      buildFeePlan: () => ({ mode: "none" }),
      checkFeeCap: () => ({ ok: true, totalSol: 0 }),
      sendAndConfirmRobust: async () => ({ signature: "5RealSigBidaskSol", mode: "priority", attempts: 1 }),
      notifyEntry: () => {},
    });
    assert.equal(res.success, true);
    assert.equal(res.txSig, "5RealSigBidaskSol");
    const opened = lines.find((row) => row.includes("position opened"));
    assert.match(opened, /tx: 5RealSigBidaskSol/);
    assert.doesNotMatch(opened, /\[object Object\]/);
  } finally {
    console.log = orig;
  }
});

test("preset rusak di config jatuh ke tiga default", () => {
  const bad = buildConfig({ BIDASK_SOL_ENTRY_PRESETS: "nope,200/1" });
  assert.deepEqual(bad.entry.bidaskSolEntryPresets, [
    { lowerPct: -50, upperPct: 15 },
    { lowerPct: -30, upperPct: 15 },
    { lowerPct: -20, upperPct: 15 },
  ]);
  const one = buildConfig({ BIDASK_SOL_ENTRY_PRESETS: "-20/15" });
  assert.deepEqual(one.entry.bidaskSolEntryPresets, [{ lowerPct: -20, upperPct: 15 }]);
});

test("executeBidaskSolEntry memakai rentang per baris untuk quote dan state", async () => {
  const calls = { quote: null };
  const res = await executeBidaskSolEntry(POOL, 0.4, {
    dryRun: false,
    allowDuplicateMint: true,
    lowerPct: -20,
    upperPct: 15,
    getPoolInfo: async () => ({
      pool: {
        lbPair: { binStep: 100 },
        async getActiveBin() {
          return { binId: 1000, pricePerToken: "0.01" };
        },
        async quoteCreatePosition({ strategy }) {
          calls.quote = strategy;
          return { binArrayCost: 0, bitmapExtensionCost: 0 };
        },
        async createExtendedEmptyPosition() {
          return { tx: "init" };
        },
        async addLiquidityByStrategy() {
          return { tx: "add" };
        },
      },
      baseMint: CA,
      baseIsX: true,
      quoteMint: SOL,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
    getDlmmSdk: async () => ({ StrategyType: { BidAsk: 2 } }),
    getConnection: () => ({}),
    getWallet: () => Keypair.generate(),
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0 }),
    sendAndConfirmRobust: async () => "tx_range",
    notifyEntry: () => {},
  });
  assert.equal(res.success, true);
  assert.equal(res.binCount, 39);
  assert.deepEqual(calls.quote, { minBinId: 977, maxBinId: 1015 });
  assert.equal(res.depositMaxBinId, 1000);
  const tracked = getTrackedPosition(res.position);
  assert.equal(tracked.entryLowerPct, -20);
  assert.equal(tracked.entryUpperPct, 15);
  assert.equal(tracked.openBinsBelow, 23);
  assert.equal(tracked.openBinsAbove, 15);
  assert.equal(tracked.binSpan, 38);
});

test("runBidaskSolEntry meneruskan rentang baris dan mengosongkan bila tidak ada", async () => {
  const mint = "MintRangeLine11111111111111111111111111";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidask-sol-range-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, `${mint},,,bidask:sol,ca,now,-20/15\n`);
  const poolRow = pool("RangePool111111111111111111111111111111", {
    token_x: { address: mint },
    token_y: { address: SOL },
  });
  try {
    let passed = null;
    await runBidaskSolEntry(
      {
        mint,
        sizeSol: 0.2,
        entryNow: true,
        entryPrice: null,
        entryPriceUnit: "now",
        price: 0.004,
        priceUsd: 0.004,
        solPrice: 200,
        lowerPct: -20,
        upperPct: 15,
      },
      {
        dryRun: false,
        poolListFile: file,
        resolveCaPool: async () => ({ pools: [poolRow] }),
        executeBidaskSolEntry: async (_poolAddress, _sizeSol, opts) => {
          passed = opts;
          return { success: true, position: "PosRange" };
        },
      }
    );
    assert.equal(passed.lowerPct, -20);
    assert.equal(passed.upperPct, 15);
    assert.equal(fs.readFileSync(file, "utf8").startsWith("#"), true);

    const plain = "MintNoRange1111111111111111111111111111";
    const plainFile = path.join(dir, "plain.txt");
    fs.writeFileSync(plainFile, `${plain},,,bidask:sol,ca,now\n`);
    let plainOpts = null;
    await runBidaskSolEntry(
      {
        mint: plain,
        sizeSol: 0.2,
        entryNow: true,
        entryPrice: null,
        entryPriceUnit: "now",
        price: 0.004,
        priceUsd: 0.004,
        solPrice: 200,
      },
      {
        dryRun: false,
        poolListFile: plainFile,
        resolveCaPool: async () => ({
          pools: [
            pool("PlainPool1111111111111111111111111111111", {
              token_x: { address: plain },
              token_y: { address: SOL },
            }),
          ],
        }),
        executeBidaskSolEntry: async (_poolAddress, _sizeSol, opts) => {
          plainOpts = opts;
          return { success: true, position: "PosPlain" };
        },
      }
    );
    assert.equal(plainOpts.lowerPct, undefined);
    assert.equal(plainOpts.upperPct, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
