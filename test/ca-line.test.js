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
const { pickBestPool, resolveCaPool, _clearCaCache } = await import("../src/entry/ca-resolve.js");
const rt = await import("../src/entry/runtime.js");

const CA = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const SOL = "So11111111111111111111111111111111111111112";
const pool = (address, o = {}) => ({
  address,
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
    assert.deepEqual(parsePoolList(`${CA},1.5x,1,spot,ca\n`), [{ pool: CA, sizeSol: 0.3, maxPositions: 1, mode: "spot", ca: true }]);
    // baris manual tidak berubah (tanpa properti ca)
    assert.deepEqual(parsePoolList(`${POOL},1x,1,spot\n${POOL}\n`), [
      { pool: POOL, sizeSol: 0.2, maxPositions: 1, mode: "spot" },
      { pool: POOL, sizeSol: 0.2, maxPositions: 1, mode: "bidask:double" },
    ]);
    assert.deepEqual(parsePoolList(`${CA},1x,1,spot,xyz\n#${CA},1x,1,spot,ca\n`), []);
  } finally {
    Object.assign(config.entry, saved);
  }
});

test("pickBestPool: fee/active TVL tertinggi di antara pool yang lolos filter", () => {
  const r = pickBestPool(
    [
      pool("A", { fee_active_tvl_ratio: 9, volume: 100 }), // gagal volume
      pool("B", { fee_active_tvl_ratio: 8, dlmm_params: { bin_step: 250 } }), // gagal bin step
      pool("C", { fee_active_tvl_ratio: 4 }),
      pool("D", { fee_active_tvl_ratio: 6 }),
      pool("E", { fee_active_tvl_ratio: 7, token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } }), // bukan SOL
      pool("F", { fee_active_tvl_ratio: 50, token_x: { address: POOL } }), // mint lain
    ],
    CA
  );
  assert.equal(r.pool, "D");
});

test("pickBestPool: tidak ada yang lolos → null + alasan", () => {
  const r = pickBestPool([pool("A", { fee_pct: 0.5 }), pool("B", { fee_active_tvl_ratio: 0.2 })], CA);
  assert.equal(r.pool, null);
  assert.match(r.reason, /lolos filter/);
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

test("alias pool→CA: usage dihitung per baris CA dan '#' kena baris CA", () => {
  rt.setPoolAlias(POOL, CA);
  assert.equal(rt.getPoolAlias(POOL), CA);
  rt.incrementEntryUsage(POOL);
  assert.equal(rt.getEntryUsage(CA), 1);
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
  rt.resetEntryUsage(POOL);
  assert.equal(rt.getEntryUsage(CA), 0);
  rt.transferPoolAlias(POOL, "NEWPOOL");
  assert.equal(rt.getPoolAlias(POOL), null);
  assert.equal(rt.getPoolAlias("NEWPOOL"), CA);
  rt.clearPoolAliasesFor(CA);
  assert.equal(rt.getPoolAlias("NEWPOOL"), null);
});
