import test from "node:test";
import assert from "node:assert/strict";
import {
  selectWatchCandidates,
  strategyOfMode,
  quotaKey,
  countQuotaPositions,
  isQuotaFull,
  mintBlocksEntry,
  shouldCloseBeforeSpotReentry,
  poolKeysToReset,
  lineWatchId,
} from "../src/entry/candidates.js";

const c = (pool, mint = `m-${pool}`) => ({ pool, mint });

test("kandidat normal lolos", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], {});
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p1", "p2"]
  );
});

test("pool in-flight disaring", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], { inFlight: new Set(["p1"]) });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("pool yang sudah entry (entered) disaring", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], { entered: new Map([["p1", 0]]) });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("cooldown aktif disaring, yang sudah lewat lolos", () => {
  const out = selectWatchCandidates([c("p1"), c("p2")], {
    cooldowns: new Map([
      ["p1", 2000],
      ["p2", 500],
    ]),
    now: 1000,
  });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p2"]
  );
});

test("kandidat gabungan (in-flight + entered + cooldown) menyisakan satu", () => {
  const out = selectWatchCandidates([c("p1"), c("p2"), c("p3"), c("p4")], {
    inFlight: new Set(["p1"]),
    entered: new Map([["p2", 0]]),
    cooldowns: new Map([["p3", 9999]]),
    now: 1000,
  });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p4"]
  );
});

test("slot spot yang sedang jalan tidak menahan kandidat bidask", () => {
  const bidask = { pool: "p1", mint: "m1", mode: "bidask:double", strategy: "bidask" };
  const out = selectWatchCandidates([bidask, c("p2")], {
    inFlight: new Set([quotaKey("p1", "spot")]),
    entered: new Map([[quotaKey("p1", "spot"), Date.now()]]),
  });
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p1", "p2"]
  );
});

test("slot bidask in-flight atau sudah masuk menahan kandidat bidask", () => {
  const bidask = { pool: "p1", mint: "m1", mode: "bidask:double" };
  const inflight = selectWatchCandidates([bidask], { inFlight: new Set([quotaKey("p1", "bidask")]) });
  assert.equal(inflight.length, 0);
  const entered = selectWatchCandidates([bidask], { entered: new Map([[quotaKey("p1", "bidask"), 0]]) });
  assert.equal(entered.length, 0);
});

test("entri tanpa pool/mint dibuang", () => {
  const out = selectWatchCandidates([{ pool: "p1" }, { mint: "m2" }, null, c("p3")], {});
  assert.deepEqual(
    out.map((x) => x.pool),
    ["p3"]
  );
});

test("keluarga strategi: spot terpisah, semua bidask jadi satu", () => {
  assert.equal(strategyOfMode("spot"), "spot");
  assert.equal(strategyOfMode("spot:double"), "spot");
  assert.equal(strategyOfMode("bidask"), "bidask");
  assert.equal(strategyOfMode("bidask:double"), "bidask");
  assert.equal(strategyOfMode("bidask:token"), "bidask");
  assert.equal(strategyOfMode("bidask:sol"), "bidask");
  assert.equal(strategyOfMode("token-only"), "bidask");
});

test("kuota: 1 non-DCA per strategi; DCA dan strategi lain tidak mengisi slot", () => {
  const positions = [
    { pool: "P", mode: "spot", closed: false, baseMint: "M" },
    { pool: "P", mode: "bidask:token", closed: false, baseMint: "M" },
    { pool: "P", mode: "bidask:double", closed: false, isDca: true, baseMint: "M" },
    { pool: "P", mode: "bidask:sol", closed: false, isDca: true, baseMint: "M" },
    { pool: "P", mode: "bidask:double", closed: true, baseMint: "M" },
    { pool: "Q", mode: "bidask:double", closed: false, baseMint: "M" },
  ];
  assert.equal(countQuotaPositions(positions, "P", "spot"), 1);
  assert.equal(countQuotaPositions(positions, "P", "bidask"), 1);
  assert.equal(isQuotaFull(positions, "P", "spot"), true);
  assert.equal(isQuotaFull(positions, "P", "bidask"), true);
  assert.equal(isQuotaFull(positions, "Q", "spot"), false);

  const dcaOnly = positions.filter((p) => p.isDca === true || p.pool === "Q");
  assert.equal(isQuotaFull(dcaOnly, "P", "bidask"), false, "dua DCA tidak mengisi kuota bidask");
});

test("mint: pool lain memblokir, strategi lain di pool yang sama tidak", () => {
  const samePool = [
    { pool: "P", mode: "spot", closed: false, baseMint: "M", isDca: false },
    { pool: "P", mode: "bidask:double", closed: false, baseMint: "M", isDca: true },
  ];
  assert.deepEqual(mintBlocksEntry(samePool, { pool: "P", mint: "M", strategy: "bidask" }), { block: false });
  assert.equal(mintBlocksEntry(samePool, { pool: "P", mint: "M", strategy: "spot" }).sameStrategy, true);

  const otherPool = [{ pool: "Q", mode: "bidask:token", closed: false, baseMint: "M" }];
  assert.equal(mintBlocksEntry(otherPool, { pool: "P", mint: "M", strategy: "spot" }).otherPool, true);
});

test("re-entry spot menutup spot lain, bukan bidask di pool yang sama", () => {
  const spot = { pool: "P", mode: "spot", closed: false };
  const fallback = { pool: "P", mode: "bidask:token", closed: false };
  const dca = { pool: "P", mode: "bidask:double", closed: false, isDca: true };
  const otherPool = { pool: "Q", mode: "bidask:double", closed: false };
  assert.equal(shouldCloseBeforeSpotReentry(spot, "P"), true);
  assert.equal(shouldCloseBeforeSpotReentry(fallback, "P"), false);
  assert.equal(shouldCloseBeforeSpotReentry(dca, "P"), false);
  assert.equal(shouldCloseBeforeSpotReentry(otherPool, "P"), true);
  assert.equal(shouldCloseBeforeSpotReentry({ ...spot, closed: true }, "P"), false);
});

test("baris yang baru tidak dikomentari di-reset; baris yang tetap aktif tidak", () => {
  const spot = { pool: "P", mode: "spot" };
  const bidask = { pool: "P", mode: "bidask:double" };
  const first = poolKeysToReset(new Set(), [spot]);
  assert.deepEqual(first.resetKeys, ["P"]);

  const stayed = poolKeysToReset(first.ids, [spot]);
  assert.deepEqual(stayed.resetKeys, []);

  const otherStrategySamePool = poolKeysToReset(first.ids, [spot, bidask]);
  assert.deepEqual(otherStrategySamePool.resetKeys, []);

  const uncommented = poolKeysToReset(new Set(), [bidask]);
  assert.deepEqual(uncommented.resetKeys, ["P"]);
  assert.equal(lineWatchId(spot), "P|spot|");
});
