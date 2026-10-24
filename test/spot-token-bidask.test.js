import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-spot-bidask-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const { trackPosition, recordTrackedRange, getSpotTokenBidaskState, updateSpotTokenBidaskState } =
  await import("../src/state/positions.js");
const { getEntryInProgressMints, getEntryInProgressPools, resetRuntimeState } = await import("../src/entry/runtime.js");
const {
  calcSpotTokenBinMetrics,
  evaluateSpotTokenBidaskTrigger,
  chunkBidAskRanges,
  chunkSolBidAskRanges,
  chunkSpotRanges,
  patchRebalanceNoShrink,
  extractTokenSideLiquidity,
  extractSolSideLiquidity,
  handleSpotTokenBidask,
} = await import("../src/exit/spot-token-bidask.js");

const POOL = Keypair.generate().publicKey.toBase58();
const POS = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const WALLET_KP = Keypair.generate();

function resetAll() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  resetRuntimeState();
}

test("calcSpotTokenBinMetrics: menghitung persentase bin di atas activeBin, bin SOL, dan kelipatan 15%", () => {
  // Range 200 bin (100 .. 300)
  const m0 = calcSpotTokenBinMetrics({ activeBin: 300, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m0.inRange, true);
  assert.equal(m0.tokenBins, 0);
  assert.equal(m0.tokenBinPct, 0);
  assert.equal(m0.stepLevel, 0);
  assert.equal(m0.solFromBinId, 100);
  assert.equal(m0.solToBinId, 300);
  assert.equal(m0.solBinPct, 100);

  // 29 bin di atas activeBin = 14.5% -> belum mencapai 15%
  const m14 = calcSpotTokenBinMetrics({ activeBin: 271, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m14.tokenBins, 29);
  assert.equal(m14.tokenBinPct, 14.5);
  assert.equal(m14.stepLevel, 0);

  // 30 bin di atas activeBin = 15% -> step 15%, range token 271..300, range SOL 100..270
  const m15 = calcSpotTokenBinMetrics({ activeBin: 270, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m15.tokenBins, 30);
  assert.equal(m15.tokenBinPct, 15);
  assert.equal(m15.stepLevel, 15);
  assert.equal(m15.fromBinId, 271);
  assert.equal(m15.toBinId, 300);
  assert.equal(m15.solFromBinId, 100);
  assert.equal(m15.solToBinId, 270);

  // 60 bin = 30%, 90 bin = 45%, 120 bin = 60%, 150 bin = 75%, 180 bin = 90%
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 240, lowerBin: 100, upperBin: 300, stepPct: 15 }).stepLevel, 30);
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 210, lowerBin: 100, upperBin: 300, stepPct: 15 }).stepLevel, 45);
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 180, lowerBin: 100, upperBin: 300, stepPct: 15 }).stepLevel, 60);
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 150, lowerBin: 100, upperBin: 300, stepPct: 15 }).stepLevel, 75);
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 120, lowerBin: 100, upperBin: 300, stepPct: 15 }).stepLevel, 90);

  // Out of range kiri/kanan -> inRange false
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 99, lowerBin: 100, upperBin: 300, stepPct: 15 }).inRange, false);
  assert.equal(calcSpotTokenBinMetrics({ activeBin: 301, lowerBin: 100, upperBin: 300, stepPct: 15 }).inRange, false);
});

test("evaluateSpotTokenBidaskTrigger: step 15% turun -> BidAsk, naik +15% sejak rebalance -> rebalance_sol_spot", () => {
  const cfg = { enabled: true, stepPct: 15, cooldownSec: 60, retry: 3 };
  const basePos = { position: POS, pool: POOL, mode: "spot", lowerBin: 100, upperBin: 300 };

  // 1. Belum mencapai 15% (activeBin 275 -> 12.5%)
  let res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 275 },
    tracked: { lastSpotTokenBidaskPct: 0, lastSpotTokenBidaskAt: null },
    cfg,
    spotMinBins: 200,
    now: 100_000,
  });
  assert.equal(res.action, "none");
  assert.equal(res.reason, "below_next_step");

  // 2. Mencapai 15% (activeBin 270 -> 15%) -> rebalance token ke BidAsk!
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 270 },
    tracked: { lastSpotTokenBidaskPct: 0, lastSpotTokenBidaskAt: null },
    cfg,
    spotMinBins: 200,
    now: 100_000,
  });
  assert.equal(res.action, "rebalance");
  assert.equal(res.stepLevel, 15);

  // 3. Turun ke 22% (masih di step 15%, lastPct sudah 15%) -> tahan
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 256 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 100_000 },
    cfg,
    spotMinBins: 200,
    now: 170_000,
  });
  assert.equal(res.action, "none");

  // 4. Turun ke 30% tapi masih dalam cooldown (<60s) -> cooldown
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 240 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 100_000 },
    cfg,
    spotMinBins: 200,
    now: 130_000,
  });
  assert.equal(res.action, "cooldown");

  // 5. Setelah lewat cooldown (>=60s) pada 30% -> rebalance token ke BidAsk!
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 240 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 100_000 },
    cfg,
    spotMinBins: 200,
    now: 161_000,
  });
  assert.equal(res.action, "rebalance");
  assert.equal(res.stepLevel, 30);

  // 6. Harga baru naik sedikit (+5%, dari 15% ke 10% di activeBin 280): belum +15%, JANGAN reset & JANGAN rebalance dulu
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 280 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 100_000, lastSpotTokenBidaskBin: 270 },
    cfg,
    spotMinBins: 200,
    now: 250_000,
  });
  assert.equal(res.action, "none");
  assert.equal(res.reason, "below_next_step");

  // 7. Harga naik kembali +15% dari 45% ke 15% (activeBin 268 -> 16%, stepLevel 15 <= 45-15) -> rebalance_sol_spot!
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 268 },
    tracked: { lastSpotTokenBidaskPct: 45, lastSpotTokenBidaskAt: 200_000 },
    cfg,
    spotMinBins: 200,
    now: 270_000,
  });
  assert.equal(res.action, "rebalance_sol_spot");
  assert.equal(res.stepLevel, 15);
  assert.equal(res.reason, "recover_45_to_15pct");

  // 8. Cooldown juga berlaku untuk rebalance_sol_spot
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 268 },
    tracked: { lastSpotTokenBidaskPct: 45, lastSpotTokenBidaskAt: 200_000 },
    cfg,
    spotMinBins: 200,
    now: 220_000,
  });
  assert.equal(res.action, "cooldown");

  // 9. Harga naik +15% penuh dari step 15% kembali ke upperBin (activeBin 300 -> stepLevel 0) -> rebalance_sol_spot!
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 300 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 200_000, lastSpotTokenBidaskBin: 270 },
    cfg,
    spotMinBins: 200,
    now: 270_000,
  });
  assert.equal(res.action, "rebalance_sol_spot");
  assert.equal(res.stepLevel, 0);
  assert.equal(res.reason, "recover_15_to_0pct");

  // 10. Jika saat rebalance 15% activeBin ada di 260 (20% bin token), naik +30 bin (+15%) ke 290 memicu rebalance_sol_spot
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 290 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 200_000, lastSpotTokenBidaskBin: 260 },
    cfg,
    spotMinBins: 200,
    now: 270_000,
  });
  assert.equal(res.action, "rebalance_sol_spot");
  assert.equal(res.stepLevel, 0);
});

test("chunkBidAskRanges, chunkSolBidAskRanges & chunkSpotRanges: distribusi BidAsk linear vs Spot merata", () => {
  const total = new BN("1000000000"); // 1,000,000,000 raw units (1 SOL)

  // 30 bin (<=70) -> 1 chunk
  const single = chunkBidAskRanges(271, 300, total, 70);
  assert.equal(single.length, 1);
  assert.equal(single[0].minBinId, 271);
  assert.equal(single[0].maxBinId, 300);
  assert.equal(single[0].amountRaw.toString(), total.toString());

  // 150 bin (151..300) -> 3 chunk (70 + 70 + 10 bin) BidAsk
  const multi = chunkBidAskRanges(151, 300, total, 70);
  assert.equal(multi.length, 3);
  assert.deepEqual(
    multi.map((c) => [c.minBinId, c.maxBinId]),
    [
      [151, 220],
      [221, 290],
      [291, 300],
    ]
  );

  const sum = multi.reduce((acc, c) => acc.add(c.amountRaw), new BN(0));
  assert.equal(sum.toString(), total.toString());

  const avg0 = Number(multi[0].amountRaw.toString()) / 70;
  const avg1 = Number(multi[1].amountRaw.toString()) / 70;
  const avg2 = Number(multi[2].amountRaw.toString()) / 10;
  assert.ok(avg1 > avg0, "chunk tengah harus punya rata-rata per bin > chunk bawah");
  assert.ok(avg2 > avg1, "chunk atas harus punya rata-rata per bin > chunk tengah");

  // chunkSpotRanges: 200 bin (101..300) -> 3 chunk (70 + 70 + 60 bin) dengan porsi per bin SAMA RATA (Spot)
  const spotChunks = chunkSpotRanges(101, 300, total, 70);
  assert.equal(spotChunks.length, 3);
  assert.deepEqual(
    spotChunks.map((c) => [c.minBinId, c.maxBinId]),
    [
      [101, 170],
      [171, 240],
      [241, 300],
    ]
  );
  const spotSum = spotChunks.reduce((acc, c) => acc.add(c.amountRaw), new BN(0));
  assert.equal(spotSum.toString(), total.toString());
  assert.equal(spotChunks[0].amountRaw.toString(), "350000000"); // 70/200 * 1e9
  assert.equal(spotChunks[1].amountRaw.toString(), "350000000"); // 70/200 * 1e9
  assert.equal(spotChunks[2].amountRaw.toString(), "300000000"); // 60/200 * 1e9
});

test("patchRebalanceNoShrink: memaksa shrink_mode = 3 (NoShrinkBoth) pada instruksi rebalance_liquidity", () => {
  const buf = Buffer.alloc(64, 0);
  Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]).copy(buf, 0);
  buf[48] = 2; // NoShrinkRight bawaan SDK
  const fakeTx = { instructions: [{ data: buf }] };
  patchRebalanceNoShrink([fakeTx]);
  assert.equal(buf[48], 3);
});

test("extractTokenSideLiquidity & extractSolSideLiquidity: mendeteksi likuiditas token & SOL secara presisi", () => {
  const posData = {
    positionBinData: [
      { binId: 100, positionXAmount: "0", positionYAmount: "200000000" },
      { binId: 269, positionXAmount: "0", positionYAmount: "300000000" },
      // activeBin 270 punya campuran base token (X) dan SOL (Y)
      { binId: 270, positionXAmount: "50000", positionYAmount: "100000000" },
      { binId: 271, positionXAmount: "120000", positionYAmount: "0" },
      { binId: 272, positionXAmount: "380000", positionYAmount: "0" },
    ],
  };
  const checkX = extractTokenSideLiquidity(posData, 271, 300, true);
  assert.equal(checkX.hasBinData, true);
  assert.equal(checkX.hasTokenLiquidity, true);
  assert.equal(checkX.tokenBinsCount, 2);
  assert.equal(checkX.totalTokenRaw.toString(), "500000");

  // Karena activeBin 270 punya base token X > 0, extractSolSideLiquidity mengecualikan bin 270 (toBinId = 269)
  const solMixed = extractSolSideLiquidity(posData, 100, 270, true);
  assert.equal(solMixed.hasBinData, true);
  assert.equal(solMixed.hasSolLiquidity, true);
  assert.equal(solMixed.activeBinHasBase, true);
  assert.equal(solMixed.fromBinId, 100);
  assert.equal(solMixed.toBinId, 269);
  assert.equal(solMixed.solBinsCount, 2);
  assert.equal(solMixed.totalSolLamports.toString(), "500000000");

  // Jika activeBin 270 murni SOL (positionXAmount = 0), bin 270 ikut dimasukkan (toBinId = 270)
  const posDataPureSolActive = {
    positionBinData: [
      { binId: 100, positionXAmount: "0", positionYAmount: "200000000" },
      { binId: 270, positionXAmount: "0", positionYAmount: "350000000" },
    ],
  };
  const solPure = extractSolSideLiquidity(posDataPureSolActive, 100, 270, true);
  assert.equal(solPure.activeBinHasBase, false);
  assert.equal(solPure.fromBinId, 100);
  assert.equal(solPure.toBinId, 270);
  assert.equal(solPure.totalSolLamports.toString(), "550000000");
});

test("handleSpotTokenBidask: sisi Token rebalance ke BidAsk mulus (>70 bin pakai addLiquidityByStrategyChunkable), sisi SOL rebalance ke Spot merata", async () => {
  resetAll();
  trackPosition(POS, POOL, "TEST-SOL", MINT, 0, "spot");
  recordTrackedRange(POS, 100, 300);

  const calls = [];
  let lockSeenDuringRemove = false;
  let lockSeenDuringAdd = false;

  const fakeRebalanceData = Buffer.alloc(64, 0);
  Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]).copy(fakeRebalanceData, 0);
  fakeRebalanceData[48] = 2;

  const mockPool = {
    getActiveBin: async () => ({ binId: 210 }), // 90 bin token (211..300, >70 bin) = 45%
    getPosition: async () => ({
      publicKey: Keypair.generate().publicKey,
      positionData: {
        lowerBinId: 100,
        upperBinId: 300,
        positionBinData: [
          { binId: 211, positionXAmount: "500000000", positionYAmount: "0" },
          { binId: 300, positionXAmount: "500000000", positionYAmount: "0" },
        ],
      },
    }),
    removeLiquidity: async (params) => {
      lockSeenDuringRemove = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "removeLiquidity", params });
      return [{ id: "tx-remove-1" }, { id: "tx-remove-2" }];
    },
    addLiquidityByStrategyChunkable: async (params) => {
      lockSeenDuringAdd = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "addLiquidityByStrategyChunkable", params });
      return [
        { id: "tx-add-chunk-1", instructions: [{ data: fakeRebalanceData }] },
        { id: "tx-add-chunk-2", instructions: [] },
      ];
    },
  };

  let addAttempt = 0;
  const sentTxs = [];
  const notifications = [];

  // --- TAHAP 1: Harga turun (activeBin 210, 90 bin > 70) -> Rebalance Token ke BidAsk mulus ---
  const res = await handleSpotTokenBidask(
    {
      position: POS,
      pool: POOL,
      pair: "TEST-SOL",
      baseMint: MINT,
      mode: "spot",
      activeBin: 210, // 90/200 = 45%
      lowerBin: 100,
      upperBin: 300,
    },
    {
      dryRun: false,
      cfg: { enabled: true, stepPct: 15, cooldownSec: 60, retry: 3 },
      spotMinBins: 200,
      getPoolInfo: async () => ({
        pool: mockPool,
        baseMint: MINT,
        baseIsX: true,
        unsupported: false,
        pairName: "TEST-SOL",
      }),
      getDlmmSdk: async () => ({ StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 } }),
      getConnection: () => ({}),
      getWallet: () => WALLET_KP,
      getTokenBalance: async () => 1234.5,
      getMintDecimals: async () => 6,
      buildFeePlan: () => ({ mode: "none" }),
      checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 0.002 }),
      sendAndConfirmRobust: async ({ tx }) => {
        if (tx.id === "tx-add-chunk-1") {
          addAttempt++;
          if (addAttempt === 1) {
            throw new Error("simulated transient RPC timeout on addLiquidity");
          }
        }
        sentTxs.push(tx.id);
        return { signature: `sig-${tx.id}-${addAttempt}` };
      },
      sleep: async () => {},
      notifySpotTokenBidask: (payload) => notifications.push(payload),
    }
  );

  assert.equal(res.triggered, true);
  assert.equal(res.success, true);
  assert.equal(res.rebalanceType, "token_bidask");
  assert.equal(res.stepLevel, 45);
  assert.equal(res.fromBinId, 211);
  assert.equal(res.toBinId, 300);

  assert.equal(lockSeenDuringRemove, true, "baseMint & pool wajib dikunci saat removeLiquidity");
  assert.equal(lockSeenDuringAdd, true, "baseMint & pool wajib dikunci saat addLiquidityByStrategyChunkable");
  assert.equal(fakeRebalanceData[48], 3, "shrinkMode wajib di-patch ke 3 (NoShrinkBoth)");
  assert.equal(getEntryInProgressMints().has(MINT), false, "kunci baseMint dilepas setelah selesai");
  assert.equal(getEntryInProgressPools().has(POOL), false, "kunci pool dilepas setelah selesai");

  const st = getSpotTokenBidaskState(POS);
  assert.equal(st.lastPct, 45);
  assert.equal(st.lastBin, 210);
  assert.ok(Number.isFinite(st.lastAt) && st.lastAt > 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].success, true);

  // --- TAHAP 2: Harga naik kembali (210 -> 300) -> Rebalance semua SOL di posisi kembali ke Spot merata ---
  updateSpotTokenBidaskState(POS, 15, Date.now() - 120_000, 270);
  calls.length = 0;
  notifications.length = 0;
  let solLockDuringRemove = false;
  let solLockDuringAdd = false;

  const mockPoolSolRecovery = {
    getActiveBin: async () => ({ binId: 300 }),
    getPosition: async () => ({
      publicKey: Keypair.generate().publicKey,
      positionData: {
        lowerBinId: 100,
        upperBinId: 300,
        positionBinData: [
          { binId: 100, positionXAmount: "0", positionYAmount: "450000000" },
          { binId: 299, positionXAmount: "0", positionYAmount: "150000000" },
          { binId: 300, positionXAmount: "999", positionYAmount: "0" },
        ],
      },
    }),
    removeLiquidity: async (params) => {
      solLockDuringRemove = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "removeLiquidity", params });
      return [{ id: "tx-sol-remove-1" }];
    },
    addLiquidityByStrategy: async (params) => {
      solLockDuringAdd = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "addLiquidityByStrategy", params });
      return { id: `tx-sol-add-${calls.length}` };
    },
  };

  const solRes = await handleSpotTokenBidask(
    {
      position: POS,
      pool: POOL,
      pair: "TEST-SOL",
      baseMint: MINT,
      mode: "spot",
      activeBin: 300,
      lowerBin: 100,
      upperBin: 300,
    },
    {
      dryRun: false,
      cfg: { enabled: true, stepPct: 15, cooldownSec: 60, retry: 3 },
      spotMinBins: 200,
      getPoolInfo: async () => ({
        pool: mockPoolSolRecovery,
        baseMint: MINT,
        baseIsX: true,
        unsupported: false,
        pairName: "TEST-SOL",
      }),
      getDlmmSdk: async () => ({ StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 } }),
      getConnection: () => ({
        getBalance: async () => 1_500_000_000,
      }),
      getWallet: () => WALLET_KP,
      buildFeePlan: () => ({ mode: "none" }),
      checkFeeCap: () => ({ ok: true, totalSol: 0, cap: 0.002 }),
      sendAndConfirmRobust: async ({ tx }) => ({ signature: `sig-${tx.id}` }),
      sleep: async () => {},
      notifySpotSolRebalance: (payload) => notifications.push(payload),
    }
  );

  assert.equal(solRes.triggered, true);
  assert.equal(solRes.success, true);
  assert.equal(solRes.rebalanceType, "sol_spot");
  assert.equal(solRes.lastPct, 15);
  assert.equal(solRes.stepLevel, 0);
  assert.equal(solRes.fromBinId, 100);
  assert.equal(solRes.toBinId, 299);
  assert.equal(solRes.amountSol, 0.6);
  assert.equal(solRes.amountSolLamports, "600000000");

  assert.equal(solLockDuringRemove, true, "kunci sweep aktif saat removeLiquidity SOL");
  assert.equal(solLockDuringAdd, true, "kunci sweep aktif saat addLiquidityByStrategy SOL");
  assert.equal(getEntryInProgressMints().has(MINT), false);
  assert.equal(getEntryInProgressPools().has(POOL), false);

  // Verifikasi addLiquidityByStrategy memakai StrategyType.Spot (0) di-chunk 3x (70 + 70 + 60 = 200 bin) dengan total exact 0.60 SOL (600,000,000 lamports)
  const solAddCalls = calls.filter((c) => c.op === "addLiquidityByStrategy");
  assert.equal(solAddCalls.length, 3);
  assert.deepEqual(
    solAddCalls.map((c) => [
      c.params.strategy.minBinId,
      c.params.strategy.maxBinId,
      c.params.strategy.strategyType,
      c.params.totalXAmount.toString(),
      c.params.totalYAmount.toString(),
    ]),
    [
      [100, 169, 0, "0", "210000000"], // 70/200 * 600,000,000 (Spot = 0)
      [170, 239, 0, "0", "210000000"], // 70/200 * 600,000,000 (Spot = 0)
      [240, 299, 0, "0", "180000000"], // 60/200 * 600,000,000 (Spot = 0)
    ]
  );

  const afterSolSt = getSpotTokenBidaskState(POS);
  assert.equal(afterSolSt.lastPct, 0);
  assert.equal(afterSolSt.lastBin, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].rebalanceType, "sol_spot");
  assert.equal(notifications[0].success, true);
  assert.equal(notifications[0].amountSol, 0.6);
});
