import test from "node:test";
import assert from "node:assert/strict";
import { computeRSI, computeMACD, computeBB, isGreenAfterDarkRed } from "../src/market/indicators.js";

test("computeRSI returns 100 when there are only gains", () => {
  const rsi = computeRSI([1, 2, 3, 4, 5], 2);
  assert.equal(rsi.length, 3);
  assert.equal(rsi[rsi.length - 1], 100);
});

test("computeRSI returns 0 when there are only losses", () => {
  const rsi = computeRSI([5, 4, 3, 2, 1], 2);
  assert.equal(rsi[rsi.length - 1], 0);
});

test("computeRSI returns empty for insufficient data", () => {
  assert.deepEqual(computeRSI([1, 2], 2), []);
});

test("computeBB collapses to a single value for a flat series", () => {
  const bb = computeBB([10, 10, 10, 10, 10], 5, 2);
  assert.equal(bb.middle, 10);
  assert.equal(bb.upper, 10);
  assert.equal(bb.lower, 10);
});

test("computeBB returns nulls for insufficient data", () => {
  const bb = computeBB([1, 2, 3], 20, 2);
  assert.deepEqual(bb, { upper: null, middle: null, lower: null });
});

test("computeMACD signals insufficient data", () => {
  const macd = computeMACD([1, 2, 3], 12, 26, 9);
  assert.deepEqual(macd.macd, []);
  assert.equal(macd.greenAfterDarkRed, false);
});

test("computeMACD returns a boolean greenAfterDarkRed with enough data", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const macd = computeMACD(closes, 12, 26, 9);
  assert.equal(typeof macd.greenAfterDarkRed, "boolean");
  assert.ok(Array.isArray(macd.histogram));
});

test("greenAfterDarkRed true saat hijau setelah merah gelap", () => {
  assert.equal(isGreenAfterDarkRed([-3, -2, 0.5]), true);
});

test("greenAfterDarkRed false saat bar sebelumnya merah terang (turun)", () => {
  assert.equal(isGreenAfterDarkRed([-1, -2, 0.5]), false);
});

test("greenAfterDarkRed false saat bar sebelumnya sudah hijau", () => {
  assert.equal(isGreenAfterDarkRed([0.5, 0.2, 0.8]), false);
});

test("greenAfterDarkRed false saat bar terakhir belum hijau", () => {
  assert.equal(isGreenAfterDarkRed([-3, -2, -1]), false);
});

test("greenAfterDarkRed false untuk data kurang dari 3 bar", () => {
  assert.equal(isGreenAfterDarkRed([-2, 0.5]), false);
  assert.equal(isGreenAfterDarkRed([]), false);
  assert.equal(isGreenAfterDarkRed(null), false);
});
