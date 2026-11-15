import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import BN from "bn.js";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-bidask-sol-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.IMPORTANT_LOG_FILE = path.join(TMP, "important.log");
process.env.IMPORTANT_EVENTS_FILE = path.join(TMP, "important-events.jsonl");

const { buildLiquidityStrategyParameters, getLiquidityStrategyParameterBuilder, StrategyType } =
  await import("@meteora-ag/dlmm");
const { buildConfig } = await import("../src/config/index.js");
const {
  bidaskSolSolSideCallCount,
  evaluateBidaskSolRebalance,
  evaluateBidaskSolSolSide,
  handleBidaskSolRebalance,
  handleBidaskSolSolSideRebalance,
  resetBidaskSolSolSideCallCount,
} = await import("../src/exit/bidask-sol-rebalance.js");
const { evaluateSpotTokenBidaskTrigger } = await import("../src/exit/spot-token-bidask.js");
const { evaluateBidaskDoubleRebalance } = await import("../src/exit/bidask-double-rebalance.js");
const { handleSpotTokenBidask } = await import("../src/exit/spot-token-bidask.js");
const { handleBidaskDoubleRebalance } = await import("../src/exit/bidask-double-rebalance.js");
const { trackPosition, getTrackedPosition } = await import("../src/state/positions.js");

const cfg = { enabled: true, stepPct: 10 };
const doubleCfg = { enabled: true, solEnabled: true, stepPct: 10, cooldownSec: 0, retry: 1 };

function solPos(activeBin, extra = {}) {
  return {
    mode: "bidask:sol",
    position: "posSol",
    pool: "poolSol",
    pair: "TOK-SOL",
    baseMint: "mint",
    lowerBin: 0,
    upperBin: 100,
    activeBin,
    ...extra,
  };
}

test("config: BIDASK_SOL_REBALANCE default nyala, step 10", () => {
  const built = buildConfig({});
  assert.equal(built.bidaskSolRebalance.enabled, true);
  assert.equal(built.bidaskSolRebalance.stepPct, 10);
  const off = buildConfig({ BIDASK_SOL_REBALANCE_ENABLED: "false", BIDASK_SOL_REBALANCE_STEP_PCT: "25" });
  assert.equal(off.bidaskSolRebalance.enabled, false);
  assert.equal(off.bidaskSolRebalance.stepPct, 25);
});

test("step 10/20/30, tidak mengulang step yang sama atau lebih rendah, flag mati", () => {
  const fresh = { lastBidaskSolRebalancePct: 0, lastBidaskSolRebalanceAt: null, lastBidaskSolRebalanceBin: null };

  const tooSmall = evaluateBidaskSolRebalance({ pos: solPos(91), tracked: fresh, cfg });
  assert.equal(tooSmall.action, "none");
  assert.equal(tooSmall.stepLevel, 0);

  const step10 = evaluateBidaskSolRebalance({ pos: solPos(90), tracked: fresh, cfg });
  assert.equal(step10.action, "rebalance");
  assert.equal(step10.reason, "step_10pct");
  assert.equal(step10.stepLevel, 10);
  assert.equal(step10.fromBinId, 91);
  assert.equal(step10.toBinId, 100);

  const still10 = evaluateBidaskSolRebalance({
    pos: solPos(85),
    tracked: { lastBidaskSolRebalancePct: 10 },
    cfg,
  });
  assert.equal(still10.action, "none");
  assert.equal(still10.reason, "below_next_step");

  const step20 = evaluateBidaskSolRebalance({
    pos: solPos(80),
    tracked: { lastBidaskSolRebalancePct: 10 },
    cfg,
  });
  assert.equal(step20.action, "rebalance");
  assert.equal(step20.stepLevel, 20);
  assert.equal(step20.fromBinId, 81);

  const same20 = evaluateBidaskSolRebalance({
    pos: solPos(80),
    tracked: { lastBidaskSolRebalancePct: 20 },
    cfg,
  });
  assert.equal(same20.action, "none");
  assert.equal(same20.reason, "below_next_step");

  const step30 = evaluateBidaskSolRebalance({
    pos: solPos(70),
    tracked: { lastBidaskSolRebalancePct: 20 },
    cfg,
  });
  assert.equal(step30.action, "rebalance");
  assert.equal(step30.stepLevel, 30);

  const dropped = evaluateBidaskSolRebalance({
    pos: solPos(80),
    tracked: { lastBidaskSolRebalancePct: 30 },
    cfg,
  });
  assert.equal(dropped.action, "none");
  assert.equal(dropped.reason, "below_next_step");
  assert.notEqual(dropped.action, "rebalance_sol");

  const disabled = evaluateBidaskSolRebalance({
    pos: solPos(70),
    tracked: fresh,
    cfg: { enabled: false, stepPct: 10 },
  });
  assert.equal(disabled.action, "none");
  assert.equal(disabled.reason, "disabled");
});

test("mode lain tidak memicu rebalance bidask:sol, dan sebaliknya", async () => {
  const sol = solPos(70);
  const spot = { ...sol, mode: "spot" };
  const dbl = { ...sol, mode: "bidask:double" };

  assert.equal(evaluateBidaskSolRebalance({ pos: spot, tracked: {}, cfg }).reason, "not_bidask_sol");
  assert.equal(evaluateBidaskSolRebalance({ pos: dbl, tracked: {}, cfg }).reason, "not_bidask_sol");
  assert.equal(
    evaluateSpotTokenBidaskTrigger({ pos: sol, tracked: {}, cfg: { enabled: true, stepPct: 10 } }).reason,
    "not_spot"
  );
  assert.equal(
    evaluateBidaskDoubleRebalance({
      pos: sol,
      tracked: { entryPoolPrice: 1, lastBidaskDoubleRebalancePct: 0 },
      cfg: doubleCfg,
      priceChangePct: -40,
    }).reason,
    "not_bidask_double"
  );

  let poolCalls = 0;
  const boom = async () => {
    poolCalls += 1;
    throw new Error("pool tidak boleh dipanggil");
  };

  const solOnSpot = await handleBidaskSolRebalance(spot, { cfg, dryRun: false, getPoolInfo: boom });
  assert.equal(solOnSpot.reason, "not_bidask_sol");

  const spotOnSol = await handleSpotTokenBidask(sol, {
    cfg: { enabled: true, stepPct: 10 },
    dryRun: false,
    getPoolInfo: boom,
  });
  assert.equal(spotOnSol.reason, "not_spot");

  const doubleOnSol = await handleBidaskDoubleRebalance(sol, {
    cfg: doubleCfg,
    dryRun: false,
    skipLiveGuard: true,
    priceChangePct: -40,
    tracked: { entryPoolPrice: 1, lastBidaskDoubleRebalancePct: 0 },
    getPoolInfo: boom,
  });
  assert.equal(doubleOnSol.reason, "not_bidask_double");
  assert.equal(poolCalls, 0);
});

function rebalanceIx() {
  const data = Buffer.alloc(80, 0);
  Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]).copy(data, 0);
  data[48] = 0;
  return new TransactionInstruction({ keys: [], programId: PublicKey.default, data });
}

test("inplace hanya membentuk ulang bin token; bin SOL tidak ikut", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  const poolAddr = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, poolAddr, "TOK-SOL", mint, null, "bidask:sol", false);
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalancePct, 0);
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalanceAt, null);
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalanceBin, null);

  const active = 100;
  const lower = 80;
  const upper = 140;
  const withdraws = [];
  let removeCalls = 0;
  let balanceReads = 0;
  const ix = rebalanceIx();
  const wallet = Keypair.generate();
  const pos = {
    mode: "bidask:sol",
    position,
    pool: poolAddr,
    pair: "TOK-SOL",
    baseMint: mint,
    activeBin: active,
    lowerBin: lower,
    upperBin: upper,
  };

  const sharedPool = () => ({
    pool: {
      lbPair: { binStep: 100 },
      getActiveBin: async () => ({ binId: active }),
      getPosition: async () => ({
        positionData: {
          lowerBinId: lower,
          upperBinId: upper,
          positionBinData: [
            { binId: 80, positionXAmount: "0", positionYAmount: "500000000" },
            { binId: 100, positionXAmount: "0", positionYAmount: "500000000" },
            { binId: 101, positionXAmount: "250000", positionYAmount: "0" },
            { binId: 120, positionXAmount: "750000", positionYAmount: "0" },
          ],
        },
      }),
      simulateRebalancePosition: async (_position, _data, _claimFee, _claimReward, deposits, wds) => {
        withdraws.push({ deposits, withdraws: wds });
        return { simulationResult: { actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(0) } };
      },
      rebalancePosition: async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: [ix] }),
      removeLiquidity: async () => {
        removeCalls += 1;
        return { id: "should-not" };
      },
    },
    baseIsX: true,
    unsupported: false,
    pairName: "TOK-SOL",
  });

  const res = await handleBidaskSolRebalance(pos, {
    dryRun: false,
    cfg,
    rebalanceMode: "inplace",
    now: () => 5_000,
    tracked: getTrackedPosition(position),
    getPoolInfo: async () => sharedPool(),
    getDlmmSdk: async () => ({
      StrategyType,
      buildLiquidityStrategyParameters,
      getLiquidityStrategyParameterBuilder,
    }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getTokenBalance: async () => {
      balanceReads += 1;
      return 9999;
    },
    getMintDecimals: async () => 6,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
    sendAndConfirmRobust: async () => ({ signature: "sig-sol-token" }),
    sleep: async () => {},
    notifyBidaskSolTokenRebalance: (payload) => {
      assert.equal(payload.success, true);
      assert.equal(payload.stepPct, 60);
      assert.equal(payload.fromBinId, active + 1);
      assert.equal(payload.toBinId, upper);
      assert.match(
        `✅ BIDASK SOL TOKEN REBALANCE ${payload.pair} — step ${payload.stepPct}%`,
        /✅ BIDASK SOL TOKEN REBALANCE TOK-SOL — step 60%/
      );
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.rebalanceType, "token_bidask");
  assert.equal(res.fromBinId, 101);
  assert.equal(res.toBinId, 140);
  assert.equal(removeCalls, 0);
  assert.equal(balanceReads, 0);
  assert.ok(withdraws.length > 0);
  for (const call of withdraws) {
    for (const wd of call.withdraws) {
      const from = Number(wd.minBinId.toString());
      const to = Number(wd.maxBinId.toString());
      assert.ok(from > active, `bin SOL ikut terambil: ${from}`);
      assert.ok(to <= upper);
      assert.ok(to >= from);
    }
    assert.ok(call.deposits[0].deltaX.gtn(0));
  }
  const saved = getTrackedPosition(position);
  assert.equal(saved.lastBidaskSolRebalancePct, 60);
  assert.equal(saved.lastBidaskSolRebalanceBin, active);
  assert.equal(saved.lastBidaskSolRebalanceAt > 0, true);

  const again = await handleBidaskSolRebalance(pos, {
    dryRun: false,
    cfg,
    rebalanceMode: "inplace",
    tracked: getTrackedPosition(position),
    getPoolInfo: async () => {
      throw new Error("step yang sama tidak boleh diulang");
    },
  });
  assert.equal(again.reason, "below_next_step");
  assert.equal(removeCalls, 0);
});

test("withdraw hanya menarik dan menyetor rentang bin token", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  const poolAddr = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, poolAddr, "TOK-SOL", mint, null, "bidask:sol", false);

  const active = 80;
  const lower = 0;
  const upper = 100;
  const removes = [];
  const adds = [];
  let inplaceCalls = 0;
  const wallet = Keypair.generate();
  const pos = {
    mode: "bidask:sol",
    position,
    pool: poolAddr,
    pair: "TOK-SOL",
    baseMint: mint,
    activeBin: active,
    lowerBin: lower,
    upperBin: upper,
  };

  const res = await handleBidaskSolRebalance(pos, {
    dryRun: false,
    cfg: { ...cfg, retry: 1 },
    rebalanceMode: "withdraw",
    now: () => 8_000,
    tracked: getTrackedPosition(position),
    tryInPlaceRebalance: async () => {
      inplaceCalls += 1;
      throw new Error("inplace tidak dipakai pada mode withdraw");
    },
    getPoolInfo: async () => ({
      pool: {
        lbPair: { binStep: 20 },
        getActiveBin: async () => ({ binId: active }),
        getPosition: async () => ({
          positionData: {
            lowerBinId: lower,
            upperBinId: upper,
            positionBinData: [
              { binId: 70, positionXAmount: "0", positionYAmount: "400000000" },
              { binId: 80, positionXAmount: "0", positionYAmount: "400000000" },
              { binId: 90, positionXAmount: "1000000", positionYAmount: "0" },
              { binId: 100, positionXAmount: "1000000", positionYAmount: "0" },
            ],
          },
        }),
        removeLiquidity: async (params) => {
          removes.push(params);
          return { id: "rm" };
        },
        addLiquidityByStrategy: async (params) => {
          adds.push(params);
          return { id: "add" };
        },
      },
      baseIsX: true,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
    getDlmmSdk: async () => ({ StrategyType }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getTokenBalance: async () => 0,
    getMintDecimals: async () => 6,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
    sendAndConfirmRobust: async () => ({ signature: "sig-wd" }),
    sleep: async () => {},
    notifyBidaskSolTokenRebalance: () => {},
  });

  assert.equal(res.success, true);
  assert.equal(res.stepLevel, 20);
  assert.equal(inplaceCalls, 0);
  assert.equal(removes.length, 1);
  assert.equal(removes[0].fromBinId, active + 1);
  assert.equal(removes[0].toBinId, upper);
  assert.equal(removes[0].bps.toString(), "10000");
  assert.ok(adds.length >= 1);
  for (const add of adds) {
    assert.ok(add.strategy.minBinId > active);
    assert.ok(add.strategy.maxBinId <= upper);
    assert.equal(add.strategy.strategyType, StrategyType.BidAsk);
    assert.equal(add.totalYAmount.toString(), "0");
    assert.ok(add.totalXAmount.gtn(0));
  }
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalancePct, 20);
});

test("jalur otomatis bidask:sol tidak pernah memanggil rebalance sisi SOL", async () => {
  resetBidaskSolSolSideCallCount();
  const indexSrc = fs.readFileSync(path.resolve("src/exit/index.js"), "utf8");
  assert.equal(indexSrc.includes("handleBidaskSolSolSideRebalance"), false);

  const recovered = evaluateBidaskSolRebalance({
    pos: solPos(80),
    tracked: { lastBidaskSolRebalancePct: 30 },
    cfg,
  });
  assert.equal(recovered.action, "none");
  assert.notEqual(recovered.action, "rebalance_sol");

  const forcedEmpty = await handleBidaskSolRebalance(solPos(100), {
    cfg,
    force: true,
    dryRun: true,
    tracked: { lastBidaskSolRebalancePct: 20 },
  });
  assert.equal(forcedEmpty.reason, "no_token_bins");
  assert.notEqual(forcedEmpty.rebalanceType, "sol_bidask");

  const refused = await handleBidaskSolRebalance(solPos(70), {
    cfg,
    side: "sol",
    force: true,
    dryRun: true,
    tracked: { lastBidaskSolRebalancePct: 0 },
  });
  assert.equal(refused.reason, "sol_side_manual_only");

  const auto = await handleBidaskSolRebalance(solPos(70), {
    cfg,
    dryRun: true,
    tracked: { lastBidaskSolRebalancePct: 0 },
  });
  assert.equal(auto.rebalanceType, "token_bidask");
  assert.equal(bidaskSolSolSideCallCount(), 0);

  const manual = await handleBidaskSolSolSideRebalance(solPos(80), { dryRun: true });
  assert.equal(manual.rebalanceType, "sol_bidask");
  assert.equal(manual.success, true);
  assert.equal(bidaskSolSolSideCallCount(), 1);
  assert.equal(evaluateBidaskSolSolSide({ pos: solPos(101) }).reason, "no_sol_bins");
  assert.equal(evaluateBidaskSolSolSide({ pos: solPos(-1) }).reason, "no_sol_bins");
});

test("sisi SOL bidask:sol manual hanya membentuk ulang bin SOL", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  resetBidaskSolSolSideCallCount();
  const poolAddr = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, poolAddr, "TOK-SOL", mint, null, "bidask:sol", false);

  const active = 100;
  const lower = 80;
  const upper = 140;
  const withdraws = [];
  let removeCalls = 0;
  const ix = rebalanceIx();
  const wallet = Keypair.generate();
  const pos = {
    mode: "bidask:sol",
    position,
    pool: poolAddr,
    pair: "TOK-SOL",
    baseMint: mint,
    activeBin: active,
    lowerBin: lower,
    upperBin: upper,
  };

  const res = await handleBidaskSolSolSideRebalance(pos, {
    dryRun: false,
    cfg,
    rebalanceMode: "inplace",
    getPoolInfo: async () => ({
      pool: {
        lbPair: { binStep: 100 },
        getActiveBin: async () => ({ binId: active }),
        getPosition: async () => ({
          positionData: {
            lowerBinId: lower,
            upperBinId: upper,
            positionBinData: [
              { binId: 80, positionXAmount: "0", positionYAmount: "500000000" },
              { binId: 100, positionXAmount: "0", positionYAmount: "500000000" },
              { binId: 101, positionXAmount: "250000", positionYAmount: "0" },
              { binId: 120, positionXAmount: "750000", positionYAmount: "0" },
            ],
          },
        }),
        simulateRebalancePosition: async (_position, _data, _claimFee, _claimReward, deposits, wds) => {
          withdraws.push({ deposits, withdraws: wds });
          return { simulationResult: { actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(0) } };
        },
        rebalancePosition: async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: [ix] }),
        removeLiquidity: async () => {
          removeCalls += 1;
          return { id: "should-not" };
        },
      },
      baseIsX: true,
      unsupported: false,
      pairName: "TOK-SOL",
    }),
    getDlmmSdk: async () => ({
      StrategyType,
      buildLiquidityStrategyParameters,
      getLiquidityStrategyParameterBuilder,
    }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
    sendAndConfirmRobust: async () => ({ signature: "sig-sol-side" }),
    sleep: async () => {},
    notifyBidaskSolSolSideRebalance: (payload) => {
      assert.equal(payload.success, true);
      assert.equal(payload.fromBinId, lower);
      assert.equal(payload.toBinId, active);
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.rebalanceType, "sol_bidask");
  assert.equal(res.fromBinId, lower);
  assert.equal(res.toBinId, active);
  assert.equal(removeCalls, 0);
  assert.ok(withdraws.length > 0);
  for (const call of withdraws) {
    for (const wd of call.withdraws) {
      const from = Number(wd.minBinId.toString());
      const to = Number(wd.maxBinId.toString());
      assert.ok(from >= lower);
      assert.ok(to <= active, `bin token ikut terambil: ${to}`);
    }
    assert.ok(call.deposits[0].deltaY.gtn(0));
  }
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalancePct, 0);
  assert.equal(bidaskSolSolSideCallCount(), 1);
});

test("sisi SOL kosong atau fee melewati batas tidak membentuk ulang", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  const poolAddr = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, poolAddr, "TOK-SOL", mint, null, "bidask:sol", false);
  const wallet = Keypair.generate();
  let removeCalls = 0;
  const pos = {
    mode: "bidask:sol",
    position,
    pool: poolAddr,
    pair: "TOK-SOL",
    baseMint: mint,
    activeBin: 80,
    lowerBin: 80,
    upperBin: 100,
  };
  const poolInfo = async () => ({
    pool: {
      lbPair: { binStep: 20 },
      getActiveBin: async () => ({ binId: 80 }),
      getPosition: async () => ({
        positionData: {
          lowerBinId: 80,
          upperBinId: 100,
          positionBinData: [{ binId: 80, positionXAmount: "1000", positionYAmount: "0" }],
        },
      }),
      removeLiquidity: async () => {
        removeCalls += 1;
        return { id: "no" };
      },
    },
    baseIsX: true,
    unsupported: false,
    pairName: "TOK-SOL",
  });
  const empty = await handleBidaskSolSolSideRebalance(pos, {
    dryRun: false,
    cfg,
    rebalanceMode: "withdraw",
    getPoolInfo: poolInfo,
    getDlmmSdk: async () => ({ StrategyType }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
    sendAndConfirmRobust: async () => ({ signature: "no" }),
    sleep: async () => {},
    notifyBidaskSolSolSideRebalance: () => {},
  });
  assert.equal(empty.reason, "no_sol_liquidity");
  assert.equal(removeCalls, 0);
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalancePct, 0);

  let feeChecked = 0;
  const capped = await handleBidaskSolSolSideRebalance(
    { ...pos, activeBin: 90, lowerBin: 80 },
    {
      dryRun: false,
      cfg,
      rebalanceMode: "inplace",
      getPoolInfo: async () => ({
        pool: {
          lbPair: { binStep: 20 },
          getActiveBin: async () => ({ binId: 90 }),
          getPosition: async () => ({
            positionData: {
              lowerBinId: 80,
              upperBinId: 100,
              positionBinData: [{ binId: 85, positionXAmount: "0", positionYAmount: "1000000" }],
            },
          }),
          removeLiquidity: async () => {
            removeCalls += 1;
            return { id: "no" };
          },
        },
        baseIsX: true,
        unsupported: false,
      }),
      getDlmmSdk: async () => ({ StrategyType }),
      getConnection: () => ({}),
      getWallet: () => wallet,
      buildFeePlan: () => ({ mode: "priority" }),
      checkFeeCap: () => {
        feeChecked += 1;
        return { ok: false, totalSol: 1, cap: 0.01 };
      },
      tryInPlaceRebalance: async () => {
        throw new Error("fee cap menahan rebalance");
      },
      sendAndConfirmRobust: async () => ({ signature: "no" }),
      sleep: async () => {},
      notifyBidaskSolSolSideRebalance: () => {},
    }
  );
  assert.equal(capped.feeCap, true);
  assert.equal(capped.success, false);
  assert.equal(feeChecked, 1);
  assert.equal(removeCalls, 0);
});

test("mode withdraw sisi SOL hanya menarik dan menyetor bin SOL", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  const poolAddr = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, poolAddr, "TOK-SOL", mint, null, "bidask:sol", false);
  const active = 90;
  const lower = 70;
  const upper = 120;
  const removes = [];
  const adds = [];
  let inplaceCalls = 0;
  const res = await handleBidaskSolSolSideRebalance(
    {
      mode: "bidask:sol",
      position,
      pool: poolAddr,
      pair: "TOK-SOL",
      baseMint: mint,
      activeBin: active,
      lowerBin: lower,
      upperBin: upper,
    },
    {
      dryRun: false,
      cfg: { ...cfg, retry: 1 },
      rebalanceMode: "withdraw",
      tryInPlaceRebalance: async () => {
        inplaceCalls += 1;
        throw new Error("inplace tidak dipakai pada mode withdraw");
      },
      getPoolInfo: async () => ({
        pool: {
          lbPair: { binStep: 25 },
          getActiveBin: async () => ({ binId: active }),
          getPosition: async () => ({
            positionData: {
              lowerBinId: lower,
              upperBinId: upper,
              positionBinData: [
                { binId: 70, positionXAmount: "0", positionYAmount: "400000000" },
                { binId: 90, positionXAmount: "0", positionYAmount: "200000000" },
                { binId: 100, positionXAmount: "1000000", positionYAmount: "0" },
              ],
            },
          }),
          removeLiquidity: async (params) => {
            removes.push(params);
            return { id: "rm" };
          },
          addLiquidityByStrategy: async (params) => {
            adds.push(params);
            return { id: "add" };
          },
        },
        baseIsX: true,
        unsupported: false,
        pairName: "TOK-SOL",
      }),
      getDlmmSdk: async () => ({ StrategyType }),
      getConnection: () => ({}),
      getWallet: () => Keypair.generate(),
      buildFeePlan: () => ({ mode: "none" }),
      checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
      sendAndConfirmRobust: async () => ({ signature: "sig-wd-sol" }),
      sleep: async () => {},
      notifyBidaskSolSolSideRebalance: () => {},
    }
  );
  assert.equal(res.success, true);
  assert.equal(res.rebalanceType, "sol_bidask");
  assert.equal(inplaceCalls, 0);
  assert.equal(removes.length, 1);
  assert.equal(removes[0].fromBinId, lower);
  assert.equal(removes[0].toBinId, active);
  assert.equal(removes[0].shouldClaimAndClose, false);
  assert.ok(adds.length >= 1);
  for (const add of adds) {
    assert.ok(add.strategy.minBinId >= lower);
    assert.ok(add.strategy.maxBinId <= active);
    assert.equal(add.strategy.strategyType, StrategyType.BidAsk);
    assert.equal(add.totalXAmount.toString(), "0");
    assert.ok(add.totalYAmount.gtn(0));
  }
  assert.equal(getTrackedPosition(position).lastBidaskSolRebalancePct, 0);
});
