import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryBlock, clock } from "../src/core/report.js";

function blockWith(watch) {
  return buildSummaryBlock({ mode: "LIVE", now: Date.now(), watched: [watch] });
}

test("bullish + harga <= garis ditandai siap entry", () => {
  const block = blockWith({ pool: "p1", pairName: "WOW-SOL", trend: "bullish", line: 100, price: 99 });
  assert.match(block, /siap entry/);
});

test("bullish + harga di atas garis menunggu turun", () => {
  const block = blockWith({ pool: "p1", pairName: "WOW-SOL", trend: "bullish", line: 100, price: 101 });
  assert.match(block, /menunggu turun/);
  assert.doesNotMatch(block, /siap entry/);
});

test("bearish tidak pernah ditandai siap entry walau harga di bawah garis", () => {
  const block = blockWith({ pool: "p1", pairName: "WOW-SOL", trend: "bearish", line: 100, price: 99 });
  assert.doesNotMatch(block, /siap entry/);
  assert.match(block, /tidak dipantau untuk entry/);
});

test("bidask:sol yang menunggu harga tampil di ringkasan", () => {
  const waiting = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.002,
    price: 0.003,
  });
  assert.match(waiting, /bidask:sol menunggu harga/);
  assert.match(waiting, /DI ATAS harga entry/);
  assert.doesNotMatch(waiting, /siap entry/);
  const ready = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.003,
    price: 0.002,
  });
  assert.match(ready, /siap entry/);
});

test("clock menampilkan WIB (UTC+7)", () => {
  const ts = Date.UTC(2026, 8, 20, 0, 15, 44);
  assert.equal(clock(ts), "20 Sep 2026 07:15:44 WIB");
});
