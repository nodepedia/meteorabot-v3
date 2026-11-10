import test from "node:test";
import assert from "node:assert/strict";
import { poolPriceChangePct } from "../src/state/dca.js";
import {
  bidaskDoubleStepLevel,
  tokenSideBinsForBidaskRebalance,
  evaluateBidaskDoubleRebalance,
} from "../src/exit/bidask-double-rebalance.js";

const cfg = { enabled: true, stepPct: 10, cooldownSec: 60, retry: 3 };
const pos = { mode: "bidask:double", position: "p1", pool: "pool1" };
const tracked = (extra = {}) => ({
  position: "p1",
  mode: "bidask:double",
  entryPoolPrice: 1,
  lastBidaskDoubleRebalancePct: 0,
  lastBidaskDoubleRebalanceAt: null,
  ...extra,
});

test("step harga: -10, -20, belum cukup, dan harga naik", () => {
  assert.equal(bidaskDoubleStepLevel(-9.9, 10), 0);
  assert.equal(bidaskDoubleStepLevel(-10, 10), 10);
  assert.equal(bidaskDoubleStepLevel(-19.999, 10), 10);
  assert.equal(bidaskDoubleStepLevel(-20, 10), 20);
  assert.equal(bidaskDoubleStepLevel(-45, 10), 40);
  assert.equal(bidaskDoubleStepLevel(5, 10), 0);
  assert.equal(bidaskDoubleStepLevel(0, 10), 0);
});

test("tiap posisi punya acuan entry sendiri", () => {
  const now = 0.85;
  const mainDrop = poolPriceChangePct(1, now);
  const dcaDrop = poolPriceChangePct(0.9, now);
  assert.equal(bidaskDoubleStepLevel(mainDrop, 10), 10);
  assert.equal(bidaskDoubleStepLevel(dcaDrop, 10), 0);
});

test("trigger step, cooldown, dan step berikutnya per posisi", () => {
  const hit = evaluateBidaskDoubleRebalance({
    pos,
    tracked: tracked(),
    cfg,
    priceChangePct: -10,
    now: 1_000_000,
  });
  assert.equal(hit.action, "rebalance");
  assert.equal(hit.stepLevel, 10);

  const mid = evaluateBidaskDoubleRebalance({
    pos,
    tracked: tracked({ lastBidaskDoubleRebalancePct: 10, lastBidaskDoubleRebalanceAt: 1_000_000 }),
    cfg,
    priceChangePct: -15,
    now: 1_070_000,
  });
  assert.equal(mid.action, "none");
  assert.equal(mid.reason, "below_next_step");

  const cooled = evaluateBidaskDoubleRebalance({
    pos,
    tracked: tracked({ lastBidaskDoubleRebalancePct: 10, lastBidaskDoubleRebalanceAt: 1_000_000 }),
    cfg,
    priceChangePct: -20,
    now: 1_010_000,
  });
  assert.equal(cooled.action, "cooldown");

  const next = evaluateBidaskDoubleRebalance({
    pos,
    tracked: tracked({ lastBidaskDoubleRebalancePct: 10, lastBidaskDoubleRebalanceAt: 1_000_000 }),
    cfg,
    priceChangePct: -20,
    now: 1_070_000,
  });
  assert.equal(next.action, "rebalance");
  assert.equal(next.stepLevel, 20);

  const other = evaluateBidaskDoubleRebalance({
    pos: { ...pos, position: "dca1" },
    tracked: tracked({ position: "dca1", entryPoolPrice: 0.5, lastBidaskDoubleRebalancePct: 0 }),
    cfg,
    priceChangePct: poolPriceChangePct(0.5, 0.4),
    now: 1_070_000,
  });
  assert.equal(other.action, "rebalance");
  assert.equal(other.stepLevel, 20);
});

test("saling kunci: rebalance tidak jalan saat konfirmasi DCA pending, pool sibuk, atau sedang ditutup", () => {
  const deep = { pos, tracked: tracked(), cfg, priceChangePct: -50, now: 5_000_000 };
  assert.equal(evaluateBidaskDoubleRebalance({ ...deep, dcaConfirmPending: true }).reason, "dca_confirm_pending");
  assert.equal(evaluateBidaskDoubleRebalance({ ...deep, entryInProgress: true }).reason, "entry_in_progress");
  assert.equal(evaluateBidaskDoubleRebalance({ ...deep, poolClosing: true }).reason, "pool_closing");
  assert.equal(evaluateBidaskDoubleRebalance(deep).action, "rebalance");
});

test("tanpa harga entry, fitur mati, atau bukan bidask:double → tidak rebalance", () => {
  assert.equal(
    evaluateBidaskDoubleRebalance({
      pos,
      tracked: tracked({ entryPoolPrice: null }),
      cfg,
      priceChangePct: -40,
    }).reason,
    "no_entry_price"
  );
  assert.equal(
    evaluateBidaskDoubleRebalance({ pos, tracked: tracked(), cfg, priceChangePct: null }).reason,
    "no_pool_price"
  );
  assert.equal(
    evaluateBidaskDoubleRebalance({ pos, tracked: tracked(), cfg: { ...cfg, enabled: false }, priceChangePct: -40 })
      .reason,
    "disabled"
  );
  assert.equal(
    evaluateBidaskDoubleRebalance({
      pos: { ...pos, mode: "spot" },
      tracked: tracked(),
      cfg,
      priceChangePct: -40,
    }).reason,
    "not_bidask_double"
  );
});

test("bin token yang dibentuk ulang: di atas active, atau seluruh range bila harga di bawah range", () => {
  assert.deepEqual(tokenSideBinsForBidaskRebalance(100, 80, 140), { fromBinId: 101, toBinId: 140 });
  assert.deepEqual(tokenSideBinsForBidaskRebalance(70, 80, 140), { fromBinId: 80, toBinId: 140 });
  assert.equal(tokenSideBinsForBidaskRebalance(140, 80, 140), null);
  assert.equal(tokenSideBinsForBidaskRebalance(150, 80, 140), null);
});
