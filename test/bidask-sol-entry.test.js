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
const { ceilBinsForPricePct, bidaskSolEntryBinPlan, pickBidaskSolEntryPool } =
  await import("../src/entry/bidask-sol-entry.js");
const { executeBidaskSolEntry } = await import("../src/entry/execute.js");
const { getTrackedPosition, getInitialCapitalSol, getEntrySizeSol } = await import("../src/state/positions.js");

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

test("bin math: binStep 80 dan binStep 50 yang melewati 105 bin", () => {
  const step80 = bidaskSolEntryBinPlan({ binStep: 80, lowerPct: -50, upperPct: 15 });
  assert.equal(step80.binsBelow, 87);
  assert.equal(step80.binsAbove, 18);
  assert.equal(step80.binCount, 106);
  assert.ok(step80.binCount > 105);

  const step50 = bidaskSolEntryBinPlan({ binStep: 50, lowerPct: -50, upperPct: 15 });
  assert.equal(step50.binsBelow, 139);
  assert.equal(step50.binsAbove, 29);
  assert.ok(step50.binCount > 105);
});

test("pilih pool: saring TVL dan lebar bin, urut fee lalu volume/TVL lalu bin lebih sedikit", () => {
  const opts = { minTvlUsd: 20000, maxBins: 105, lowerPct: -50, upperPct: 15 };
  const picked = pickBidaskSolEntryPool(
    [
      pool("LOW", { tvl: 1000, fee_active_tvl_ratio: 99 }),
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
  assert.equal(picked.pool, "BEST_FEE");
  assert.equal(picked.binCount, 86);
  assert.equal(picked.lowTvl, 1);
  assert.equal(picked.tooWide, 2);
  assert.ok(picked.ranked.every((row) => row.tvl >= 20000 && row.binCount <= 105));
  const names = picked.ranked.map((row) => row.pool);
  assert.deepEqual(names, ["BEST_FEE", "FEWER_BINS", "FEE_LOW_VOL_HI", "FEE_LOW_VOL"]);
});

test("pilih pool: tidak ada yang lolos → alasan, tanpa pool", () => {
  const r = pickBidaskSolEntryPool(
    [pool("TINY", { tvl: 10, fee_active_tvl_ratio: 9 }), pool("WIDE", { dlmm_params: { bin_step: 50 } })],
    CA,
    { minTvlUsd: 20000, maxBins: 105, lowerPct: -50, upperPct: 15 }
  );
  assert.equal(r.pool, null);
  assert.equal(r.ranked.length, 0);
  assert.match(r.reason, /TVL|bin/);
});

test("executeBidaskSolEntry mencatat mode bidask:sol, modal awal, dan bin atas kosong", async () => {
  const wallet = Keypair.generate();
  const calls = { init: null, chunks: [] };
  const alerts = [];
  const mockPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.01" };
    },
    async quoteCreatePosition() {
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

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].modeLabel, "bidask:sol");
  assert.equal(alerts[0].binStep, 100);
  assert.equal(alerts[0].tvlUsd, 24653.2);
  assert.equal(alerts[0].binCount, 86);
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
