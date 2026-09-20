import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-dca-state-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition } = await import("../src/state/positions.js");
const {
  setDcaArmedAndTrough,
  queueDcaRebound,
  resolvePendingDca,
  markDcaTriggered,
  clearDcaTriggered,
  clearDcaState,
  getPoolDcaCount,
  incrementPoolDca,
  decrementPoolDca,
  resetStaleDcaPools,
} = await import("../src/state/dca.js");

const POOL = "PoolDca1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

let seq = 0;
function newPos() {
  const addr = `PosDca000000000000000000000000000000000${seq++}`;
  trackPosition(addr, POOL, "TEST-SOL", "mint", 0, "bidask:double");
  return addr;
}

test("arm + trail menyimpan trough terdalam", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -10);
  assert.equal(getTrackedPosition(p).dcaTrough, -10);
  setDcaArmedAndTrough(p, -12);
  assert.equal(getTrackedPosition(p).dcaTrough, -12);
  setDcaArmedAndTrough(p, -11);
  assert.equal(getTrackedPosition(p).dcaTrough, -12, "trough tidak boleh naik");
});

test("konfirmasi rebound bertahan -> confirmed & pending dibersihkan", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);
  assert.equal(getTrackedPosition(p).pendingDcaTrough, -12);

  const r = resolvePendingDca(p, -11, 1);
  assert.equal(r.confirmed, true);
  assert.equal(getTrackedPosition(p).pendingDcaTrough, null);
});

test("konfirmasi rebound gagal -> rejected & trough diperbarui lebih dalam", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);

  const r = resolvePendingDca(p, -13, 1);
  assert.equal(r.rejected, true);
  assert.equal(getTrackedPosition(p).dcaTrough, -13);
});

test("markDcaTriggered / clearDcaTriggered", () => {
  resetState();
  const p = newPos();
  markDcaTriggered(p);
  assert.equal(getTrackedPosition(p).dcaTriggered, true);
  clearDcaTriggered(p);
  assert.equal(getTrackedPosition(p).dcaTriggered, false);
});

test("counter sesi naik, decrement saat gagal, reset saat sesi berakhir", () => {
  resetState();
  assert.equal(getPoolDcaCount(POOL), 0);

  incrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 1);
  incrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 2);

  decrementPoolDca(POOL);
  assert.equal(getPoolDcaCount(POOL), 1);

  // Tidak ada pool aktif -> sesi berakhir -> reset.
  resetStaleDcaPools(new Set());
  assert.equal(getPoolDcaCount(POOL), 0);
});

test("resetStaleDcaPools hanya mereset pool yang tidak aktif", () => {
  resetState();
  incrementPoolDca(POOL);
  incrementPoolDca("OtherPool");

  resetStaleDcaPools(new Set([POOL]));
  assert.equal(getPoolDcaCount(POOL), 1, "pool aktif harus dipertahankan");
  assert.equal(getPoolDcaCount("OtherPool"), 0, "pool tidak aktif direset");
});

test("counter persisten (dibaca ulang dari file, tahan restart)", () => {
  resetState();
  incrementPoolDca(POOL);
  // getPoolDcaCount membaca file setiap panggilan -> setara baca ulang saat restart.
  assert.equal(getPoolDcaCount(POOL), 1);
});

test("clearDcaState mereset seluruh field DCA posisi", () => {
  resetState();
  const p = newPos();
  setDcaArmedAndTrough(p, -12);
  queueDcaRebound(p, -12, -11);
  markDcaTriggered(p);

  clearDcaState(p);
  const t = getTrackedPosition(p);
  assert.equal(t.dcaArmed, false);
  assert.equal(t.dcaTrough, null);
  assert.equal(t.dcaTriggered, false);
  assert.equal(t.pendingDcaTrough, null);
});
