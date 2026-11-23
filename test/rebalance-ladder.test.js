import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config/index.js";
import { calcSpotTokenBinMetrics } from "../src/exit/spot-token-bidask.js";
import { bidaskDoubleStepLevel } from "../src/exit/bidask-double-rebalance.js";
import {
  formatRebalanceLadder,
  previousRebalanceLadderLevel,
  rebalanceLadderGap,
  rebalanceLadderLevel,
} from "../src/exit/rebalance-ladder.js";

const ladder = { firstStepPct: 20, nextStepPct: 5 };

test("tangga: drop 19.9 → 0, 20 → 20, 24.9 → 20, 25 → 25, 37 → 35", () => {
  assert.equal(rebalanceLadderLevel(19.9, 20, 5), 0);
  assert.equal(rebalanceLadderLevel(20, 20, 5), 20);
  assert.equal(rebalanceLadderLevel(24.9, 20, 5), 20);
  assert.equal(rebalanceLadderLevel(25, 20, 5), 25);
  assert.equal(rebalanceLadderLevel(37, 20, 5), 35);
  assert.equal(rebalanceLadderLevel(40, 20, 5), 40);

  assert.equal(bidaskDoubleStepLevel(-19.9, ladder), 0);
  assert.equal(bidaskDoubleStepLevel(-20, ladder), 20);
  assert.equal(bidaskDoubleStepLevel(-24.9, ladder), 20);
  assert.equal(bidaskDoubleStepLevel(-25, ladder), 25);
  assert.equal(bidaskDoubleStepLevel(-37, ladder), 35);
  assert.equal(bidaskDoubleStepLevel(1, ladder), 0);
});

test("satu step = jarak ke anak tangga sebelumnya", () => {
  assert.equal(previousRebalanceLadderLevel(20, 20, 5), 0);
  assert.equal(rebalanceLadderGap(20, 20, 5), 20);
  assert.equal(previousRebalanceLadderLevel(25, 20, 5), 20);
  assert.equal(rebalanceLadderGap(25, 20, 5), 5);
  assert.equal(previousRebalanceLadderLevel(35, 20, 5), 30);
  assert.equal(rebalanceLadderGap(35, 20, 5), 5);
  assert.equal(previousRebalanceLadderLevel(10, 20, 5), 0);
  assert.equal(rebalanceLadderGap(10, 20, 5), 10);
  assert.equal(rebalanceLadderGap(40, 10, 10), 10);
});

test("stepPct lama tanpa kunci baru = tangga seragam, kunci baru menang bila ada", () => {
  const defaults = buildConfig({});
  assert.equal(defaults.bidaskDoubleRebalance.firstStepPct, 20);
  assert.equal(defaults.bidaskDoubleRebalance.nextStepPct, 5);
  assert.equal(defaults.bidaskDoubleRebalance.legacyUniform, false);
  assert.equal(defaults.bidaskSolRebalance.firstStepPct, 20);
  assert.equal(defaults.bidaskSolRebalance.nextStepPct, 5);
  assert.equal(defaults.bidaskSolRebalance.legacyUniform, false);
  assert.equal(defaults.spotTokenBidask.stepPct, 10);
  assert.equal(defaults.spotTokenBidask.firstStepPct, undefined);

  const oldDouble = buildConfig({ BIDASK_DOUBLE_REBALANCE_STEP_PCT: "12" });
  assert.equal(oldDouble.bidaskDoubleRebalance.firstStepPct, 12);
  assert.equal(oldDouble.bidaskDoubleRebalance.nextStepPct, 12);
  assert.equal(oldDouble.bidaskDoubleRebalance.stepPct, 12);
  assert.equal(oldDouble.bidaskDoubleRebalance.legacyUniform, true);
  assert.equal(bidaskDoubleStepLevel(-24, oldDouble.bidaskDoubleRebalance), 24);
  assert.equal(bidaskDoubleStepLevel(-23.9, oldDouble.bidaskDoubleRebalance), 12);

  const oldSol = buildConfig({ BIDASK_SOL_REBALANCE_STEP_PCT: "25" });
  assert.equal(oldSol.bidaskSolRebalance.firstStepPct, 25);
  assert.equal(oldSol.bidaskSolRebalance.nextStepPct, 25);
  assert.equal(oldSol.bidaskSolRebalance.legacyUniform, true);

  const both = buildConfig({
    BIDASK_DOUBLE_REBALANCE_STEP_PCT: "10",
    BIDASK_DOUBLE_REBALANCE_FIRST_STEP_PCT: "20",
    BIDASK_DOUBLE_REBALANCE_NEXT_STEP_PCT: "5",
  });
  assert.equal(both.bidaskDoubleRebalance.firstStepPct, 20);
  assert.equal(both.bidaskDoubleRebalance.nextStepPct, 5);
  assert.equal(both.bidaskDoubleRebalance.stepPct, 10);
  assert.equal(both.bidaskDoubleRebalance.legacyUniform, false);

  const onlyFirst = buildConfig({
    BIDASK_SOL_REBALANCE_STEP_PCT: "10",
    BIDASK_SOL_REBALANCE_FIRST_STEP_PCT: "30",
  });
  assert.equal(onlyFirst.bidaskSolRebalance.firstStepPct, 30);
  assert.equal(onlyFirst.bidaskSolRebalance.nextStepPct, 5);
  assert.equal(onlyFirst.bidaskSolRebalance.legacyUniform, false);

  assert.match(formatRebalanceLadder(defaults.bidaskDoubleRebalance), /^20% lalu tiap 5%/);
  assert.equal(formatRebalanceLadder(oldDouble.bidaskDoubleRebalance), "seragam tiap 12% (STEP_PCT lama)");
});

test("spot tetap kelipatan rata 10, tidak ikut tangga 20/5", () => {
  const at10 = calcSpotTokenBinMetrics({ activeBin: 280, lowerBin: 100, upperBin: 300 });
  assert.equal(at10.tokenBinPct, 10);
  assert.equal(at10.stepLevel, 10);
  const at15 = calcSpotTokenBinMetrics({ activeBin: 269, lowerBin: 100, upperBin: 300 });
  assert.equal(at15.tokenBinPct, 15.5);
  assert.equal(at15.stepLevel, 10);
});

test("angka stepPct saja di cfg runtime tetap seragam, supaya state lama tidak berubah arti", () => {
  assert.equal(bidaskDoubleStepLevel(-19.999, 10), 10);
  assert.equal(bidaskDoubleStepLevel(-20, 10), 20);
  assert.equal(bidaskDoubleStepLevel(-45, 10), 40);
  assert.equal(bidaskDoubleStepLevel(-9.9, { stepPct: 10 }), 0);
  assert.equal(bidaskDoubleStepLevel(-10, { stepPct: 10 }), 10);
});
