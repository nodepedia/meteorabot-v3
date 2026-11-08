import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-fee-fixture-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const {
  applyPositionFeeTvl,
  indexOpenPositionPnl,
  isOpenPositionPnlEntry,
  positionFeePct24h,
  positionPnlUpdatedAtMs,
} = await import("../src/meteora/positions.js");
const { evaluateExit, evaluateHighYieldClose } = await import("../src/exit/rules.js");
const { classifyMode } = await import("../src/exit/classify.js");
const { trackPosition } = await import("../src/state/positions.js");
const config = (await import("../src/config/index.js")).default;

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/cached-position-yield-evidence.json", import.meta.url), "utf8")
);
const records = fixture.records;
const openRec = records.find((r) => r.rawPublicFields?.isClosed === false && r.rawPublicFields?.positionAddress);
const poolRec = records.find((r) => r.jsonPointer === "/pools/0");
const closedHigh = records.filter((r) => r.rawPublicFields?.isClosed === true && Number(r.rawPublicFields?.feePerTvl24h) > 7);
const openRaw = openRec.rawPublicFields;
const poolRaw = poolRec.rawPublicFields;
const rules = { highYieldClosePct: 7 };
const fileMtimeMs = Date.parse(openRec.provenance.fileMtimeAsiaJakarta.replace(/ \[.*$/, ""));

function spotFrom(entry, observedAt) {
  const pos = {
    position: entry.positionAddress,
    pool: poolRaw.poolAddress,
    mode: "spot",
    activeBin: entry.poolActiveBinId,
    lowerBin: entry.lowerBinId,
    upperBin: entry.upperBinId,
    pnlPct: 1,
    xIsSol: false,
    hasX: true,
    hasY: true,
  };
  applyPositionFeeTvl(pos, entry, observedAt);
  return pos;
}

test("fixture: string angka posisi terbuka di-parse apa adanya, bukan pool atau unclaimed", () => {
  assert.equal(typeof openRaw.feePerTvl24h, "string");
  assert.equal(openRaw.feePerTvl24h, "6.011753571737836");
  const parsed = positionFeePct24h(openRaw);
  assert.equal(typeof parsed, "number");
  assert.equal(parsed, 6.011753571737836);
  assert.ok(!(parsed > 7));
  assert.notEqual(parsed, parseFloat(poolRaw.feePerTvl24h));
  assert.equal(poolRaw.feePerTvl24h, "5.957550610327771");

  const unclaimedUsd =
    Number(openRaw.unrealizedPnl.unclaimedFeeTokenX.usd) + Number(openRaw.unrealizedPnl.unclaimedFeeTokenY.usd);
  const reconstructed = (unclaimedUsd / Number(openRaw.unrealizedPnl.balances)) * 100;
  assert.ok(Math.abs(reconstructed - parsed) > 0.01);
  assert.equal(Number(openRaw.allTimeFees.total.usd), 0);
  assert.ok(parsed > 0);
});

test("fixture: hanya posisi terbuka yang diindeks; closed >7 tidak ikut", () => {
  assert.equal(closedHigh.length, 2);
  for (const rec of closedHigh) {
    assert.equal(isOpenPositionPnlEntry(rec.rawPublicFields), false);
    assert.ok(positionFeePct24h(rec.rawPublicFields) > 7);
  }
  assert.equal(isOpenPositionPnlEntry(poolRaw), false);
  const map = indexOpenPositionPnl(records.map((r) => r.rawPublicFields));
  assert.equal(map.size, 1);
  assert.equal(map.get(openRaw.positionAddress).feePerTvl24h, "6.011753571737836");
});

test("fixture: updatedAt unix detik, segar terhadap mtime file, basi bila dianggap detik mentah", () => {
  const updatedMs = positionPnlUpdatedAtMs(openRaw);
  assert.equal(updatedMs, openRaw.updatedAt * 1000);
  assert.equal(openRaw.updatedAt, 1794047506);
  const ageAtCapture = fileMtimeMs - updatedMs;
  assert.ok(ageAtCapture >= 0 && ageAtCapture <= 120_000, `umur saat capture ${ageAtCapture}ms`);

  const pos = spotFrom(openRaw, fileMtimeMs);
  assert.equal(pos.feePct24hUpdatedAt, updatedMs);
  assert.equal(evaluateHighYieldClose(pos, rules, { now: fileMtimeMs }), null);

  const later = fileMtimeMs + 3 * 60 * 60 * 1000;
  assert.equal(evaluateHighYieldClose(pos, rules, { now: later }), null);

  const secondsAsMs = {
    ...pos,
    feePct24h: 22.762083406587404,
    feePct24hAt: fileMtimeMs,
    feePct24hUpdatedAt: openRaw.updatedAt,
  };
  assert.equal(evaluateHighYieldClose(secondsAsMs, rules, { now: fileMtimeMs }), null);

  const rawString = {
    mode: "spot",
    feePct24h: openRaw.feePerTvl24h,
    feePct24hAt: fileMtimeMs,
    feePct24hUpdatedAt: updatedMs,
  };
  assert.equal(evaluateHighYieldClose(rawString, rules, { now: fileMtimeMs }), null);
});

test("fixture: posisi Diamond terbuka ber-span spot, in-range, tidak tutup di 6.01", () => {
  const span = openRaw.upperBinId - openRaw.lowerBinId;
  assert.equal(span, 315);
  assert.ok(span >= config.spotMinBins);
  assert.equal(classifyMode({ binSpan: span, hasX: true, hasY: true, xIsSol: false }), "spot");
  assert.equal(openRaw.isOutOfRange, false);
  assert.ok(openRaw.poolActiveBinId >= openRaw.lowerBinId && openRaw.poolActiveBinId <= openRaw.upperBinId);

  trackPosition(openRaw.positionAddress, poolRaw.poolAddress, "Diamond-SOL", poolRaw.tokenXMint, null, "spot");
  const pos = spotFrom(openRaw, fileMtimeMs);
  const res = evaluateExit(pos, null);
  assert.notEqual(res.reason, "high_yield");
  assert.notEqual(res.reason, "low_yield");
  assert.equal(res.action, "hold");
});

test("fixture: string closed >7 hanya lolos ambang bila dipaksa jadi posisi terbuka dan segar", () => {
  const closed = closedHigh[0].rawPublicFields;
  assert.equal(closed.feePerTvl24h, "22.762083406587404");
  const forced = { ...closed, isClosed: false };
  const now = positionPnlUpdatedAtMs(forced);
  const pos = spotFrom(forced, now);
  assert.equal(typeof pos.feePct24h, "number");
  assert.ok(pos.feePct24h > 7);
  assert.equal(evaluateHighYieldClose(pos, rules, { now }).reason, "high_yield");
  assert.equal(indexOpenPositionPnl([closed]).size, 0);
});
