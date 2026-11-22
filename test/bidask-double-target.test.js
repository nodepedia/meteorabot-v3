import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bidask-double-target-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const CA = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const SOL = "So11111111111111111111111111111111111111112";

const { parsePoolList } = await import("../src/entry/pool-list.js");
const { default: config } = await import("../src/config/index.js");
const { parseEntrybotSizeOptions } = await import("../src/config/entrybot-size.js");
const { bidaskDoubleTargetKey, pollBidaskDoubleTargets, stepBidaskDoubleTarget, supertrendHitsToEnter } =
  await import("../src/entry/bidask-double-target.js");
const { clearBidaskDoubleTouch, getBidaskDoubleTouch, pruneBidaskDoubleTouch, setBidaskDoubleTouch } =
  await import("../src/state/bidask-double-touch.js");

function withSize(size, fn) {
  const saved = config.entry.defaultSizeSol;
  config.entry.defaultSizeSol = size;
  try {
    return fn();
  } finally {
    config.entry.defaultSizeSol = saved;
  }
}

test("parse: target opsional bidask:double, kolom kosong = perilaku lama", () => {
  withSize(0.2, () => {
    assert.deepEqual(parsePoolList(`${CA},1x,,bidask:double,ca\n${POOL},0.5,,bidask:double\n`), [
      { pool: CA, sizeSol: 0.2, mode: "bidask:double", ca: true },
      { pool: POOL, sizeSol: 0.5, mode: "bidask:double" },
    ]);
    assert.deepEqual(parsePoolList(`${CA},1x,,bidask:double,ca,0.0000379sol\n`), [
      {
        pool: CA,
        sizeSol: 0.2,
        mode: "bidask:double",
        ca: true,
        entryPrice: 0.0000379,
        entryPriceUnit: "sol",
      },
    ]);
    assert.deepEqual(parsePoolList(`${POOL},0.5,,bidask:double,,0.0012\n${POOL},0.5,,bidask:double,,0.0012usd\n`), [
      { pool: POOL, sizeSol: 0.5, mode: "bidask:double", entryPrice: 0.0012, entryPriceUnit: "usd" },
      { pool: POOL, sizeSol: 0.5, mode: "bidask:double", entryPrice: 0.0012, entryPriceUnit: "usd" },
    ]);
    assert.deepEqual(
      parsePoolList(
        `${POOL},0.5,,bidask:double,0.0012\n${CA},1x,,bidask:double,ca,now\n${CA},1x,,bidask:double,ca,0sol\n${CA},1x,,bidask:double,ca,1btc\n${POOL},1x,,spot\n`
      ),
      [{ pool: POOL, sizeSol: 0.2, mode: "spot" }]
    );
  });
});

test("sentuh mengunci armed dan tidak lepas kalau harga menjauh", () => {
  let step = stepBidaskDoubleTarget(0.5, 1, null);
  assert.equal(step.armed, false);
  assert.equal(step.direction, "up");
  assert.equal(step.record, true);
  step = stepBidaskDoubleTarget(0.8, 1, { direction: "up", armed: false });
  assert.equal(step.armed, false);
  step = stepBidaskDoubleTarget(1, 1, { direction: "up", armed: false });
  assert.equal(step.newlyArmed, true);
  assert.equal(step.direction, "up");
  const armed = { direction: "up", armed: true };
  assert.equal(stepBidaskDoubleTarget(3, 1, armed).armed, true);
  assert.equal(stepBidaskDoubleTarget(0.1, 1, armed).newlyArmed, false);
  assert.equal(stepBidaskDoubleTarget(0.1, 1, armed).armed, true);

  const down = stepBidaskDoubleTarget(2, 1, null);
  assert.equal(down.direction, "down");
  assert.equal(down.armed, false);
  assert.equal(stepBidaskDoubleTarget(1, 1, { direction: "down", armed: false }).armed, true);

  const exact = stepBidaskDoubleTarget(1, 1, null);
  assert.equal(exact.armed, true);
  assert.equal(exact.newlyArmed, true);
  assert.equal(stepBidaskDoubleTarget(Number.NaN, 1, null).armed, false);
  assert.equal(stepBidaskDoubleTarget(Number.NaN, 1, { direction: "up", armed: false }).armed, false);
});

test("Supertrend diabaikan sebelum armed dan dipakai sesudahnya", () => {
  const gated = {
    pool: "P",
    mint: CA,
    mode: "bidask:double",
    entryPrice: 1,
    targetKey: "k",
    line: 1,
    price: 0.4,
  };
  const plain = { pool: "Q", mint: CA, mode: "bidask:double", line: 1, price: 0.4 };
  const read = (key) => (key === "k" ? touch : null);
  let touch = null;
  assert.deepEqual(
    supertrendHitsToEnter([gated, plain], read).map((row) => row.pool),
    ["Q"]
  );
  touch = { direction: "up", armed: true };
  assert.deepEqual(
    supertrendHitsToEnter([gated, plain], read).map((row) => row.pool),
    ["P", "Q"]
  );
});

test("poll menyimpan arah, mengunci, dan harga tak terbaca tidak mengunci", async () => {
  const key = bidaskDoubleTargetKey(CA, 0.0000379, "sol");
  clearBidaskDoubleTouch(key);
  const watch = {
    lineKey: CA,
    mint: CA,
    ca: true,
    entryPrice: 0.0000379,
    entryPriceUnit: "sol",
    targetKey: key,
  };
  const prices = new Map([
    [CA, 0.00002953 * 100],
    [SOL, 100],
  ]);
  const deps = {
    getPrices: async () => prices,
  };
  const first = await pollBidaskDoubleTargets([watch], deps);
  assert.equal(first.armed.length, 0);
  assert.deepEqual(getBidaskDoubleTouch(key), { direction: "up", armed: false });

  prices.set(CA, Number.NaN);
  const unread = await pollBidaskDoubleTargets([watch], deps);
  assert.equal(unread.armed.length, 0);
  assert.equal(getBidaskDoubleTouch(key).armed, false);

  prices.set(CA, 0.00004 * 100);
  const hit = await pollBidaskDoubleTargets([watch], deps);
  assert.equal(hit.armed.length, 1);
  assert.equal(getBidaskDoubleTouch(key).armed, true);

  prices.set(CA, 0.00001 * 100);
  const away = await pollBidaskDoubleTargets([watch], deps);
  assert.equal(away.armed.length, 0);
  assert.equal(getBidaskDoubleTouch(key).armed, true);
  assert.equal(supertrendHitsToEnter([{ ...watch, mode: "bidask:double" }], getBidaskDoubleTouch).length, 1);
});

test("ubah target atau hapus baris menghapus arah dan armed; entry sukses juga", () => {
  const oldKey = bidaskDoubleTargetKey(CA, 0.0000379, "sol");
  const nextKey = bidaskDoubleTargetKey(CA, 0.00001, "sol");
  setBidaskDoubleTouch(oldKey, { direction: "up", armed: true });
  pruneBidaskDoubleTouch([nextKey]);
  assert.equal(getBidaskDoubleTouch(oldKey), null);
  assert.equal(getBidaskDoubleTouch(nextKey), null);

  setBidaskDoubleTouch(oldKey, { direction: "down", armed: true });
  pruneBidaskDoubleTouch([]);
  assert.equal(getBidaskDoubleTouch(oldKey), null);

  setBidaskDoubleTouch(oldKey, { direction: "up", armed: true });
  clearBidaskDoubleTouch(oldKey);
  assert.equal(getBidaskDoubleTouch(oldKey), null);
  const fresh = stepBidaskDoubleTarget(0.00005, 0.0000379, null);
  assert.equal(fresh.armed, false);
  assert.equal(fresh.direction, "down");
});

test("ENTRYBOT_SIZE_OPTIONS default 0.5, 1, 2 dan fallback kalau kosong", () => {
  assert.deepEqual(config.entry.entrybotSizeOptions, [0.5, 1, 2]);
  assert.deepEqual(parseEntrybotSizeOptions(undefined), [0.5, 1, 2]);
  assert.deepEqual(parseEntrybotSizeOptions("0.25, 3, 0, foo, 3"), [0.25, 3]);
  assert.deepEqual(parseEntrybotSizeOptions("nope"), [0.5, 1, 2]);
});
