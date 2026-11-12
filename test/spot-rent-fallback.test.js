import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-rent-fallback-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const { default: config, buildConfig } = await import("../src/config/index.js");
const { selectMostEfficientSpotPool } = await import("../src/meteora/spot-position.js");
const { buildSpotNonRefundableSkipMessage } = await import("../src/notify/telegram.js");
const { startSpotEntry, resetSpotRentRedflagAlerts } = await import("../src/entry/index.js");
const { isEntryInProgressPool, isEntryInProgressMint, addEntryInProgressPool, resetRuntimeState } =
  await import("../src/entry/runtime.js");
const { quotaKey } = await import("../src/entry/candidates.js");

const MINT = "MintRentFb11111111111111111111111111111111";

function mockPool({ binStep, rentCost, bins, lp }) {
  return {
    lbPair: { binStep },
    mockBins31Ge1Sol: bins,
    mockLpCount: lp,
    async getActiveBin() {
      return { binId: 1000 };
    },
    async quoteCreatePosition() {
      return { binArrayCost: rentCost, bitmapExtensionCost: 0, positionCost: 0.05 };
    },
  };
}

function row(address, tvlUsd, binStep) {
  const base = { address, tvlUsd, fees24hUsd: 0, cumFeesUsd: 0 };
  if (Number(binStep) > 0) base.binStep = Number(binStep);
  return base;
}

async function selectPools(current, specs, extra = {}) {
  const pools = {};
  const rows = [];
  for (const spec of specs) {
    pools[spec.address] = mockPool(spec);
    rows.push(row(spec.address, spec.tvlUsd, spec.binStep));
  }
  return selectMostEfficientSpotPool({
    currentPool: current,
    baseMint: MINT,
    discoverPoolsFn: async () => rows,
    getPoolInfoFn: async (addr) => ({
      pool: pools[addr],
      baseMint: MINT,
      baseIsX: true,
      unsupported: false,
    }),
    connection: {},
    skipNonRefundable: true,
    maxNonRefundableSol: 0,
    ...extra,
  });
}

function redflag(extra = {}) {
  return {
    success: false,
    skipped: true,
    redflagNonRefundable: true,
    costsByPct: { "-95": 0.07, "-90": 0.07, "-85": 0.07, "-80": 0.07 },
    upperPct: 15,
    maxNonRefundableSol: 0,
    reason: "non-refundable rent masih muncul pada -95%, -90%, -85%, -80%",
    ...extra,
  };
}

async function withEntry(line, fn, { rent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-fb-entry-"));
  const poolFile = path.join(dir, "pool.txt");
  fs.writeFileSync(poolFile, line);
  const saved = {
    dryRun: config.dryRun,
    file: config.entry.poolListFile,
    rent: config.spotRentFallbackPool,
  };
  config.dryRun = false;
  config.entry.poolListFile = poolFile;
  config.spotRentFallbackPool = rent;
  resetSpotRentRedflagAlerts();
  resetRuntimeState();
  try {
    await fn(poolFile);
  } finally {
    config.dryRun = saved.dryRun;
    config.entry.poolListFile = saved.file;
    config.spotRentFallbackPool = saved.rent;
    resetRuntimeState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("SPOT_RENT_FALLBACK_POOL default nyala, sama dengan strat.conf", () => {
  assert.equal(buildConfig({}).spotRentFallbackPool, true);
  assert.equal(config.spotRentFallbackPool, true);
});

test("selectMostEfficientSpotPool: lewati pool terbaik yang tidak rentOk, pilih rentOk berikutnya menurut kepadatan bin", async () => {
  const BAD = "BadPool11111111111111111111111111111111111";
  const RICH = "RichPool2222222222222222222222222222222222";
  const DENSE = "DensePool333333333333333333333333333333333";

  const res = await selectPools(BAD, [
    { address: BAD, tvlUsd: 900000, binStep: 100, rentCost: 0.2, bins: 31, lp: 80 },
    { address: RICH, tvlUsd: 500000, binStep: 80, rentCost: 0, bins: 0, lp: 1 },
    { address: DENSE, tvlUsd: 100000, binStep: 25, rentCost: 0, bins: 31, lp: 40 },
  ]);

  assert.equal(res.switched, true);
  assert.equal(res.chosenPoolAddress, DENSE);
  assert.equal(res.rentChecks.find((r) => r.poolAddress === BAD).minNonRefundableSol, 0.2);
  assert.equal(res.rentChecks.find((r) => r.poolAddress === BAD).rentOk, false);
  assert.equal(res.rentChecks.find((r) => r.poolAddress === DENSE).rentOk, true);
  assert.equal(res.rentChecks.find((r) => r.poolAddress === DENSE).minNonRefundableSol, 0);
  assert.equal(res.chosenAudit.rentOk, true);
  assert.equal(res.chosenAudit.poolInfo.pool.lbPair.binStep, 25);
  assert.equal(res.candidatesAudited.find((a) => a.poolAddress === BAD).rentOk, false);
  assert.notEqual(res.chosenPoolAddress, RICH);
});

test("selectMostEfficientSpotPool: pool yang ditandai tidak rentOk dilewati meski auditnya lolos", async () => {
  const BEST = "BestMark111111111111111111111111111111111";
  const NEXT = "NextMark222222222222222222222222222222222";

  const res = await selectPools(
    BEST,
    [
      { address: BEST, tvlUsd: 900000, binStep: 100, rentCost: 0, bins: 31, lp: 80 },
      { address: NEXT, tvlUsd: 100000, binStep: 20, rentCost: 0, bins: 31, lp: 30 },
    ],
    { notRentOkPools: [BEST], rentFallbackPool: true }
  );

  assert.equal(res.chosenPoolAddress, NEXT);
  assert.equal(res.switched, true);
  assert.equal(res.chosenAudit.rentOk, true);
  assert.equal(res.candidatesAudited.find((a) => a.poolAddress === BEST).rentOk, false);
});

test("selectMostEfficientSpotPool: tidak ada yang rentOk tetap di currentPool", async () => {
  const CUR = "CurNone1111111111111111111111111111111111";
  const OTHER = "OtherNone22222222222222222222222222222222";

  const res = await selectPools(
    CUR,
    [
      { address: OTHER, tvlUsd: 900000, binStep: 100, rentCost: 0.2, bins: 31, lp: 80 },
      { address: CUR, tvlUsd: 100000, binStep: 25, rentCost: 0.2, bins: 31, lp: 40 },
    ],
    { rentFallbackPool: true }
  );

  assert.equal(res.chosenPoolAddress, CUR);
  assert.equal(res.switched, false);
  assert.equal(res.rentChecks.length, 2);
  const cur = res.rentChecks.find((r) => r.poolAddress === CUR);
  const other = res.rentChecks.find((r) => r.poolAddress === OTHER);
  assert.equal(cur.rentOk, false);
  assert.equal(other.rentOk, false);
  assert.equal(cur.binStep, 25);
  assert.equal(other.binStep, 100);
  assert.equal(cur.minNonRefundableSol, 0.2);
  assert.equal(other.minNonRefundableSol, 0.2);
});

test("selectMostEfficientSpotPool: sakelar mati mengabaikan tanda tidak rentOk", async () => {
  const BEST = "BestOff1111111111111111111111111111111111";
  const NEXT = "NextOff2222222222222222222222222222222222";

  const res = await selectPools(
    BEST,
    [
      { address: BEST, tvlUsd: 900000, binStep: 100, rentCost: 0, bins: 31, lp: 80 },
      { address: NEXT, tvlUsd: 100000, binStep: 20, rentCost: 0, bins: 31, lp: 30 },
    ],
    { notRentOkPools: [BEST], rentFallbackPool: false }
  );

  assert.equal(res.chosenPoolAddress, BEST);
  assert.equal(res.switched, false);
});

test("selectMostEfficientSpotPool: audit yang gagal tetap masuk rentChecks", async () => {
  const CUR = "CurAuditFail111111111111111111111111111111";
  const BAD = "BadAuditFail222222222222222222222222222222";
  const res = await selectPools(
    CUR,
    [
      { address: CUR, tvlUsd: 10, binStep: 20, rentCost: 0.2, bins: 1, lp: 1 },
      { address: BAD, tvlUsd: 50, binStep: 15, rentCost: 0, bins: 1, lp: 1 },
    ],
    {
      getPoolInfoFn: async (addr) => {
        if (addr === BAD) throw new Error("rpc down");
        return {
          pool: mockPool({ binStep: 20, rentCost: 0.2, bins: 1, lp: 1 }),
          baseMint: MINT,
          baseIsX: true,
          unsupported: false,
        };
      },
    }
  );

  assert.equal(res.chosenPoolAddress, CUR);
  assert.equal(res.switched, false);
  const bad = res.rentChecks.find((r) => r.poolAddress === BAD);
  assert.equal(bad.rentOk, false);
  assert.equal(bad.minNonRefundableSol, null);
  assert.equal(bad.binStep, 15);
  assert.equal(
    res.candidatesAudited.some((a) => a.poolAddress === BAD),
    false
  );
});

test("entry spot pertama pindah ke pool lain yang rentOk dengan size yang sama", async () => {
  const poolA = "PoolARent1111111111111111111111111111111";
  const poolB = "PoolBRent2222222222222222222222222222222";
  const mint = "MintMove111111111111111111111111111111111";
  await withEntry(`${poolA},1x,1,spot\n`, async (poolFile) => {
    const calls = [];
    const moves = [];
    const alerts = [];
    let selectArgs = null;
    const res = await startSpotEntry(
      { pool: poolA, mint, sizeSol: 0.25, pairName: "RENT-SOL", mode: "spot" },
      async (pool, size) => {
        calls.push({
          pool,
          size,
          poolLocked: isEntryInProgressPool(pool),
          mintLocked: isEntryInProgressMint(mint),
        });
        if (pool === poolA) return redflag({ pair: "RENT-SOL" });
        return { success: true, pool };
      },
      {
        notifySpotNonRefundableSkipped: (payload) => alerts.push(payload),
        notifySpotRentPoolSwitch: (payload) => moves.push(payload),
        selectMostEfficientSpotPool: async (args) => {
          selectArgs = args;
          return {
            chosenPoolAddress: poolB,
            switched: true,
            chosenAudit: { poolAddress: poolB, rentOk: true },
          };
        },
      }
    );

    assert.equal(res.success, true);
    assert.deepEqual(
      calls.map((c) => [c.pool, c.size]),
      [
        [poolA, 0.25],
        [poolB, 0.25],
      ]
    );
    assert.equal(calls[1].poolLocked, true);
    assert.equal(calls[1].mintLocked, true);
    assert.equal(calls[0].mintLocked, true);
    assert.equal(selectArgs.baseMint, mint);
    assert.equal(selectArgs.rentFallbackPool, true);
    assert.deepEqual(selectArgs.notRentOkPools, [poolA]);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].text, `pindah pool karena rent: ${poolA} -> ${poolB}`);
    assert.equal(alerts.length, 0);
    assert.equal(fs.readFileSync(poolFile, "utf8"), `${poolA},1x,1,spot\n`);
    assert.equal(isEntryInProgressPool(poolA), false);
    assert.equal(isEntryInProgressPool(poolB), false);
    assert.equal(isEntryInProgressMint(mint), false);
  });
});

test("entry spot pertama tanpa kandidat rentOk tetap redflag pool asal", async () => {
  const poolA = "PoolNoAlt11111111111111111111111111111111";
  const mint = "MintNoAlt11111111111111111111111111111111";
  await withEntry(`${poolA},1x,1,spot\n`, async (poolFile) => {
    const calls = [];
    const moves = [];
    const alerts = [];
    const res = await startSpotEntry(
      { pool: poolA, mint, sizeSol: 0.1, pairName: "NONE-SOL", mode: "spot" },
      async (pool, size) => {
        calls.push([pool, size]);
        return redflag({ pair: "NONE-SOL" });
      },
      {
        notifySpotNonRefundableSkipped: (payload) => alerts.push(payload),
        notifySpotRentPoolSwitch: (payload) => moves.push(payload),
        selectMostEfficientSpotPool: async () => ({
          chosenPoolAddress: poolA,
          switched: false,
          chosenAudit: null,
          candidatesAudited: [],
        }),
      }
    );

    assert.equal(res.redflagNonRefundable, true);
    assert.deepEqual(calls, [[poolA, 0.1]]);
    assert.equal(moves.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].pool, poolA);
    assert.equal(alerts[0].watchDisabled, true);
    const msg = buildSpotNonRefundableSkipMessage(alerts[0]);
    assert.match(msg, /semua pool TOKEN\/SOL untuk token ini terkena sewa non-refundable/);
    assert.match(msg, /Pool dicek: 1/);
    assert.doesNotMatch(msg, /fallback nonaktif/);
    assert.doesNotMatch(msg, /Catatan:/);
    assert.equal(fs.readFileSync(poolFile, "utf8"), `#${poolA},1x,1,spot\n`);
  });
});

test("entry spot pertama tidak pindah bila slot pool pengganti sudah terpakai", async () => {
  const poolA = "PoolBusyA1111111111111111111111111111111";
  const poolB = "PoolBusyB2222222222222222222222222222222";
  const mint = "MintBusy111111111111111111111111111111111";
  await withEntry(`${poolA},1x,1,spot\n`, async (poolFile) => {
    addEntryInProgressPool(quotaKey(poolB, "spot"));
    const calls = [];
    const moves = [];
    const alerts = [];
    const res = await startSpotEntry(
      { pool: poolA, mint, sizeSol: 0.1, pairName: "BUSY-SOL", mode: "spot" },
      async (pool) => {
        calls.push(pool);
        return redflag({ pair: "BUSY-SOL" });
      },
      {
        notifySpotNonRefundableSkipped: (payload) => alerts.push(payload),
        notifySpotRentPoolSwitch: (payload) => moves.push(payload),
        selectMostEfficientSpotPool: async () => ({
          chosenPoolAddress: poolB,
          switched: true,
          chosenAudit: { poolAddress: poolB, rentOk: true },
          rentChecks: [
            { poolAddress: poolA, binStep: 80, rentOk: false, minNonRefundableSol: 0.07 },
            { poolAddress: poolB, binStep: 20, rentOk: true, minNonRefundableSol: 0 },
          ],
        }),
      }
    );

    assert.equal(res.redflagNonRefundable, true);
    assert.deepEqual(calls, [poolA]);
    assert.equal(moves.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].pool, poolA);
    const msg = buildSpotNonRefundableSkipMessage(alerts[0]);
    assert.match(msg, /Pool dicek: 2/);
    assert.doesNotMatch(msg, /semua pool TOKEN\/SOL/);
    assert.match(msg, new RegExp(`${poolB.slice(0, 8)}… \\| binStep 20 \\| min sewa 0\\.000000 SOL`));
    assert.equal(isEntryInProgressPool(poolB), true);
    assert.equal(fs.readFileSync(poolFile, "utf8").startsWith("#"), true);
  });
});

test("entry spot: pool pengganti juga gagal sewa, alert memuat keduanya", async () => {
  const poolA = "PoolBothA1111111111111111111111111111111";
  const poolB = "PoolBothB2222222222222222222222222222222";
  const mint = "MintBoth111111111111111111111111111111111";
  await withEntry(`${poolA},1x,1,spot\n`, async (poolFile) => {
    const calls = [];
    const alerts = [];
    const res = await startSpotEntry(
      { pool: poolA, mint, sizeSol: 0.125, pairName: "LuckyCoin-SOL", mode: "spot" },
      async (pool) => {
        calls.push(pool);
        if (pool === poolB) {
          return redflag({
            pair: "LuckyCoin-SOL",
            binStep: 25,
            costsByPct: { "-95": 0.08, "-80": 0.03 },
            maxNonRefundableSol: 0,
          });
        }
        return redflag({
          pair: "LuckyCoin-SOL",
          binStep: 80,
          costsByPct: { "-95": 0.2, "-80": 0.1 },
          maxNonRefundableSol: 0,
        });
      },
      {
        notifySpotNonRefundableSkipped: (payload) => alerts.push(payload),
        selectMostEfficientSpotPool: async () => ({
          chosenPoolAddress: poolB,
          switched: true,
          chosenAudit: { poolAddress: poolB, rentOk: true },
          rentChecks: [
            { poolAddress: poolA, binStep: 80, rentOk: false, minNonRefundableSol: 0.2 },
            { poolAddress: poolB, binStep: 25, rentOk: true, minNonRefundableSol: 0 },
          ],
        }),
      }
    );

    assert.equal(res.redflagNonRefundable, true);
    assert.deepEqual(calls, [poolA, poolB]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].mint, mint);
    const msg = buildSpotNonRefundableSkipMessage(alerts[0]);
    assert.match(msg, /semua pool TOKEN\/SOL untuk token ini terkena sewa non-refundable/);
    assert.match(msg, /Token: MintBoth…/);
    assert.match(msg, /Modal: 0\.125 SOL/);
    assert.match(msg, /Pool dicek: 2/);
    assert.match(msg, /PoolBoth… \| binStep 80 \| min sewa 0\.100000 SOL/);
    assert.match(msg, /PoolBoth… \| binStep 25 \| min sewa 0\.030000 SOL/);
    assert.doesNotMatch(msg, /Catatan:/);
    assert.equal(fs.readFileSync(poolFile, "utf8"), `#${poolA},1x,1,spot\n`);
  });
});

test("SPOT_RENT_FALLBACK_POOL=false: entry tidak mencari pool lain dan redflag lama tetap jalan", async () => {
  const poolA = "PoolOffA11111111111111111111111111111111";
  const poolB = "PoolOffB22222222222222222222222222222222";
  const mint = "MintOff1111111111111111111111111111111111";
  await withEntry(
    `${poolA},1x,1,spot\n`,
    async (poolFile) => {
      let selected = false;
      const alerts = [];
      const res = await startSpotEntry(
        { pool: poolA, mint, sizeSol: 0.1, pairName: "OFF-SOL", mode: "spot" },
        async () => redflag({ pair: "OFF-SOL" }),
        {
          notifySpotNonRefundableSkipped: (payload) => alerts.push(payload),
          notifySpotRentPoolSwitch: () => {
            throw new Error("tidak boleh kirim info pindah pool");
          },
          selectMostEfficientSpotPool: async () => {
            selected = true;
            return {
              chosenPoolAddress: poolB,
              switched: true,
              chosenAudit: { poolAddress: poolB, rentOk: true },
            };
          },
        }
      );

      assert.equal(selected, false);
      assert.equal(res.redflagNonRefundable, true);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].pool, poolA);
      const msg = buildSpotNonRefundableSkipMessage(alerts[0]);
      assert.match(msg, /Hanya pool asal yang dicek \(fallback nonaktif\)/);
      assert.match(msg, /Pool dicek: 1/);
      assert.doesNotMatch(msg, /semua pool TOKEN\/SOL/);
      assert.equal(fs.readFileSync(poolFile, "utf8"), `#${poolA},1x,1,spot\n`);
    },
    { rent: false }
  );
});
