import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-reentry-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { Keypair } = await import("@solana/web3.js");
const { default: config } = await import("../src/config/index.js");
const {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  getSpotReentryCount,
  setSpotReentryCount,
  setEntrySizeSol,
  getEntrySizeSol,
  getOpenPositionsForMint,
  recordClose,
} = await import("../src/state/positions.js");
const {
  reentryBinRange,
  shouldReenter,
  canSpotReenter,
  nonRefundableCost,
  exceedsNonRefundable,
  handleSpotOorKananReentry,
  getSpotReentryCooldownRemainingMs,
  setLastSpotReentryAt,
  clearSpotReentryCooldown,
} = await import("../src/exit/spot-reentry.js");
const {
  calcBinsForPricePct,
  resolveSpotRangeWithRentCheck,
  openSpotSolPosition,
} = await import("../src/meteora/spot-position.js");
const { executeSpotEntry } = await import("../src/entry/execute.js");
const { startSpotEntry } = await import("../src/entry/index.js");
const { incrementEntryUsage, getEntryUsage, takeRecentActions } = await import("../src/entry/runtime.js");
const { selectMostEfficientSpotPool, calcSpotPoolEfficiencyScore } = await import("../src/meteora/spot-position.js");

const POOL = "PoolReentry11111111111111111111111111111111";
const POS = "PosReentry111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

test("reentryBinRange: anchor ke active, span ke bawah", () => {
  assert.deepEqual(reentryBinRange(1000, 244), { minBinId: 756, maxBinId: 1000 });
  assert.deepEqual(reentryBinRange(1000, 0), { minBinId: 1000, maxBinId: 1000 });
  assert.deepEqual(reentryBinRange(1000, -5), { minBinId: 1000, maxBinId: 1000 });
});

test("shouldReenter: butuh enabled, size>0, mode spot, reason oor_kanan, span valid, di bawah max", () => {
  const cfg = { enabled: true, sizeSol: 1, maxReentries: 10 };
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg }), true);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 9, cfg }), true);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 10, cfg }), false);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kiri", span: 244, count: 0, cfg }), false);
  assert.equal(shouldReenter({ mode: "spot", reason: "oor_kanan", span: 0, count: 0, cfg }), false);
  assert.equal(shouldReenter({ mode: "bidask:double", reason: "oor_kanan", span: 244, count: 0, cfg }), false);
  assert.equal(
    shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg: { ...cfg, enabled: false } }),
    false
  );
  assert.equal(
    shouldReenter({ mode: "spot", reason: "oor_kanan", span: 244, count: 0, cfg: { ...cfg, sizeSol: 0 } }),
    false
  );
});

test("nonRefundableCost: jumlahkan binArray + bitmap, abaikan sewa refundable", () => {
  assert.equal(nonRefundableCost({ binArrayCost: 0.07143744, bitmapExtensionCost: 0 }), 0.07143744);
  assert.ok(Math.abs(nonRefundableCost({ binArrayCost: 0.07143744, bitmapExtensionCost: 0.05 }) - 0.12143744) < 1e-12);
  assert.equal(nonRefundableCost({ binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.0574 }), 0);
  assert.equal(nonRefundableCost({}), 0);
  assert.equal(nonRefundableCost(null), 0);
});

test("exceedsNonRefundable: 0 = tolak bila ada, batas custom, nilai invalid = 0", () => {
  assert.equal(exceedsNonRefundable(0, 0), false);
  assert.equal(exceedsNonRefundable(0.07143744, 0), true);
  assert.equal(exceedsNonRefundable(0.07143744, 0.1), false);
  assert.equal(exceedsNonRefundable(0.12143744, 0.1), true);
  assert.equal(exceedsNonRefundable(0.07143744, undefined), true);
});

test("counter re-entry tersimpan per posisi", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  assert.equal(getSpotReentryCount(POS), 0);
  setSpotReentryCount(POS, 3);
  assert.equal(getSpotReentryCount(POS), 3);
  assert.equal(getTrackedPosition(POS).spotReentryCount, 3);
});

test("canSpotReenter membaca binSpan + counter dari state", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pos = { position: POS, mode: "spot" };

  // Belum ada binSpan tercatat -> tidak layak.
  assert.equal(canSpotReenter(pos, "oor_kanan"), false);

  recordTrackedRange(POS, 100, 344); // span 244
  assert.equal(canSpotReenter(pos, "oor_kanan"), true);
  assert.equal(canSpotReenter(pos, "oor_kiri"), false);

  setSpotReentryCount(POS, config.spotReentry.maxReentries);
  assert.equal(canSpotReenter(pos, "oor_kanan"), false);
});

test("calcBinsForPricePct: hitung bin untuk -95%, -90%, dan +15% (binStep=100)", () => {
  assert.equal(calcBinsForPricePct(100, -95), 301);
  assert.equal(calcBinsForPricePct(100, -90), 231);
  assert.equal(calcBinsForPricePct(100, 15), 14);
});

test("resolveSpotRangeWithRentCheck: -95% aman -> pakai -95%..+15%, deposit SOL hanya sampai activeBin", async () => {
  const pool = {
    async quoteCreatePosition({ strategy }) {
      return {
        positionCost: 0.0574,
        binArrayCost: 0,
        bitmapExtensionCost: 0,
        strategy,
      };
    },
  };
  const res = await resolveSpotRangeWithRentCheck({
    pool,
    activeBinId: 1000,
    binStep: 100,
    lowerPctPrimary: -95,
    lowerPctFallback: -90,
    upperPct: 15,
    skipNonRefundable: true,
    maxNonRefundableSol: 0,
  });

  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, false);
  assert.equal(res.lowerPctUsed, -95);
  assert.equal(res.upperPctUsed, 15);
  assert.equal(res.minBinId, 699); // 1000 - 301
  assert.equal(res.maxBinId, 1014); // 1000 + 14
  assert.equal(res.depositMinBinId, 699);
  assert.equal(res.depositMaxBinId, 1000); // +15% di atas activeBin kosong!
});

test("resolveSpotRangeWithRentCheck: -95% kena non-refundable -> fallback ke -90%..+15%", async () => {
  const calls = [];
  const pool = {
    async quoteCreatePosition({ strategy }) {
      calls.push(strategy);
      if (strategy.minBinId === 699) {
        return { binArrayCost: 0.07143744, bitmapExtensionCost: 0 };
      }
      return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.0574 };
    },
  };
  const res = await resolveSpotRangeWithRentCheck({
    pool,
    activeBinId: 1000,
    binStep: 100,
  });

  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, true);
  assert.equal(res.lowerPctUsed, -90);
  assert.equal(res.upperPctUsed, 15);
  assert.equal(res.minBinId, 769); // 1000 - 231
  assert.equal(res.maxBinId, 1014); // 1000 + 14
  assert.equal(res.depositMinBinId, 769);
  assert.equal(res.depositMaxBinId, 1000);
});

test("resolveSpotRangeWithRentCheck: -95% dan -90% sama-sama kena non-refundable -> redflag skip", async () => {
  const pool = {
    async quoteCreatePosition() {
      return { binArrayCost: 0.07143744, bitmapExtensionCost: 0 };
    },
  };
  const res = await resolveSpotRangeWithRentCheck({
    pool,
    activeBinId: 1000,
    binStep: 100,
  });

  assert.equal(res.ok, false);
  assert.equal(res.redflagNonRefundable, true);
  assert.equal(res.costPrimarySol, 0.07143744);
  assert.equal(res.costFallbackSol, 0.07143744);
});

test("openSpotSolPosition: createExtendedEmptyPosition [min..max] lalu deposit SOL hanya di [min..activeBin] per chunk <= 70 bin", async () => {
  const wallet = Keypair.generate();
  const newPos = Keypair.generate();
  let extendedRange = null;
  const addedChunks = [];

  const pool = {
    async createExtendedEmptyPosition(lower, upper, posPubkey, ownerPubkey) {
      extendedRange = { lower, upper, pos: posPubkey.toString(), owner: ownerPubkey.toString() };
      return { type: "init_extended" };
    },
    async addLiquidityByStrategy({ strategy, totalXAmount, totalYAmount }) {
      addedChunks.push({
        minBinId: strategy.minBinId,
        maxBinId: strategy.maxBinId,
        x: totalXAmount.toString(),
        y: totalYAmount.toString(),
      });
      return { type: "add_chunk" };
    },
  };

  let sigCounter = 0;
  const res = await openSpotSolPosition({
    pool,
    connection: {},
    wallet,
    feePlan: { mode: "none" },
    baseIsX: true,
    solLamports: 200_000_000n,
    minBinId: 699,
    maxBinId: 1014,
    depositMinBinId: 699,
    depositMaxBinId: 1000,
    strategyType: 0,
    slippage: 10,
    newPositionKeypair: newPos,
    sendAndConfirmFn: async () => `sig_${++sigCounter}`,
  });

  assert.equal(res.usedExtended, true);
  assert.deepEqual(extendedRange, {
    lower: 699,
    upper: 1014,
    pos: newPos.publicKey.toString(),
    owner: wallet.publicKey.toString(),
  });
  // Deposit hanya mencakup 699..1000 (302 bin -> 5 chunk), bin 1001..1014 (+15%) kosong!
  assert.equal(addedChunks.length, 5);
  assert.equal(addedChunks[0].minBinId, 699);
  assert.equal(addedChunks[addedChunks.length - 1].maxBinId, 1000);
  const totalDepositedY = addedChunks.reduce((acc, c) => acc + BigInt(c.y), 0n);
  assert.equal(totalDepositedY, 200_000_000n);
  assert.ok(addedChunks.every((c) => c.x === "0"));
});

test("executeSpotEntry: buka posisi Spot instan, simpan entrySizeSol & range [-95%..+15%], atau redflag skip bila -90% non-refundable", async () => {
  resetState();
  const wallet = Keypair.generate();
  const addedChunks = [];

  const mockPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.001" };
    },
    async quoteCreatePosition({ strategy }) {
      // -95% (699) kena rent, -90% (769) bebas rent -> fallback -90%
      if (strategy.minBinId === 699) return { binArrayCost: 0.07143744, bitmapExtensionCost: 0 };
      return { binArrayCost: 0, bitmapExtensionCost: 0 };
    },
    async createExtendedEmptyPosition() {
      return { tx: "init" };
    },
    async addLiquidityByStrategy({ strategy, totalYAmount }) {
      addedChunks.push({ minBinId: strategy.minBinId, maxBinId: strategy.maxBinId, y: totalYAmount.toString() });
      return { tx: "add" };
    },
  };

  const entryRes = await executeSpotEntry(POOL, 0.25, {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: mockPool,
      baseMint: "MintRunner111111111111111111111111111111111",
      baseIsX: true,
      quoteMint: "So11111111111111111111111111111111111111112",
      unsupported: false,
      collectFeeMode: 1,
      pairName: "RUN-SOL",
    }),
    getDlmmSdk: async () => ({ StrategyType: { Spot: 0 } }),
    getConnection: () => ({}),
    getWallet: () => wallet,
    getSolBalance: async () => 5,
    buildFeePlan: () => ({ mode: "none" }),
    checkFeeCap: () => ({ ok: true, estimatedSol: 0, maxSol: 0.002 }),
    sendAndConfirmRobust: async () => "tx_spot_entry_1",
  });

  assert.equal(entryRes.success, true);
  assert.equal(entryRes.usedFallback, true);
  assert.equal(entryRes.lowerPctUsed, -90);
  assert.equal(entryRes.upperPctUsed, 15);
  assert.equal(entryRes.minBinId, 769);
  assert.equal(entryRes.maxBinId, 1014);
  assert.equal(entryRes.depositMinBinId, 769);
  assert.equal(entryRes.depositMaxBinId, 1000);
  assert.equal(getEntrySizeSol(entryRes.position), 0.25);
  assert.equal(getTrackedPosition(entryRes.position).binSpan, 1014 - 769);

  // Test redflag skip ketika -95% dan -90% sama-sama kena non-refundable rent
  resetState();
  const redflagPool = {
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: 1000, pricePerToken: "0.001" };
    },
    async quoteCreatePosition() {
      return { binArrayCost: 0.07143744, bitmapExtensionCost: 0 };
    },
  };
  const skipRes = await executeSpotEntry(POOL, 0.25, {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: redflagPool,
      baseMint: "MintRunner111111111111111111111111111111111",
      baseIsX: true,
      quoteMint: "So11111111111111111111111111111111111111112",
      unsupported: false,
      pairName: "RUN-SOL",
    }),
  });
  assert.equal(skipRes.success, false);
  assert.equal(skipRes.skipped, true);
  assert.equal(skipRes.redflagNonRefundable, true);
});

test("handleSpotOorKananReentry: warisi entrySizeSol, pakai range -95%..+15%, dan jaga cooldown 2 menit antar loop", async () => {
  resetState();
  clearSpotReentryCooldown();
  const savedReentry = { ...config.spotReentry };
  Object.assign(config.spotReentry, {
    enabled: true,
    sizeSol: 0.2,
    maxReentries: 10,
    cooldownSec: 120,
    skipNonRefundable: true,
    maxNonRefundableSol: 0,
  });

  try {
    trackPosition(POS, POOL, "RUN-SOL", "MintRunner111111111111111111111111111111111", 1, "spot");
    recordTrackedRange(POS, 699, 1014);
    setEntrySizeSol(POS, 0.3); // 1.5x dari 0.2 SOL

    const wallet = Keypair.generate();
    const mockPool = {
      lbPair: { binStep: 100 },
      async getActiveBin() {
        return { binId: 1020, pricePerToken: "0.0012" };
      },
      async quoteCreatePosition() {
        return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.0574 };
      },
      async createExtendedEmptyPosition() {
        return { tx: "init" };
      },
      async addLiquidityByStrategy() {
        return { tx: "add" };
      },
    };

    const res = await handleSpotOorKananReentry(
      { position: POS, pool: POOL, pair: "RUN-SOL", mode: "spot" },
      {
        dryRun: false,
        getPoolInfo: async () => ({
          pool: mockPool,
          baseMint: "MintRunner111111111111111111111111111111111",
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
        sendAndConfirmRobust: async () => "tx_reentry_1",
      }
    );

    assert.equal(res.success, true);
    assert.equal(res.count, 1);
    assert.equal(res.sizeSol, 0.3); // mewarisi entrySizeSol (0.3 SOL), bukan default 0.2 SOL
    assert.equal(res.minBinId, 1020 - 301);
    assert.equal(res.maxBinId, 1020 + 14);
    assert.equal(res.depositMinBinId, 1020 - 301);
    assert.equal(res.depositMaxBinId, 1020);
    assert.equal(getEntrySizeSol(res.position), 0.3);
    assert.equal(getSpotReentryCount(res.position), 1);

    // Cooldown 2 menit (120s) langsung aktif untuk pool tersebut
    assert.ok(getSpotReentryCooldownRemainingMs(POOL) > 110_000);
    setLastSpotReentryAt(POOL, Date.now() - 121_000);
    assert.equal(getSpotReentryCooldownRemainingMs(POOL), 0);
  } finally {
    clearSpotReentryCooldown();
    Object.assign(config.spotReentry, savedReentry);
  }
});

test("startSpotEntry: bila redflag non-refundable rent (-95% & -90%), pool langsung ditandai # di pool.txt", async () => {
  resetState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spot-redflag-"));
  const poolFile = path.join(dir, "pool.txt");
  const poolAddr = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
  fs.writeFileSync(poolFile, `${poolAddr},1.25x,1,spot\n`, "utf8");

  const savedDryRun = config.dryRun;
  const savedPoolListFile = config.entry.poolListFile;
  config.dryRun = false;
  config.entry.poolListFile = poolFile;

  try {
    const res = await startSpotEntry(
      {
        pool: poolAddr,
        mint: "MintRunner111111111111111111111111111111111",
        sizeSol: 0.25,
        pairName: "RUN-SOL",
        mode: "spot",
      },
      async () => ({
        success: false,
        skipped: true,
        redflagNonRefundable: true,
        cost95Sol: 0.07143744,
        cost90Sol: 0.07143744,
        pair: "RUN-SOL",
      })
    );

    assert.equal(res.skipped, true);
    assert.equal(res.redflagNonRefundable, true);
    assert.equal(fs.readFileSync(poolFile, "utf8"), `#${poolAddr},1.25x,1,spot\n`);
  } finally {
    config.dryRun = savedDryRun;
    config.entry.poolListFile = savedPoolListFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleSpotOorKananReentry: evaluasi ulang semua pool DLMM TOKEN/SOL dan pindah ke pool paling efisien saat reposisi", async () => {
  resetState();
  clearSpotReentryCooldown();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spot-reentry-eff-"));
  const poolFile = path.join(dir, "pool.txt");
  const OLD_POOL = "OldPool111111111111111111111111111111111111";
  const BEST_POOL = "BestPool22222222222222222222222222222222222";
  const REDFLAG_POOL = "RedflagPool33333333333333333333333333333333";
  const MINT = "MintEff111111111111111111111111111111111111";
  fs.writeFileSync(poolFile, `${OLD_POOL},1.25x,1,spot\n`, "utf8");

  const savedPoolListFile = config.entry.poolListFile;
  config.entry.poolListFile = poolFile;
  incrementEntryUsage(OLD_POOL);

  try {
    trackPosition(POS, OLD_POOL, "LAUNCH-SOL", MINT, 1, "spot");
    recordTrackedRange(POS, 699, 1014);
    setEntrySizeSol(POS, 0.25);

    const wallet = Keypair.generate();
    const makeMockPool = ({ activeBinId, binStep, rentCost = 0, bins31 = 31, lpCount = 50 }) => ({
      lbPair: { binStep },
      mockBins31Ge1Sol: bins31,
      mockLpCount: lpCount,
      async getActiveBin() {
        return { binId: activeBinId, pricePerToken: "0.002" };
      },
      async quoteCreatePosition() {
        return { binArrayCost: rentCost, bitmapExtensionCost: 0, positionCost: 0.0574 };
      },
      async createExtendedEmptyPosition() {
        return { tx: "init" };
      },
      async addLiquidityByStrategy() {
        return { tx: "add" };
      },
    });

    const poolsByAddr = {
      [OLD_POOL]: makeMockPool({ activeBinId: -200, binStep: 200, rentCost: 0, bins31: 31, lpCount: 40 }),
      [BEST_POOL]: makeMockPool({ activeBinId: -400, binStep: 100, rentCost: 0, bins31: 31, lpCount: 150 }),
      // Pool ketiga punya TVL tertinggi tapi kena non-refundable rent -> harus ditolak!
      [REDFLAG_POOL]: makeMockPool({ activeBinId: -100, binStep: 100, rentCost: 0.071437, bins31: 31, lpCount: 200 }),
    };

    const res = await handleSpotOorKananReentry(
      { position: POS, pool: OLD_POOL, pair: "LAUNCH-SOL", baseMint: MINT, mode: "spot" },
      {
        dryRun: false,
        discoverCandidatePools: async () => [
          {
            address: REDFLAG_POOL,
            tvlUsd: 300000,
            fees24hUsd: 10000,
            cumFeesUsd: 20000,
            efficiencyScore: calcSpotPoolEfficiencyScore({ tvlUsd: 300000, fees24hUsd: 10000, cumFeesUsd: 20000 }),
          },
          {
            address: BEST_POOL,
            tvlUsd: 140000,
            fees24hUsd: 6000,
            cumFeesUsd: 6000,
            efficiencyScore: calcSpotPoolEfficiencyScore({ tvlUsd: 140000, fees24hUsd: 6000, cumFeesUsd: 6000 }),
          },
          {
            address: OLD_POOL,
            tvlUsd: 45000,
            fees24hUsd: 5000,
            cumFeesUsd: 5000,
            efficiencyScore: calcSpotPoolEfficiencyScore({ tvlUsd: 45000, fees24hUsd: 5000, cumFeesUsd: 5000 }),
          },
        ],
        getPoolInfo: async (addr) => ({
          pool: poolsByAddr[addr],
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
        sendAndConfirmRobust: async () => "tx_reentry_best_pool",
      }
    );

    assert.equal(res.success, true);
    assert.equal(res.switchedPool, true);
    assert.equal(res.previousPool, OLD_POOL);
    assert.equal(res.pool, BEST_POOL);
    assert.equal(getTrackedPosition(res.position).pool, BEST_POOL);
    // pool.txt otomatis di-update dari OLD_POOL ke BEST_POOL dengan mempertahankan multiplier & mode
    assert.equal(fs.readFileSync(poolFile, "utf8"), `${BEST_POOL},1.25x,1,spot\n`);
    // entryUsage juga ikut ditransfer ke BEST_POOL agar worker entry tidak buka posisi ganda
    assert.ok(getEntryUsage(BEST_POOL) >= 1);
    // Cooldown aktif di kedua pool
    assert.ok(getSpotReentryCooldownRemainingMs(OLD_POOL) > 0);
    assert.ok(getSpotReentryCooldownRemainingMs(BEST_POOL) > 0);
  } finally {
    config.entry.poolListFile = savedPoolListFile;
    clearSpotReentryCooldown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectMostEfficientSpotPool: tetap di currentPool bila currentPool paling efisien atau pool lain gagal rentCheck", async () => {
  const CUR_POOL = "CurPool111111111111111111111111111111111111";
  const OTHER_POOL = "OtherPool2222222222222222222222222222222222";
  const MINT = "MintStay11111111111111111111111111111111111";

  const res = await selectMostEfficientSpotPool({
    currentPool: CUR_POOL,
    baseMint: MINT,
    discoverPoolsFn: async () => [
      { address: CUR_POOL, tvlUsd: 150000, fees24hUsd: 8000, cumFeesUsd: 10000 },
      { address: OTHER_POOL, tvlUsd: 40000, fees24hUsd: 2000, cumFeesUsd: 3000 },
    ],
    getPoolInfoFn: async (addr) => ({
      pool: {
        lbPair: { binStep: 100 },
        mockBins31Ge1Sol: 31,
        mockLpCount: 60,
        async getActiveBin() {
          return { binId: 500 };
        },
        async quoteCreatePosition() {
          return { binArrayCost: 0, bitmapExtensionCost: 0 };
        },
      },
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
      address: addr,
    }),
    connection: {},
  });

  assert.equal(res.chosenPoolAddress, CUR_POOL);
  assert.equal(res.switched, false);
  assert.equal(res.candidatesAudited.length, 2);
});

test("handleSpotOorKananReentry: tutup posisi duplikat di token yang sama sebelum buka posisi baru & tidak pernah ada 2 posisi terbuka di 1 token", async () => {
  resetState();
  const OLD_POOL = "HGJWK4PUjjPCGHJ9cxWPDUFWBaCgFr2n3boFGsk8WVoF";
  const BEST_POOL = "FZWxV7C4JKKe3wX54MM6QpcVAHtyGrtnPFmihysWfiDB";
  const DUP_POS = "DupPos1111111111111111111111111111111111111";
  const MINT = "AhBidGAgv6QbKSWfrSCegGrzFLcBx4E5FNYTKHNQQj6C";
  clearSpotReentryCooldown(OLD_POOL);
  clearSpotReentryCooldown(BEST_POOL);

  // Posisi 1 (yang sedang direposisi) + Posisi 2 duplikat di token yang sama
  trackPosition(POS, OLD_POOL, "LAUNCH-SOL", MINT, 1, "spot", false);
  recordTrackedRange(POS, -278, -148);
  setEntrySizeSol(POS, 0.15);

  trackPosition(DUP_POS, BEST_POOL, "LAUNCH-SOL", MINT, 1, "spot", false);
  recordTrackedRange(DUP_POS, -714, -399);
  setEntrySizeSol(DUP_POS, 0.125);

  const wallet = Keypair.generate();
  const eventsOrder = [];

  const makeMockPool = (activeBinId) => ({
    lbPair: { binStep: 100 },
    async getActiveBin() {
      return { binId: activeBinId };
    },
    async getBinsBetweenLowerAndUpperBound(lo, hi) {
      const bins = [];
      for (let id = lo; id <= hi; id++) {
        bins.push({ binId: id, xAmount: "0", yAmount: String(5 * 1e9) });
      }
      return { bins };
    },
    async getLbPairPositionsByUser() {
      return Array.from({ length: 50 }, (_, i) => ({ publicKey: `pos_${i}` }));
    },
    async quoteCreatePosition() {
      return { binArrayCost: 0, bitmapExtensionCost: 0, positionCost: 0.0574 };
    },
    async initializePositionAndAddLiquidityByStrategy() {
      eventsOrder.push("open_new_position");
      return { tx: "init" };
    },
    async addLiquidityByStrategy() {
      return { tx: "add" };
    },
  });

  const res = await handleSpotOorKananReentry(
    { position: POS, pool: OLD_POOL, pair: "LAUNCH-SOL", baseMint: MINT, mode: "spot" },
    {
      dryRun: false,
      closeDuplicatePosition: async (dup) => {
        eventsOrder.push(`close_dup_${dup.position}`);
        recordClose(dup.position, "reposition_dedup_close", 0);
        return { success: true };
      },
      discoverCandidatePools: async () => [
        { address: BEST_POOL, tvlUsd: 140000, fees24hUsd: 6000, cumFeesUsd: 6000 },
        { address: OLD_POOL, tvlUsd: 45000, fees24hUsd: 5000, cumFeesUsd: 5000 },
      ],
      getPoolInfo: async (addr) => ({
        pool: makeMockPool(addr === BEST_POOL ? -400 : -200),
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
      sendAndConfirmRobust: async () => "tx_dedup_reentry",
    }
  );

  assert.equal(res.success, true);
  // Pastikan posisi duplikat ditutup SEBELUM posisi baru dibuka
  assert.deepEqual(eventsOrder, [`close_dup_${DUP_POS}`, "open_new_position"]);
  // Pastikan hanya ada TEPAT 1 posisi terbuka untuk token MINT
  const openForMint = getOpenPositionsForMint(MINT);
  assert.equal(openForMint.length, 1);
  assert.equal(openForMint[0].position, res.position);
  assert.equal(getTrackedPosition(POS).closed, true);
  assert.equal(getTrackedPosition(DUP_POS).closed, true);

  // Pastikan recordAction berupa string bersih (bukan [object Object])
  const actions = takeRecentActions(60_000);
  assert.ok(actions.some((a) => a.includes("RE-ENTRY LAUNCH-SOL") && !a.includes("[object Object]")));
});

test("executeSpotEntry: tolak buka posisi ke-2 bila token (baseMint) sudah punya posisi terbuka di pool lain", async () => {
  resetState();
  const POOL_1 = "PoolOne111111111111111111111111111111111111";
  const POOL_2 = "PoolTwo222222222222222222222222222222222222";
  const MINT = "TokenSameMint111111111111111111111111111111";

  // Sudah ada posisi aktif di POOL_1 untuk MINT
  trackPosition("OpenPosPool1", POOL_1, "TEST-SOL", MINT, 1, "spot", false);

  const res = await executeSpotEntry(POOL_2, 0.1, {
    dryRun: false,
    getPoolInfo: async () => ({
      pool: {
        lbPair: { binStep: 100 },
        async getActiveBin() {
          return { binId: 100 };
        },
      },
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
      pairName: "TEST-SOL",
    }),
  });

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(res.duplicateMint, true);
  assert.equal(getOpenPositionsForMint(MINT).length, 1);
});
