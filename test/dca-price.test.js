import test from "node:test";
import assert from "node:assert/strict";
import {
  poolPriceChangePct,
  mainPositionEntryPoolPrice,
  effectiveDcaPriceArmPct,
  evaluateDcaForTrigger,
  dcaExecutionBlocked,
} from "../src/state/dca.js";

const cfg = {
  enabled: true,
  armPct: -10,
  armPct2: -30,
  armPricePct: -20,
  armPricePct2: -35,
  reboundPct: 1,
  priceConfirm: true,
};

const tracked = (extra = {}) => ({ position: "main", closed: false, dcaArmed: false, dcaTrough: null, ...extra });

test("poolPriceChangePct: turun 30% dan nilai rusak", () => {
  assert.equal(poolPriceChangePct(2, 1), -50);
  assert.ok(Math.abs(poolPriceChangePct(1, 0.7) - -30) < 1e-9);
  assert.equal(poolPriceChangePct(0, 1), null);
  assert.equal(poolPriceChangePct(1, 0), null);
  assert.equal(poolPriceChangePct(null, 1), null);
});

test("acuan harga = posisi utama, bukan posisi DCA", () => {
  const list = [
    { position: "dca1", isDca: true, closed: false, entryPoolPrice: 0.2 },
    { position: "main", isDca: false, closed: false, entryPoolPrice: 1 },
  ];
  assert.equal(mainPositionEntryPoolPrice(list).entryPoolPrice, 1);
  assert.equal(mainPositionEntryPoolPrice(list).position, "main");
  assert.equal(mainPositionEntryPoolPrice([{ position: "dca1", isDca: true, entryPoolPrice: 0.2 }]), null);
  const closedMain = [
    { position: "main", isDca: false, closed: true, entryPoolPrice: 1.5 },
    { position: "dca1", isDca: true, closed: false, entryPoolPrice: 0.4 },
  ];
  assert.equal(mainPositionEntryPoolPrice(closedMain).entryPoolPrice, 1.5);
});

test("ambang harga: DCA#2 selalu dari acuan yang sama, abaikan DCA#1 masih terbuka", () => {
  assert.equal(effectiveDcaPriceArmPct(0, cfg), -20);
  assert.equal(effectiveDcaPriceArmPct(1, cfg), -35);
  assert.equal(effectiveDcaPriceArmPct(2, cfg), -35);
});

test("mode price: arm -20, trail, rebound 1 poin harga — PnL tidak ikut", () => {
  const base = {
    triggerMode: "price",
    entryPoolPrice: 100,
    count: 0,
    dcaOpen: true,
    cfg,
    tracked: tracked(),
  };
  const shallow = evaluateDcaForTrigger({ ...base, nowPrice: 85, pnlPct: -90 });
  assert.equal(shallow.action, "noop");
  assert.equal(shallow.reason, "not_armed");
  assert.equal(shallow.mode, "price");
  assert.equal(shallow.priceConfirm, false);

  const armed = evaluateDcaForTrigger({ ...base, nowPrice: 80, pnlPct: 5 });
  assert.equal(armed.action, "arm");
  assert.equal(armed.trough, -20);

  const deeper = evaluateDcaForTrigger({
    ...base,
    nowPrice: 60,
    pnlPct: -1,
    tracked: tracked({ dcaArmed: true, dcaTrough: -20, dcaMetric: "price" }),
  });
  assert.equal(deeper.action, "trail");
  assert.equal(deeper.trough, -40);

  // Trough -40 (harga 60). Naik 1 poin harga = perubahan -39 (harga 61) → rebound.
  const rebound = evaluateDcaForTrigger({
    ...base,
    entryPoolPrice: 100,
    nowPrice: 61,
    pnlPct: -99,
    tracked: tracked({ dcaArmed: true, dcaTrough: -40, dcaMetric: "price" }),
  });
  assert.equal(rebound.action, "queue_rebound");
  assert.equal(rebound.rebound, 1);

  const hold = evaluateDcaForTrigger({
    ...base,
    entryPoolPrice: 100,
    nowPrice: 60.5,
    pnlPct: 40,
    tracked: tracked({ dcaArmed: true, dcaTrough: -40, dcaMetric: "price" }),
  });
  assert.equal(hold.action, "hold");
  assert.ok(hold.rebound < 1);
});

test("mode price: DCA#2 butuh -35 dari entry utama walau DCA#1 masih terbuka", () => {
  const mid = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 100,
    nowPrice: 70,
    pnlPct: -50,
    count: 1,
    dcaOpen: true,
    cfg,
    tracked: tracked({ position: "dca1", isDca: true }),
  });
  assert.equal(mid.action, "noop");
  assert.equal(mid.armPct, -35);
  assert.equal(mid.reason, "not_armed");

  const deep = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 100,
    nowPrice: 65,
    pnlPct: -1,
    count: 1,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(deep.action, "arm");
  assert.equal(deep.armPct, -35);
  assert.ok(deep.metric <= -35);
});

test("mode price: PnL yang berubah tidak menggeser keputusan (rebalance tidak memicu DCA)", () => {
  const a = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 1,
    nowPrice: 0.68,
    pnlPct: -4,
    count: 0,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  const b = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 1,
    nowPrice: 0.68,
    pnlPct: -80,
    count: 0,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(a.action, b.action);
  assert.equal(a.reason, b.reason);
  assert.equal(a.metric, b.metric);
});

test("mode price tanpa entryPoolPrice jatuh ke pnl, termasuk aturan DCA#1 masih terbuka", () => {
  const open = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: null,
    nowPrice: 0.5,
    pnlPct: -10,
    count: 1,
    dcaOpen: true,
    cfg,
    tracked: tracked(),
  });
  assert.equal(open.mode, "pnl");
  assert.equal(open.fallback, "missing_entry_pool_price");
  assert.equal(open.action, "arm");
  assert.equal(open.armPct, -10);
  assert.equal(open.priceConfirm, true);

  const closed = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: null,
    nowPrice: 0.5,
    pnlPct: -20,
    count: 1,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(closed.action, "noop");
  assert.equal(closed.armPct, -30);
});

test("mode pnl tidak berubah: arm -10, DCA#2 -30 hanya saat DCA#1 sudah close, price confirm nyala", () => {
  const first = evaluateDcaForTrigger({
    triggerMode: "pnl",
    entryPoolPrice: 1,
    nowPrice: 0.2,
    pnlPct: -10,
    count: 0,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(first.mode, "pnl");
  assert.equal(first.action, "arm");
  assert.equal(first.trough, -10);
  assert.equal(first.priceConfirm, true);
  assert.equal(first.fallback, null);

  const secondOpen = evaluateDcaForTrigger({
    triggerMode: "pnl",
    pnlPct: -10,
    count: 1,
    dcaOpen: true,
    cfg,
    tracked: tracked({ dcaArmed: false }),
  });
  assert.equal(secondOpen.armPct, -10);

  const secondClosed = evaluateDcaForTrigger({
    triggerMode: "pnl",
    pnlPct: -30,
    count: 1,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(secondClosed.action, "arm");
  assert.equal(secondClosed.armPct, -30);
});

test("trough PnL lama tidak dipakai saat mode price (hindari rebound palsu)", () => {
  const d = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 1,
    nowPrice: 0.65,
    pnlPct: -80,
    count: 0,
    dcaOpen: false,
    cfg,
    tracked: tracked({ dcaArmed: true, dcaTrough: -80, dcaMetric: "pnl" }),
  });
  assert.equal(d.action, "arm");
  assert.ok(Math.abs(d.trough - d.metric) < 1e-9);
  assert.notEqual(d.action, "queue_rebound");
});

test("harga pool tidak terbaca → skip, jangan jatuh ke pnl", () => {
  const d = evaluateDcaForTrigger({
    triggerMode: "price",
    entryPoolPrice: 1,
    nowPrice: null,
    pnlPct: -90,
    count: 0,
    dcaOpen: false,
    cfg,
    tracked: tracked(),
  });
  assert.equal(d.action, "noop");
  assert.equal(d.reason, "no_pool_price");
  assert.equal(d.skip, true);
});

test("eksekusi DCA tertahan saat pool sedang dipakai (rebalance/entry) atau sedang ditutup", () => {
  assert.equal(dcaExecutionBlocked({ entryInProgress: true }).blocked, true);
  assert.equal(dcaExecutionBlocked({ entryInProgress: true }).reason, "entry_in_progress");
  assert.equal(dcaExecutionBlocked({ poolClosing: true }).reason, "pool_closing");
  assert.equal(dcaExecutionBlocked({}).blocked, false);
});
