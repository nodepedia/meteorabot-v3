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

const {
  trackPosition,
  recordTrackedRange,
  getSpotTokenBidaskState,
  updateSpotTokenBidaskState,
} = await import("../src/state/positions.js");
const {
  getEntryInProgressMints,
  getEntryInProgressPools,
  resetRuntimeState,
} = await import("../src/entry/runtime.js");
const {
  calcSpotTokenBinMetrics,
  evaluateSpotTokenBidaskTrigger,
  chunkBidAskRanges,
  extractTokenSideLiquidity,
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

test("calcSpotTokenBinMetrics: menghitung persentase bin di atas activeBin dan kelipatan 15%", () => {
  // Range 200 bin (100 .. 300)
  const m0 = calcSpotTokenBinMetrics({ activeBin: 300, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m0.inRange, true);
  assert.equal(m0.tokenBins, 0);
  assert.equal(m0.tokenBinPct, 0);
  assert.equal(m0.stepLevel, 0);

  // 29 bin di atas activeBin = 14.5% -> belum mencapai 15%
  const m14 = calcSpotTokenBinMetrics({ activeBin: 271, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m14.tokenBins, 29);
  assert.equal(m14.tokenBinPct, 14.5);
  assert.equal(m14.stepLevel, 0);

  // 30 bin di atas activeBin = 15% -> step 15%, range 271..300
  const m15 = calcSpotTokenBinMetrics({ activeBin: 270, lowerBin: 100, upperBin: 300, stepPct: 15 });
  assert.equal(m15.tokenBins, 30);
  assert.equal(m15.tokenBinPct, 15);
  assert.equal(m15.stepLevel, 15);
  assert.equal(m15.fromBinId, 271);
  assert.equal(m15.toBinId, 300);

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

test("evaluateSpotTokenBidaskTrigger: step 15%, cooldown, dan reset saat harga naik kembali", () => {
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

  // 2. Mencapai 15% (activeBin 270 -> 15%) -> rebalance!
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

  // 5. Setelah lewat cooldown (>=60s) pada 30% -> rebalance!
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 240 },
    tracked: { lastSpotTokenBidaskPct: 15, lastSpotTokenBidaskAt: 100_000 },
    cfg,
    spotMinBins: 200,
    now: 161_000,
  });
  assert.equal(res.action, "rebalance");
  assert.equal(res.stepLevel, 30);

  // 6. Harga naik kembali dari 45% ke 15% (activeBin 268 -> 16%, stepLevel 15 < lastPct 45) -> reset_down
  res = evaluateSpotTokenBidaskTrigger({
    pos: { ...basePos, activeBin: 268 },
    tracked: { lastSpotTokenBidaskPct: 45, lastSpotTokenBidaskAt: 200_000 },
    cfg,
    spotMinBins: 200,
    now: 250_000,
  });
  assert.equal(res.action, "reset_down");
  assert.equal(res.stepLevel, 15);
});

test("chunkBidAskRanges: 1 chunk bila <=70 bin, multi-chunk berbobot BidAsk bila >70 bin tanpa sisa pembulatan", () => {
  const total = new BN("1000000000"); // 1,000,000,000 raw units

  // 30 bin (<=70) -> 1 chunk
  const single = chunkBidAskRanges(271, 300, total, 70);
  assert.equal(single.length, 1);
  assert.equal(single[0].minBinId, 271);
  assert.equal(single[0].maxBinId, 300);
  assert.equal(single[0].amountRaw.toString(), total.toString());

  // 150 bin (151..300) -> 3 chunk (70 + 70 + 10 bin)
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

  // Jumlah seluruh chunk == total persis
  const sum = multi.reduce((acc, c) => acc.add(c.amountRaw), new BN(0));
  assert.equal(sum.toString(), total.toString());

  // Rata-rata token per bin di chunk 2 harus > chunk 1, dan chunk 3 > chunk 2 (distribusi BidAsk naik ke atas)
  const avg0 = Number(multi[0].amountRaw.toString()) / 70;
  const avg1 = Number(multi[1].amountRaw.toString()) / 70;
  const avg2 = Number(multi[2].amountRaw.toString()) / 10;
  assert.ok(avg1 > avg0, "chunk tengah harus punya rata-rata per bin > chunk bawah");
  assert.ok(avg2 > avg1, "chunk atas harus punya rata-rata per bin > chunk tengah");
});

test("extractTokenSideLiquidity: mendeteksi likuiditas token base di atas activeBin", () => {
  const posData = {
    positionBinData: [
      { binId: 270, positionXAmount: "0", positionYAmount: "500000000" },
      { binId: 271, positionXAmount: "120000", positionYAmount: "0" },
      { binId: 272, positionXAmount: "380000", positionYAmount: "0" },
    ],
  };
  const checkX = extractTokenSideLiquidity(posData, 271, 300, true);
  assert.equal(checkX.hasBinData, true);
  assert.equal(checkX.hasTokenLiquidity, true);
  assert.equal(checkX.tokenBinsCount, 2);
  assert.equal(checkX.totalTokenRaw.toString(), "500000");

  const checkEmpty = extractTokenSideLiquidity(posData, 275, 300, true);
  assert.equal(checkEmpty.hasBinData, true);
  assert.equal(checkEmpty.hasTokenLiquidity, false);
});

test("handleSpotTokenBidask: proteksi wallet sweep (entryInProgressMint + Pool) aktif selama withdraw + re-deposit BidAsk", async () => {
  resetAll();
  trackPosition(POS, POOL, "TEST-SOL", MINT, 0, "spot");
  recordTrackedRange(POS, 100, 300);

  const calls = [];
  let lockSeenDuringRemove = false;
  let lockSeenDuringAdd = false;

  const mockPool = {
    getActiveBin: async () => ({ binId: 270 }),
    getPosition: async () => ({
      publicKey: Keypair.generate().publicKey,
      positionData: {
        lowerBinId: 100,
        upperBinId: 300,
        positionBinData: [
          { binId: 271, positionXAmount: "500000000", positionYAmount: "0" },
          { binId: 300, positionXAmount: "500000000", positionYAmount: "0" },
        ],
      },
    }),
    removeLiquidity: async (params) => {
      lockSeenDuringRemove = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "removeLiquidity", params });
      return [{ id: "tx-remove-1" }];
    },
    addLiquidityByStrategy: async (params) => {
      lockSeenDuringAdd = getEntryInProgressMints().has(MINT) && getEntryInProgressPools().has(POOL);
      calls.push({ op: "addLiquidityByStrategy", params });
      return { id: "tx-add-1" };
    },
  };

  let addAttempt = 0;
  const sentTxs = [];
  const notifications = [];

  const res = await handleSpotTokenBidask(
    {
      position: POS,
      pool: POOL,
      pair: "TEST-SOL",
      baseMint: MINT,
      mode: "spot",
      activeBin: 270, // 30/200 = 15%
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
        if (tx.id === "tx-add-1") {
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
  assert.equal(res.stepLevel, 15);
  assert.equal(res.fromBinId, 271);
  assert.equal(res.toBinId, 300);

  // Pastikan proteksi sweep aktif selama removeLiquidity dan addLiquidityByStrategy!
  assert.equal(lockSeenDuringRemove, true, "baseMint & pool wajib dikunci saat removeLiquidity");
  assert.equal(lockSeenDuringAdd, true, "baseMint & pool wajib dikunci saat addLiquidityByStrategy");

  // Setelah selesai (finally), kunci wajib dilepas
  assert.equal(getEntryInProgressMints().has(MINT), false, "kunci baseMint dilepas setelah selesai");
  assert.equal(getEntryInProgressPools().has(POOL), false, "kunci pool dilepas setelah selesai");

  // Verifikasi parameter removeLiquidity & addLiquidityByStrategy
  const remCall = calls.find((c) => c.op === "removeLiquidity");
  assert.ok(remCall);
  assert.equal(remCall.params.fromBinId, 271);
  assert.equal(remCall.params.toBinId, 300);
  assert.equal(remCall.params.bps.toNumber(), 10000);
  assert.equal(remCall.params.shouldClaimAndClose, false);

  const addCalls = calls.filter((c) => c.op === "addLiquidityByStrategy");
  assert.equal(addCalls.length, 2, "percobaan 1 gagal lalu retry berhasil di percobaan 2");
  assert.equal(addCalls[1].params.positionPubKey.toBase58(), POS);
  assert.equal(addCalls[1].params.strategy.minBinId, 271);
  assert.equal(addCalls[1].params.strategy.maxBinId, 300);
  assert.equal(addCalls[1].params.strategy.strategyType, 2); // StrategyType.BidAsk
  assert.equal(addCalls[1].params.totalXAmount.toString(), "1234500000");
  assert.equal(addCalls[1].params.totalYAmount.toString(), "0");

  // State posisi ter-update ke 15%
  const st = getSpotTokenBidaskState(POS);
  assert.equal(st.lastPct, 15);
  assert.ok(Number.isFinite(st.lastAt) && st.lastAt > 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].success, true);

  // Jika harga naik kembali ke activeBin 295 (2.5% -> stepLevel 0), state lastPct di-reset ke 0 tanpa transaksi
  updateSpotTokenBidaskState(POS, 15, Date.now() - 120_000);
  const resetRes = await handleSpotTokenBidask({
    position: POS,
    pool: POOL,
    pair: "TEST-SOL",
    baseMint: MINT,
    mode: "spot",
    activeBin: 295,
    lowerBin: 100,
    upperBin: 300,
  });
  assert.equal(resetRes.triggered, false);
  assert.equal(resetRes.resetDown, true);
  assert.equal(getSpotTokenBidaskState(POS).lastPct, 0);
});
