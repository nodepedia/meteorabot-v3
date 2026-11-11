import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import BN from "bn.js";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-rebalance-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { buildLiquidityStrategyParameters, getLiquidityStrategyParameterBuilder, toAmountIntoBins, StrategyType } =
  await import("@meteora-ag/dlmm");
const {
  capRedepositRaw,
  splitBinRange,
  buildOneSidedDeposit,
  globalShapeSlices,
  tryInPlaceRebalance,
  resolveRebalanceMode,
  solSpendCapRaw,
  sumPositionSideRaw,
} = await import("../src/exit/rebalance-shape.js");
const { handleBidaskDoubleRebalance } = await import("../src/exit/bidask-double-rebalance.js");
const { trackPosition, getTrackedPosition, setEntryPoolPrice } = await import("../src/state/positions.js");

const REBALANCE_DISC = Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]);

test("capRedepositRaw tidak pernah memakai saldo wallet penuh", () => {
  const fullWallet = capRedepositRaw({
    positionRaw: new BN(1_000),
    balanceBeforeRaw: new BN(5_000),
    balanceAfterRaw: new BN(6_000),
  });
  assert.equal(fullWallet.toString(), "1000");

  const partial = capRedepositRaw({
    positionRaw: new BN(1_000),
    balanceBeforeRaw: new BN(5_000),
    balanceAfterRaw: new BN(5_800),
  });
  assert.equal(partial.toString(), "800");

  const onlyDelta = capRedepositRaw({
    balanceBeforeRaw: new BN(9_000),
    balanceAfterRaw: new BN(9_400),
  });
  assert.equal(onlyDelta.toString(), "400");

  const unchangedRead = capRedepositRaw({
    positionRaw: new BN(600_000_000),
    balanceBeforeRaw: new BN(1_500_000_000),
    balanceAfterRaw: new BN(1_500_000_000),
    walletCapRaw: solSpendCapRaw(1_500_000_000, 0.05),
  });
  assert.equal(unchangedRead.toString(), "600000000");

  const gas = capRedepositRaw({
    positionRaw: new BN(2_000_000_000),
    walletCapRaw: solSpendCapRaw(1_000_000_000, 0.05),
  });
  assert.equal(gas.toString(), String(1_000_000_000 - 50_000_000));
});

test("resolveRebalanceMode dan pecahan bin", () => {
  assert.equal(resolveRebalanceMode(undefined, "inplace"), "inplace");
  assert.equal(resolveRebalanceMode("withdraw"), "withdraw");
  assert.equal(resolveRebalanceMode("WITHDRAW"), "withdraw");
  assert.equal(resolveRebalanceMode("lain"), "inplace");
  const parts = splitBinRange(101, 250, 70);
  assert.deepEqual(
    parts.map((p) => [p.fromBinId, p.toBinId]),
    [
      [101, 170],
      [171, 240],
      [241, 250],
    ]
  );
});

test("parameter BidAsk/Spot tidak menyetor lebih dari jumlah yang ditarik", () => {
  const amount = new BN("2500000000");
  const cases = [
    { token: "y", from: 930, to: 1000, strategy: StrategyType.BidAsk, side: "y" },
    { token: "y", from: 930, to: 1000, strategy: StrategyType.Spot, side: "y" },
    { token: "x", from: 1001, to: 1060, strategy: StrategyType.BidAsk, side: "x" },
    { token: "x", from: 1001, to: 1030, strategy: StrategyType.Spot, side: "x" },
  ];
  for (const item of cases) {
    const deposit = buildOneSidedDeposit({
      amountRaw: amount,
      fromBinId: item.from,
      toBinId: item.to,
      activeBinId: 1000,
      binStep: 80,
      strategyType: item.strategy,
      token: item.token,
      buildLiquidityStrategyParameters,
      getLiquidityStrategyParameterBuilder,
    });
    assert.ok(deposit, `deposit ${item.token} ${item.strategy}`);
    const bins = toAmountIntoBins(
      new BN(1000),
      deposit.minDeltaId,
      deposit.maxDeltaId,
      deposit.deltaX,
      deposit.deltaY,
      deposit.x0,
      deposit.y0,
      new BN(80),
      false
    );
    const sumX = bins.reduce((acc, bin) => acc.add(bin.amountX), new BN(0));
    const sumY = bins.reduce((acc, bin) => acc.add(bin.amountY), new BN(0));
    const used = item.side === "x" ? sumX : sumY;
    const other = item.side === "x" ? sumY : sumX;
    assert.equal(other.toString(), "0");
    assert.ok(used.gtn(0));
    assert.ok(used.lte(amount), `${used.toString()} <= ${amount.toString()}`);
  }

  assert.equal(
    buildOneSidedDeposit({
      amountRaw: amount,
      fromBinId: 1001,
      toBinId: 1020,
      activeBinId: 1000,
      binStep: 80,
      strategyType: StrategyType.BidAsk,
      token: "y",
      buildLiquidityStrategyParameters,
      getLiquidityStrategyParameterBuilder,
    }),
    null
  );
});

function rebalanceIx(shrinkByte) {
  const data = Buffer.alloc(80, 0);
  REBALANCE_DISC.copy(data, 0);
  data[48] = shrinkByte;
  return new TransactionInstruction({ keys: [], programId: PublicKey.default, data });
}

test("tryInPlaceRebalance membangun tx rebalance, NoShrinkBoth, tanpa tarik saldo wallet", async () => {
  const seen = [];
  let sent = 0;
  const ix = rebalanceIx(0);
  const pool = {
    simulateRebalancePosition: async (position, _data, claimFee, claimReward, deposits, withdraws) => {
      seen.push({ claimFee, claimReward, deposits, withdraws });
      return { simulationResult: { actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(0) } };
    },
    rebalancePosition: async (_sim, slipBins, _payer, amountSlippage) => {
      seen.push({ slipBins: slipBins.toString(), amountSlippage });
      return { initBinArrayInstructions: [], rebalancePositionInstruction: [ix] };
    },
  };
  const result = await tryInPlaceRebalance({
    pool,
    positionPubKey: Keypair.generate().publicKey,
    positionData: {
      positionBinData: [
        { binId: 101, positionXAmount: "400000", positionYAmount: "0" },
        { binId: 120, positionXAmount: "600000", positionYAmount: "0" },
      ],
    },
    wallet: { publicKey: Keypair.generate().publicKey },
    connection: {},
    feePlan: { mode: "none" },
    sendAndConfirmFn: async ({ tx }) => {
      sent += 1;
      assert.equal(tx.instructions[0].data[48], 3);
      return { signature: "sig-inplace" };
    },
    fromBinId: 101,
    toBinId: 140,
    activeBinId: 100,
    binStep: 100,
    token: "x",
    strategyType: StrategyType.BidAsk,
    builders: { buildLiquidityStrategyParameters, getLiquidityStrategyParameterBuilder },
    slippagePct: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.depositedRaw.toString(), "1000000");
  assert.deepEqual(result.signatures, ["sig-inplace"]);
  assert.equal(sent, 1);
  assert.equal(seen[0].claimFee, false);
  assert.equal(seen[0].claimReward, false);
  assert.equal(seen[0].withdraws[0].bps.toString(), "10000");
  assert.equal(seen[0].withdraws[0].minBinId.toString(), "101");
  assert.equal(seen[0].withdraws[0].maxBinId.toString(), "140");
  assert.equal(seen[0].deposits[0].minDeltaId.toString(), "1");
  assert.ok(seen[0].deposits[0].deltaX.gtn(0));
  assert.equal(seen[1].amountSlippage, 0);

  let sentTopup = 0;
  const blocked = await tryInPlaceRebalance({
    pool: {
      simulateRebalancePosition: async () => ({
        simulationResult: { actualAmountXDeposited: new BN(1), actualAmountYDeposited: new BN(0) },
      }),
      rebalancePosition: async () => {
        sentTopup += 1;
        return { rebalancePositionInstruction: [rebalanceIx(0)] };
      },
    },
    positionPubKey: Keypair.generate().publicKey,
    positionData: { positionBinData: [{ binId: 101, positionXAmount: "1000000000", positionYAmount: "0" }] },
    wallet: { publicKey: Keypair.generate().publicKey },
    sendAndConfirmFn: async () => {
      sentTopup += 1;
      return { signature: "nope" };
    },
    fromBinId: 101,
    toBinId: 110,
    activeBinId: 100,
    binStep: 100,
    token: "x",
    strategyType: StrategyType.BidAsk,
    builders: { buildLiquidityStrategyParameters, getLiquidityStrategyParameterBuilder },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "wallet_topup");
  assert.equal(blocked.partial, false);
  assert.equal(sentTopup, 0);
});

test("handler bidask: token di tempat tidak memanggil saldo wallet, SOL withdraw hanya jumlah posisi", async () => {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  const pool = Keypair.generate().publicKey.toBase58();
  const position = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  trackPosition(position, pool, "TEST-SOL", mint, null, "bidask:double", false);
  setEntryPoolPrice(position, 1);

  let balanceReads = 0;
  let removeCalls = 0;
  const ix = rebalanceIx(0);
  const wallet = Keypair.generate();
  const tokenPos = {
    position,
    pool,
    pair: "TEST-SOL",
    baseMint: mint,
    mode: "bidask:double",
    activeBin: 100,
    lowerBin: 80,
    upperBin: 140,
  };
  const res = await handleBidaskDoubleRebalance(tokenPos, {
    dryRun: false,
    skipLiveGuard: true,
    cfg: { enabled: true, solEnabled: true, stepPct: 10, cooldownSec: 0, retry: 1 },
    priceChangePct: -10,
    rebalanceMode: "inplace",
    now: () => 5_000,
    tracked: getTrackedPosition(position),
    poolTracked: [],
    entryInProgress: false,
    poolClosing: false,
    dcaConfirmPending: false,
    getPoolInfo: async () => ({
      pool: {
        lbPair: { binStep: 100 },
        getActiveBin: async () => ({ binId: 100 }),
        getPosition: async () => ({
          positionData: {
            lowerBinId: 80,
            upperBinId: 140,
            positionBinData: [
              { binId: 101, positionXAmount: "250000", positionYAmount: "0" },
              { binId: 110, positionXAmount: "750000", positionYAmount: "0" },
            ],
          },
        }),
        simulateRebalancePosition: async () => ({
          simulationResult: { actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(0) },
        }),
        rebalancePosition: async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: [ix] }),
        removeLiquidity: async () => {
          removeCalls += 1;
          return { id: "should-not" };
        },
      },
      baseIsX: true,
      unsupported: false,
      pairName: "TEST-SOL",
    }),
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
    sendAndConfirmRobust: async ({ tx }) => {
      assert.equal(tx.instructions[0].data[48], 3);
      return { signature: "sig-token" };
    },
    sleep: async () => {},
    notifyBidaskDoubleRebalance: () => {},
  });
  assert.equal(res.success, true);
  assert.equal(res.stepLevel, 10);
  assert.equal(removeCalls, 0);
  assert.equal(balanceReads, 0);
  assert.equal(getTrackedPosition(position).lastBidaskDoubleRebalancePct, 10);
  assert.equal(getTrackedPosition(position).lastBidaskDoubleRebalanceBin, 100);

  const adds = [];
  const solRes = await handleBidaskDoubleRebalance(
    { ...tokenPos, activeBin: 140 },
    {
      dryRun: false,
      skipLiveGuard: true,
      cfg: { enabled: true, solEnabled: true, stepPct: 10, cooldownSec: 0, retry: 1 },
      priceChangePct: 2,
      rebalanceMode: "withdraw",
      now: () => 90_000,
      tracked: getTrackedPosition(position),
      poolTracked: [],
      entryInProgress: false,
      poolClosing: false,
      dcaConfirmPending: false,
      getPoolInfo: async () => ({
        pool: {
          lbPair: { binStep: 100 },
          getActiveBin: async () => ({ binId: 140 }),
          getPosition: async () => ({
            positionData: {
              lowerBinId: 80,
              upperBinId: 140,
              positionBinData: [
                { binId: 80, positionXAmount: "0", positionYAmount: "400000000" },
                { binId: 139, positionXAmount: "0", positionYAmount: "200000000" },
              ],
            },
          }),
          removeLiquidity: async (params) => {
            assert.equal(params.fromBinId, 80);
            assert.equal(params.toBinId, 140);
            assert.equal(params.bps.toString(), "10000");
            return { id: "rm" };
          },
          addLiquidityByStrategy: async (params) => {
            adds.push(params);
            return { id: "add" };
          },
        },
        baseIsX: true,
        unsupported: false,
        pairName: "TEST-SOL",
      }),
      getDlmmSdk: async () => ({ StrategyType }),
      getConnection: () => ({ getBalance: async () => 5_000_000_000 }),
      getWallet: () => wallet,
      buildFeePlan: () => ({ mode: "none" }),
      checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 1 }),
      sendAndConfirmRobust: async () => ({ signature: "sig-sol" }),
      sleep: async () => {},
      notifyBidaskDoubleSolRebalance: () => {},
    }
  );
  assert.equal(solRes.success, true);
  assert.equal(solRes.rebalanceType, "sol_bidask");
  assert.equal(solRes.stepLevel, 0);
  assert.equal(solRes.amountSolLamports, "600000000");
  assert.equal(adds.length, 1);
  assert.equal(adds[0].strategy.strategyType, StrategyType.BidAsk);
  assert.equal(adds[0].totalYAmount.toString(), "600000000");
  assert.equal(adds[0].totalXAmount.toString(), "0");
  assert.equal(getTrackedPosition(position).lastBidaskDoubleRebalancePct, 0);
  assert.equal(getTrackedPosition(position).lastBidaskDoubleRebalanceBin, null);
});

const SHAPE_BUILDERS = { buildLiquidityStrategyParameters, getLiquidityStrategyParameterBuilder };
const PER_BIN = "1000000000";

function sideRange(token, active, count) {
  if (token === "x") return { from: active + 1, to: active + count };
  return { from: active - count + 1, to: active };
}

function positionBins(from, to, token, perBin) {
  const rows = [];
  const raw = String(perBin);
  for (let id = from; id <= to; id++) {
    rows.push({
      binId: id,
      positionXAmount: token === "x" ? raw : "0",
      positionYAmount: token === "y" ? raw : "0",
    });
  }
  return rows;
}

function tokenAmount(bin, token) {
  return token === "y" ? bin.amountY : bin.amountX;
}

function rowsFromDeposits(deposits, active, binStep, token) {
  const rows = [];
  for (const item of deposits) {
    const deposit = item.deposit || item;
    const bins = toAmountIntoBins(
      new BN(active),
      deposit.minDeltaId,
      deposit.maxDeltaId,
      deposit.deltaX,
      deposit.deltaY,
      deposit.x0,
      deposit.y0,
      new BN(binStep),
      !!deposit.favorXInActiveBin
    );
    for (const bin of bins) rows.push({ binId: bin.binId.toNumber(), amount: tokenAmount(bin, token) });
  }
  rows.sort((a, b) => a.binId - b.binId);
  return rows;
}

function nearContinuous(prev, cur) {
  return cur.muln(10).gte(prev.muln(9)) && cur.muln(10).lte(prev.muln(11));
}

// Simulasi jujur: selisih target slice vs isi posisi, sama seperti SDK
// (yang masuk wallet vs yang diambil dari wallet).
function honestShapePool(token, active, binStep, seen) {
  return {
    simulateRebalancePosition: async (_position, data, _claimFee, _claimReward, deposits, withdraws) => {
      const deposit = deposits[0];
      const from = withdraws[0].minBinId.toNumber();
      const to = withdraws[0].maxBinId.toNumber();
      seen.push({ deposit, from, to });
      const bins = toAmountIntoBins(
        new BN(active),
        deposit.minDeltaId,
        deposit.maxDeltaId,
        deposit.deltaX,
        deposit.deltaY,
        deposit.x0,
        deposit.y0,
        new BN(binStep),
        !!deposit.favorXInActiveBin
      );
      let target = new BN(0);
      for (const bin of bins) target = target.add(tokenAmount(bin, token));
      const withdrawn = sumPositionSideRaw(data, from, to, token) || new BN(0);
      const topup = target.gt(withdrawn) ? target.sub(withdrawn) : new BN(0);
      const back = withdrawn.gt(target) ? withdrawn.sub(target) : new BN(0);
      const zero = new BN(0);
      return {
        simulationResult: {
          actualAmountXDeposited: token === "x" ? topup : zero,
          actualAmountYDeposited: token === "y" ? topup : zero,
          actualAmountXWithdrawn: token === "x" ? back : zero,
          actualAmountYWithdrawn: token === "y" ? back : zero,
        },
      };
    },
    rebalancePosition: async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: [rebalanceIx(0)] }),
  };
}

test("rentang <=70 bin tetap satu BidAsk yang sama seperti setor langsung", async () => {
  for (const token of ["x", "y"]) {
    for (const count of [40, 70]) {
      const active = token === "x" ? 1000 : -20;
      const { from, to } = sideRange(token, active, count);
      const total = new BN(PER_BIN).muln(count);
      const direct = buildOneSidedDeposit({
        amountRaw: total,
        fromBinId: from,
        toBinId: to,
        activeBinId: active,
        binStep: 100,
        strategyType: StrategyType.BidAsk,
        token,
        ...SHAPE_BUILDERS,
      });
      const seen = [];
      let sent = 0;
      const result = await tryInPlaceRebalance({
        pool: honestShapePool(token, active, 100, seen),
        positionPubKey: Keypair.generate().publicKey,
        positionData: { positionBinData: positionBins(from, to, token, PER_BIN) },
        wallet: { publicKey: Keypair.generate().publicKey },
        sendAndConfirmFn: async () => {
          sent += 1;
          return { signature: "sig-short" };
        },
        fromBinId: from,
        toBinId: to,
        activeBinId: active,
        binStep: 100,
        token,
        strategyType: StrategyType.BidAsk,
        builders: SHAPE_BUILDERS,
      });
      assert.equal(result.ok, true, `${token} ${count}`);
      assert.equal(sent, 1);
      assert.equal(seen.length, 1);
      assert.equal(result.depositedRaw.toString(), total.toString());
      const deposit = seen[0].deposit;
      for (const key of ["minDeltaId", "maxDeltaId", "x0", "y0", "deltaX", "deltaY"]) {
        assert.equal(deposit[key].toString(), direct[key].toString(), `${token} ${count} ${key}`);
      }
      assert.equal(deposit.favorXInActiveBin, false);
    }
  }
});

test("BidAsk di tempat >70 bin satu kurva: puncak di tepi jauh, tanpa patahan batas 70", async () => {
  const binStep = 100;
  for (const count of [191, 316]) {
    for (const token of ["x", "y"]) {
      const active = token === "x" ? -735 : -400;
      const { from, to } = sideRange(token, active, count);
      const total = new BN(PER_BIN).muln(count);
      const label = `${token} ${count}`;
      const planned = globalShapeSlices({
        amountRaw: total,
        fromBinId: from,
        toBinId: to,
        activeBinId: active,
        binStep,
        strategyType: StrategyType.BidAsk,
        token,
        ...SHAPE_BUILDERS,
      });
      assert.equal(planned.length, Math.ceil(count / 70), label);
      const curveX0 = planned[0].deposit.x0.toString();
      const curveDx = planned[0].deposit.deltaX.toString();
      const curveY0 = planned[0].deposit.y0.toString();
      const curveDy = planned[0].deposit.deltaY.toString();
      for (const slice of planned) {
        assert.equal(slice.deposit.x0.toString(), curveX0, label);
        assert.equal(slice.deposit.deltaX.toString(), curveDx, label);
        assert.equal(slice.deposit.y0.toString(), curveY0, label);
        assert.equal(slice.deposit.deltaY.toString(), curveDy, label);
      }

      const seen = [];
      let sent = 0;
      const result = await tryInPlaceRebalance({
        pool: honestShapePool(token, active, binStep, seen),
        positionPubKey: Keypair.generate().publicKey,
        positionData: { positionBinData: positionBins(from, to, token, PER_BIN) },
        wallet: { publicKey: Keypair.generate().publicKey },
        sendAndConfirmFn: async ({ tx }) => {
          sent += 1;
          assert.equal(tx.instructions[0].data[48], 3);
          return { signature: `sig-${label}-${sent}` };
        },
        fromBinId: from,
        toBinId: to,
        activeBinId: active,
        binStep,
        token,
        strategyType: StrategyType.BidAsk,
        builders: SHAPE_BUILDERS,
      });
      assert.equal(result.ok, true, label);
      assert.equal(result.partial, false, label);
      assert.equal(sent, planned.length, label);
      assert.equal(result.depositedRaw.toString(), total.toString(), label);
      assert.equal(seen.length, planned.length, label);

      const covered = seen.slice().sort((a, b) => a.from - b.from);
      assert.equal(covered[0].from, from, label);
      assert.equal(covered[covered.length - 1].to, to, label);
      for (let i = 1; i < covered.length; i++) assert.equal(covered[i].from, covered[i - 1].to + 1, label);

      const rows = rowsFromDeposits(seen, active, binStep, token);
      assert.equal(rows.length, count, label);
      for (let i = 0; i < rows.length; i++) assert.equal(rows[i].binId, from + i, label);

      const global = buildOneSidedDeposit({
        amountRaw: total,
        fromBinId: from,
        toBinId: to,
        activeBinId: active,
        binStep,
        strategyType: StrategyType.BidAsk,
        token,
        ...SHAPE_BUILDERS,
      });
      const globalBins = toAmountIntoBins(
        new BN(active),
        global.minDeltaId,
        global.maxDeltaId,
        global.deltaX,
        global.deltaY,
        global.x0,
        global.y0,
        new BN(binStep),
        false
      );
      let sum = new BN(0);
      for (let i = 0; i < rows.length; i++) {
        assert.equal(
          rows[i].amount.toString(),
          tokenAmount(globalBins[i], token).toString(),
          `${label} bin ${rows[i].binId}`
        );
        sum = sum.add(rows[i].amount);
      }
      assert.ok(sum.lte(total), label);
      assert.ok(total.sub(sum).muln(10000).lt(total), `${label} dust ${total.sub(sum).toString()}`);

      // Bobot BidAsk (sebelum harga) naik ke tepi jauh. Jumlah token Y memang
      // begitu. Jumlah token X masih dikali harga, jadi yang dijaga adalah
      // bobotnya plus tidak ada jurang di batas slice.
      if (token === "y") {
        for (let i = 1; i < rows.length; i++) {
          assert.ok(rows[i].amount.lte(rows[i - 1].amount), `${label} turun di ${rows[i].binId}`);
        }
        assert.ok(rows[0].amount.gt(rows[rows.length - 1].amount), label);
      } else {
        let prev = null;
        for (const row of rows) {
          const weight = seen[0].deposit.x0.add(seen[0].deposit.deltaX.muln(row.binId - active));
          if (prev) assert.ok(weight.gt(prev), `${label} bobot di ${row.binId}`);
          prev = weight;
        }
      }
      for (const boundary of [70, 140, 210, 280]) {
        if (boundary >= rows.length) continue;
        assert.ok(
          nearContinuous(rows[boundary - 1].amount, rows[boundary].amount),
          `${label} patah di bin ${rows[boundary].binId}`
        );
      }

      const broken = [];
      for (let cur = from; cur <= to; cur += 70) {
        const end = Math.min(cur + 70 - 1, to);
        const local = buildOneSidedDeposit({
          amountRaw: new BN(PER_BIN).muln(end - cur + 1),
          fromBinId: cur,
          toBinId: end,
          activeBinId: active,
          binStep,
          strategyType: StrategyType.BidAsk,
          token,
          ...SHAPE_BUILDERS,
        });
        for (const bin of toAmountIntoBins(
          new BN(active),
          local.minDeltaId,
          local.maxDeltaId,
          local.deltaX,
          local.deltaY,
          local.x0,
          local.y0,
          new BN(binStep),
          false
        )) {
          broken.push(tokenAmount(bin, token));
        }
      }
      let brokenCliff = false;
      for (const boundary of [70, 140, 210, 280]) {
        if (boundary >= broken.length) continue;
        if (!nearContinuous(broken[boundary - 1], broken[boundary])) brokenCliff = true;
      }
      assert.equal(brokenCliff, true, `${label} kurva per slice lama harusnya patah`);
    }
  }
});

test("rebalance panjang tidak mengirim tx bila slice butuh token di luar yang baru keluar", async () => {
  let sent = 0;
  let sims = 0;
  const blocked = await tryInPlaceRebalance({
    pool: {
      simulateRebalancePosition: async () => {
        sims += 1;
        if (sims < 3) {
          return {
            simulationResult: {
              actualAmountXDeposited: new BN(0),
              actualAmountYDeposited: new BN(0),
              actualAmountXWithdrawn: new BN(0),
              actualAmountYWithdrawn: new BN(0),
            },
          };
        }
        return {
          simulationResult: {
            actualAmountXDeposited: new BN(5),
            actualAmountYDeposited: new BN(0),
            actualAmountXWithdrawn: new BN(0),
            actualAmountYWithdrawn: new BN(0),
          },
        };
      },
      rebalancePosition: async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: [rebalanceIx(0)] }),
    },
    positionPubKey: Keypair.generate().publicKey,
    positionData: { positionBinData: positionBins(1, 191, "x", PER_BIN) },
    wallet: { publicKey: Keypair.generate().publicKey },
    sendAndConfirmFn: async () => {
      sent += 1;
      return { signature: "should-not-send" };
    },
    fromBinId: 1,
    toBinId: 191,
    activeBinId: 0,
    binStep: 100,
    token: "x",
    strategyType: StrategyType.BidAsk,
    builders: SHAPE_BUILDERS,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "wallet_topup");
  assert.equal(blocked.partial, false);
  assert.equal(blocked.signatures.length, 0);
  assert.equal(sent, 0);
  assert.equal(sims, 3);

  let sentOther = 0;
  const otherSide = await tryInPlaceRebalance({
    pool: {
      simulateRebalancePosition: async () => ({
        simulationResult: { actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(1) },
      }),
      rebalancePosition: async () => ({ rebalancePositionInstruction: [rebalanceIx(0)] }),
    },
    positionPubKey: Keypair.generate().publicKey,
    positionData: { positionBinData: positionBins(1, 80, "x", PER_BIN) },
    wallet: { publicKey: Keypair.generate().publicKey },
    sendAndConfirmFn: async () => {
      sentOther += 1;
      return { signature: "nope" };
    },
    fromBinId: 1,
    toBinId: 80,
    activeBinId: 0,
    binStep: 100,
    token: "x",
    strategyType: StrategyType.BidAsk,
    builders: SHAPE_BUILDERS,
  });
  assert.equal(otherSide.ok, false);
  assert.equal(otherSide.reason, "wallet_topup");
  assert.equal(otherSide.partial, false);
  assert.equal(sentOther, 0);
});
