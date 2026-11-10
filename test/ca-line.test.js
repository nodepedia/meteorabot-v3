import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TELEGRAM_BOT_TOKEN = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-"));
process.env.STATE_FILE = path.join(dir, "state.json");

const { default: config } = await import("../src/config/index.js");
const { parsePoolList, commentPoolInList } = await import("../src/entry/pool-list.js");
const {
  pickBestPool,
  chooseBidaskDoublePool,
  resolveCaPool,
  shouldLogCaSkip,
  _clearCaCache,
  isDlmmPool,
  markCaPoolInvalid,
  isCaPoolInvalid,
} = await import("../src/entry/ca-resolve.js");
const rt = await import("../src/entry/runtime.js");

const CA = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const SOL = "So11111111111111111111111111111111111111112";
// Bentuk asli API pool-discovery: field `pool_address` (bukan `address`).
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/meteora-pools-query-stonks.json", import.meta.url), "utf8")
);
const STONKS = "22r9JGoWRBYc4Z1pkSFw8p2tdjefS2ZZshw1vr8bBC2K";
const pool = (pool_address, o = {}) => ({
  pool_address,
  token_x: { address: CA },
  token_y: { address: SOL },
  volume: 5000,
  fee_pct: 2,
  fee_active_tvl_ratio: 3,
  dlmm_params: { bin_step: 100 },
  ...o,
});

test("parse baris CA (kolom ke-5 ca)", () => {
  const saved = { ...config.entry };
  Object.assign(config.entry, { defaultSizeSol: 0.2, defaultMaxPositions: 1 });
  try {
    assert.deepEqual(parsePoolList(`${CA},1.5x,1,spot,ca\n`), [{ pool: CA, sizeSol: 0.3, mode: "spot", ca: true }]);
    // baris manual tidak berubah (tanpa properti ca)
    assert.deepEqual(parsePoolList(`${POOL},1x,1,spot\n${POOL}\n`), [
      { pool: POOL, sizeSol: 0.2, mode: "spot" },
      { pool: POOL, sizeSol: 0.2, mode: "bidask:double" },
    ]);
    assert.deepEqual(parsePoolList(`${CA},1x,1,spot,xyz\n#${CA},1x,1,spot,ca\n`), []);
  } finally {
    Object.assign(config.entry, saved);
  }
});

test("pickBestPool: fixture asli query=<mint> → pool DLMM fee/active TVL tertinggi (skip damm_v2)", () => {
  const r = pickBestPool(FIXTURE.data, STONKS);
  // FuEy: DLMM fee/TVL ~0.23% — damm_v2 di fixture (meski query pool_type=dlmm) diabaikan.
  assert.equal(r.pool, "FuEywnbx7JQSzxMxrMrQoxWkJETJAx5bp446qx3SoXM");
  assert.equal(r.candidates, 2);
  assert.equal(FIXTURE.data.filter((p) => p.pool_type === "damm_v2").length, 3);
});

test("isDlmmPool: tolak damm_v2 / tipe non-dlmm, terima dlmm & helper tanpa pool_type", () => {
  assert.equal(isDlmmPool({ pool_type: "dlmm", dlmm_params: { bin_step: 80 } }), true);
  assert.equal(isDlmmPool({ pool_type: "damm_v2", dlmm_params: null, damm_v2_params: {} }), false);
  assert.equal(isDlmmPool({ pool_type: "cpamm" }), false);
  assert.equal(isDlmmPool({ dlmm_params: { bin_step: 100 } }), true); // helper test tanpa pool_type
  assert.equal(isDlmmPool({ dlmm_params: null, damm_v2_params: { foo: 1 } }), false);
});

test("pickBestPool: kandidat fee/TVL tertinggi non-DLMM di-skip, pilih DLMM berikutnya", () => {
  const r = pickBestPool(
    [
      pool("DAMM", {
        fee_active_tvl_ratio: 99,
        pool_type: "damm_v2",
        dlmm_params: null,
        damm_v2_params: { fee: 1 },
      }),
      pool("DLMM_LOW", { fee_active_tvl_ratio: 1, pool_type: "dlmm", dlmm_params: { bin_step: 100 } }),
      pool("DLMM_HI", { fee_active_tvl_ratio: 5, pool_type: "dlmm", dlmm_params: { bin_step: 80 } }),
    ],
    CA
  );
  assert.equal(r.pool, "DLMM_HI");
  assert.equal(r.candidates, 2);
});

test("markCaPoolInvalid: pool gagal lookup tidak dipilih lagi", () => {
  _clearCaCache();
  const pools = [
    pool("BAD", { fee_active_tvl_ratio: 50, pool_type: "dlmm", dlmm_params: { bin_step: 100 } }),
    pool("GOOD", { fee_active_tvl_ratio: 3, pool_type: "dlmm", dlmm_params: { bin_step: 80 } }),
  ];
  assert.equal(pickBestPool(pools, CA).pool, "BAD");
  markCaPoolInvalid("BAD", "Invalid account discriminator");
  assert.equal(isCaPoolInvalid("BAD"), true);
  assert.equal(pickBestPool(pools, CA).pool, "GOOD");
  assert.equal(pickBestPool(pools, CA).candidates, 1);
});

test("pickBestPool: tanpa filter, hanya X/SOL mint ini, lewati blacklist", () => {
  const r = pickBestPool(
    [
      pool("A", { fee_active_tvl_ratio: 0.1, volume: 0, fee_pct: 0.1, dlmm_params: { bin_step: 1 } }),
      pool("D", { fee_active_tvl_ratio: 0.3, dlmm_params: { bin_step: 80 } }),
      pool("B", { fee_active_tvl_ratio: 9, is_blacklisted: true }),
      pool("E", { fee_active_tvl_ratio: 7, token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } }), // bukan SOL
      pool("F", { fee_active_tvl_ratio: 50, token_x: { address: POOL } }), // mint lain
    ],
    CA
  );
  assert.equal(r.pool, "D");
});

test("pickBestPool: `address` lama masih diterima sebagai fallback", () => {
  const { pool_address, ...rest } = pool("X");
  assert.equal(pickBestPool([{ ...rest, address: "OLD" }], CA).pool, "OLD");
});

test("pickBestPool: bin step >= 100, yang dipakai fee/active TVL tertinggi di antara yang lolos", () => {
  const r = pickBestPool(
    [
      pool("FINE", { fee_active_tvl_ratio: 9, dlmm_params: { bin_step: 25 } }),
      pool("WIDE_LOW", { fee_active_tvl_ratio: 1, dlmm_params: { bin_step: 100 } }),
      pool("WIDE_HI", { fee_active_tvl_ratio: 4, dlmm_params: { bin_step: 200 } }),
      pool("NO_STEP", { fee_active_tvl_ratio: 20, dlmm_params: {} }),
    ],
    CA,
    { minBinStep: 100 }
  );
  assert.equal(r.pool, "WIDE_HI");
  assert.equal(r.binStep, 200);
  assert.equal(r.candidates, 2);
});

test("pickBestPool: tidak ada bin step yang lolos → skip, bukan pool halus", () => {
  const r = pickBestPool([pool("FINE", { fee_active_tvl_ratio: 9, dlmm_params: { bin_step: 80 } })], CA, {
    minBinStep: 100,
  });
  assert.equal(r.pool, null);
  assert.equal(r.binStepMiss, true);
  assert.match(r.reason, /bin step >= 100/);
});

test("chooseBidaskDoublePool: pool tercatat yang sudah lolos tidak diganti", () => {
  const pools = [
    pool("LISTED", { fee_active_tvl_ratio: 1, dlmm_params: { bin_step: 100 } }),
    pool("BETTER", { fee_active_tvl_ratio: 9, dlmm_params: { bin_step: 125 } }),
  ];
  const keep = chooseBidaskDoublePool({
    listedPool: "LISTED",
    listedBinStep: 100,
    minBinStep: 100,
    pools,
    mint: CA,
  });
  assert.equal(keep.pool, "LISTED");
  assert.equal(keep.redirected, false);

  const off = chooseBidaskDoublePool({
    listedPool: "LISTED",
    listedBinStep: 20,
    minBinStep: 0,
    pools,
    mint: CA,
  });
  assert.equal(off.pool, "LISTED");
  assert.equal(off.redirected, false);
});

test("chooseBidaskDoublePool: pool tercatat terlalu halus → pool X/SOL paling efisien yang lolos, atau skip", () => {
  const pools = [
    pool("LISTED", { fee_active_tvl_ratio: 9, dlmm_params: { bin_step: 25 } }),
    pool("OK_LOW", { fee_active_tvl_ratio: 1, dlmm_params: { bin_step: 100 } }),
    pool("OK_HI", { fee_active_tvl_ratio: 3, dlmm_params: { bin_step: 150 } }),
  ];
  const moved = chooseBidaskDoublePool({
    listedPool: "LISTED",
    listedBinStep: 25,
    minBinStep: 100,
    pools,
    mint: CA,
  });
  assert.equal(moved.pool, "OK_HI");
  assert.equal(moved.redirected, true);
  assert.equal(moved.binStep, 150);

  const none = chooseBidaskDoublePool({
    listedPool: "LISTED",
    listedBinStep: 25,
    minBinStep: 100,
    pools: [pools[0]],
    mint: CA,
  });
  assert.equal(none.pool, null);
  assert.equal(none.binStepMiss, true);

  // API mengaku bin step 100, on-chain 25: jangan masuk ke pool yang sama.
  const lied = chooseBidaskDoublePool({
    listedPool: "LISTED",
    listedBinStep: 25,
    minBinStep: 100,
    pools: [pool("LISTED", { fee_active_tvl_ratio: 9, dlmm_params: { bin_step: 100 } })],
    mint: CA,
  });
  assert.equal(lied.pool, null);
});

test("resolveCaPool: minBinStep disaring dari data yang sama, tanpa request kedua", async () => {
  _clearCaCache();
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        data: [
          pool("FINE", { fee_active_tvl_ratio: 8, dlmm_params: { bin_step: 20 } }),
          pool("WIDE", { fee_active_tvl_ratio: 2, dlmm_params: { bin_step: 100 } }),
        ],
      }),
    };
  };
  const spot = await resolveCaPool(CA, { fetchFn, now: 0, minBinStep: 0 });
  const bidask = await resolveCaPool(CA, { fetchFn, now: 1_000, minBinStep: 100 });
  assert.equal(calls, 1);
  assert.equal(spot.pool, "FINE");
  assert.equal(bidask.pool, "WIDE");
  assert.equal(bidask.binStep, 100);
});

test("pickBestPool: tidak ada pool X/SOL → null + alasan", () => {
  const r = pickBestPool([pool("E", { token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } })], CA);
  assert.equal(r.pool, null);
  assert.match(r.reason, /tidak ada pool DLMM X\/SOL/);
});

test("shouldLogCaSkip: maksimal 1x per CA per 10 menit", () => {
  _clearCaCache();
  assert.equal(shouldLogCaSkip(CA, 0), true);
  assert.equal(shouldLogCaSkip(CA, 15_000), false);
  assert.equal(shouldLogCaSkip(STONKS, 15_000), true);
  assert.equal(shouldLogCaSkip(CA, 599_999), false);
  assert.equal(shouldLogCaSkip(CA, 600_000), true);
});

test("resolveCaPool: cache 60s membatasi request", async () => {
  _clearCaCache();
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    assert.match(String(url), /timeframe=30m/);
    return { ok: true, json: async () => ({ data: [pool("P1")] }) };
  };
  assert.equal((await resolveCaPool(CA, { fetchFn, now: 0 })).pool, "P1");
  assert.equal((await resolveCaPool(CA, { fetchFn, now: 30_000 })).pool, "P1");
  assert.equal(calls, 1);
  await resolveCaPool(CA, { fetchFn, now: 61_000 });
  assert.equal(calls, 2);
});

test("resolveCaPool: fetch gagal → skip (pool null)", async () => {
  _clearCaCache();
  const r = await resolveCaPool(CA, { fetchFn: async () => ({ ok: false, status: 429 }), now: 0 });
  assert.equal(r.pool, null);
});

test("alias pool→CA: '#' kena baris CA", () => {
  rt.setPoolAlias(POOL, CA);
  assert.equal(rt.getPoolAlias(POOL), CA);
  const f = path.join(dir, "pool.txt");
  fs.writeFileSync(f, `${CA},1x,1,spot,ca\nOTHER,1x,1,spot\n`);
  const saved = config.entry.poolListFile;
  config.entry.poolListFile = f;
  try {
    assert.equal(commentPoolInList(POOL), true);
    assert.equal(fs.readFileSync(f, "utf8"), `#${CA},1x,1,spot,ca\nOTHER,1x,1,spot\n`);
  } finally {
    config.entry.poolListFile = saved;
  }
  rt.transferPoolAlias(POOL, "NEWPOOL");
  assert.equal(rt.getPoolAlias(POOL), null);
  assert.equal(rt.getPoolAlias("NEWPOOL"), CA);
  rt.clearPoolAliasesFor(CA);
  assert.equal(rt.getPoolAlias("NEWPOOL"), null);
});
