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

test("harga basi tidak ditandai siap entry", () => {
  const block = blockWith({
    pool: "p1",
    pairName: "WOW-SOL",
    trend: "bullish",
    line: 100,
    price: 99,
    priceStale: true,
    priceAgeSec: 75,
  });
  assert.match(block, /harga basi \(75s\)/);
  assert.doesNotMatch(block, /siap entry/);
  const sol = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 1,
    entryPriceUnit: "usd",
    price: 1,
    touchDirection: "down",
    priceStale: true,
    priceAgeSec: 90,
  });
  assert.match(sol, /harga basi \(90s\)/);
  assert.doesNotMatch(sol, /siap entry/);
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
    touchDirection: "down",
  });
  assert.match(waiting, /bidask:sol menunggu turun ke \$0\.002 \(sekarang 0\.003\)/);
  assert.doesNotMatch(waiting, /siap entry/);
  const ready = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.003,
    price: 0.003,
    touchDirection: "up",
  });
  assert.match(ready, /siap entry/);
  assert.match(waiting, /\$0\.002/);
  assert.match(ready, /\$0\.003/);
});

test("bidask:sol ringkasan menampilkan satuan SOL dan USD", () => {
  const sol = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.0000123,
    entryPriceUnit: "sol",
    price: 0.00002,
    touchDirection: "down",
  });
  assert.match(sol, /menunggu turun ke 0\.0000123 SOL \(sekarang 0\.00002\)/);
  assert.doesNotMatch(sol, /\$/);
  assert.doesNotMatch(sol, /siap entry/);

  const usd = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.0012,
    entryPriceUnit: "usd",
    price: 0.001,
    touchDirection: "up",
  });
  assert.match(usd, /menunggu naik ke \$0\.0012 \(sekarang 0\.001\)/);
  assert.doesNotMatch(usd, /siap entry/);

  const macca = blockWith({
    pool: "mintmint",
    pairName: "CA AKotzk1d",
    pendingBidaskSol: true,
    entryPrice: 0.0000379,
    entryPriceUnit: "sol",
    price: 0.00002953,
    touchDirection: "up",
  });
  assert.match(macca, /menunggu naik ke 0\.0000379 SOL \(sekarang 0\.00002953\)/);

  const noSol = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: 0.0000123,
    entryPriceUnit: "sol",
    price: null,
  });
  assert.match(noSol, /0\.0000123 SOL/);
  assert.match(noSol, /harga belum tersedia/);
  assert.doesNotMatch(noSol, /siap entry/);
});

test("bidask:sol now menulis entry sekarang, bukan arah sentuh", () => {
  const ready = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPrice: null,
    entryPriceUnit: "now",
    price: 0.004,
  });
  assert.match(ready, /entry sekarang \(harga pasar\) \(sekarang 0\.004\) — siap entry/);
  assert.doesNotMatch(ready, /menunggu naik|menunggu turun/);
  const unread = blockWith({
    pool: "mintmint",
    pairName: "CA mintmint",
    pendingBidaskSol: true,
    entryPriceUnit: "now",
    price: null,
  });
  assert.match(unread, /entry sekarang \(harga pasar\) \| harga belum tersedia/);
});

test("clock menampilkan WIB (UTC+7)", () => {
  const ts = Date.UTC(2026, 8, 20, 0, 15, 44);
  assert.equal(clock(ts), "20 Sep 2026 07:15:44 WIB");
});
