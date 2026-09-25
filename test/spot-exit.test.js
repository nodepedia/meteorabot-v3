import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-spot-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, recordTrackedRange } = await import("../src/state/positions.js");
const { evaluateExit } = await import("../src/exit/rules.js");
const { fallbackBinRange } = await import("../src/meteora/open-token-position.js");
const config = (await import("../src/config/index.js")).default;

const POOL = "PoolSpot1111111111111111111111111111111111";
const POS = "PosSpot11111111111111111111111111111111111";

const LOWER = 100;
const UPPER = 300;

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

function makePosition(activeBin) {
  return {
    position: POS,
    pool: POOL,
    mode: "spot",
    activeBin,
    lowerBin: LOWER,
    upperBin: UPPER,
    pnlPct: 0,
    baseMint: "mint",
  };
}

test("recordTrackedRange mencatat lower/upper/span sekali saja", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  recordTrackedRange(POS, LOWER, UPPER);
  let p = getTrackedPosition(POS);
  assert.equal(p.lowerBin, LOWER);
  assert.equal(p.upperBin, UPPER);
  assert.equal(p.binSpan, UPPER - LOWER);

  // Panggilan kedua tidak menimpa.
  recordTrackedRange(POS, 500, 700);
  p = getTrackedPosition(POS);
  assert.equal(p.lowerBin, LOWER);
  assert.equal(p.binSpan, UPPER - LOWER);
});

test("OOR kanan spot: tunggu dulu, tutup setelah lewat masa tunggu", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const minutes = config.spot.oorKananMinutes;
  assert.ok(minutes > 0, "mode spot harus punya masa tunggu OOR kanan");

  // Di atas range -> hold, timer mulai.
  let res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);

  // Simulasi sudah lewat masa tunggu.
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].oorSejak = Date.now() - (minutes + 1) * 60000;
  state.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");
});

test("OOR kanan spot: masuk range lagi membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  let res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).oorSejak, null);

  // Kembali in-range -> timer direset.
  res = evaluateExit(makePosition(UPPER), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).oorSejak, null);

  // OOR lagi -> timer mulai dari nol (hold, bukan close).
  res = evaluateExit(makePosition(UPPER + 1), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);
});

test("OOR kiri spot: tutup langsung (masa tunggu 0)", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  assert.equal(config.spot.enableOOR, true);
  assert.equal(config.spot.oorKiriMinutes, 0);

  const res = evaluateExit(makePosition(LOWER - 1), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kiri");
});

test("fallbackBinRange menghitung batas bin satu-sisi", () => {
  assert.deepEqual(fallbackBinRange(1000, 0, 70), { minBinId: 1000, maxBinId: 1070 });
  assert.deepEqual(fallbackBinRange(1000, 5, 0), { minBinId: 995, maxBinId: 1000 });
});
