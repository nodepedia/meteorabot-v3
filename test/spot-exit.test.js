import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-spot-"));
process.env.STATE_FILE = path.join(TMP, "state.json");

const { trackPosition, getTrackedPosition, recordTrackedRange } = await import("../src/state/positions.js");
const { evaluateExit, isExitWarmup } = await import("../src/exit/rules.js");
const { fallbackBinRange } = await import("../src/meteora/open-token-position.js");
const { setLastSpotReentryAt, clearSpotReentryCooldown, getEffectiveSpotReentryCooldownSec } = await import("../src/exit/spot-reentry.js");
const config = (await import("../src/config/index.js")).default;

const POOL = "PoolSpot1111111111111111111111111111111111";
const POS = "PosSpot11111111111111111111111111111111111";

const LOWER = 100;
const UPPER = 300;

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

function makePosition(activeBin, overrides = {}) {
  return {
    position: POS,
    pool: POOL,
    mode: "spot",
    activeBin,
    lowerBin: LOWER,
    upperBin: UPPER,
    pnlPct: 0,
    baseMint: "mint",
    xIsSol: false,
    hasX: true,
    hasY: false,
    ...overrides,
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

test("isExitWarmup: aktif di bawah ambang, berhenti tepat di ambang", () => {
  const now = 1_700_000_000_000;
  assert.equal(isExitWarmup(now, 30, now), true);
  assert.equal(isExitWarmup(now - 29 * 60000, 30, now), true);
  assert.equal(isExitWarmup(now - 30 * 60000, 30, now), false);
  assert.equal(isExitWarmup(now - 31 * 60000, 30, now), false);
});

test("isExitWarmup: nonaktif bila menit 0 atau data tidak valid", () => {
  const now = 1_700_000_000_000;
  assert.equal(isExitWarmup(now, 0, now), false);
  assert.equal(isExitWarmup(null, 30, now), false);
  assert.equal(isExitWarmup(undefined, 30, now), false);
});

test("warmup spot: sinyal indikator tidak di-arm selama warmup", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const res = evaluateExit(makePosition(LOWER + 10), null, { warmup: true });
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "warmup");
});

test("warmup spot: OOR kiri tetap menutup saat warmup", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const res = evaluateExit(makePosition(LOWER - 1), null, { warmup: true });
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kiri");
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

test("yield rendah spot: timer lalu close setelah delay", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;
  const delay = config.spot.lowYieldDelayMinutes;
  assert.ok(pct > 0 && delay > 0, "spot harus punya aturan yield rendah");

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: 0 }), null);
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^low_yield_/);
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  // Simulasi sudah lewat masa tunggu.
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].lowYieldSejak = Date.now() - (delay + 1) * 60000;
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: 0 }), null);
  assert.equal(res.action, "close");
  assert.equal(res.reason, "low_yield");
});

test("yield rendah spot: yield naik membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1 }), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct + 5 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});

test("yield rendah spot: PnL minus atau data kosong tidak memicu", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1, pnlPct: -1 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER + 10, { feePct24h: null, pnlPct: 0 }), null);
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});

test("yield rendah spot: keluar range membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const pct = config.spot.lowYieldClosePct;

  let res = evaluateExit(makePosition(LOWER + 10, { feePct24h: pct - 1 }), null);
  assert.equal(res.action, "hold");
  assert.notEqual(getTrackedPosition(POS).lowYieldSejak, null);

  res = evaluateExit(makePosition(LOWER - 1, { feePct24h: pct - 1 }), null);
  assert.equal(res.reason, "oor_kiri");
  assert.equal(getTrackedPosition(POS).lowYieldSejak, null);
});

test("OOR kanan spot di bin kosong atas (activeBin > maxFilledBin tapi <= upperBin): timer 2m lalu close oor_kanan", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");
  const minutes = config.spot.oorKananMinutes;
  assert.equal(minutes, 2);

  // Posisi dibuka [-95%..+15%] -> lowerBin=100, upperBin=315, tapi SOL hanya di [100..300] (maxFilledBin=300).
  // Harga naik ke bin 301 (di dalam bin kosong 301..315) -> langsung dianggap OOR kanan!
  let res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, hasX: false, hasY: true }),
    null
  );
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "oor_kanan_0m");
  assert.notEqual(getTrackedPosition(POS).oorSejak, null);

  // Simulasi sudah lewat 2 menit masa tunggu OOR kanan.
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].oorSejak = Date.now() - (minutes + 0.1) * 60000;
  state.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, hasX: false, hasY: true }),
    null
  );
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");
});

test("OOR kanan spot di bin kosong atas: turun kembali ke <= maxFilledBin membatalkan timer", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  // Masuk bin kosong (302 > maxFilledBin 300)
  let res = evaluateExit(
    makePosition(302, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, hasX: false, hasY: true }),
    null
  );
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_/);
  assert.notEqual(getTrackedPosition(POS).oorSejak, null);

  // Harga turun kembali ke 300 (<= maxFilledBin) -> in-range, timer OOR kanan direset!
  res = evaluateExit(
    makePosition(300, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, hasX: false, hasY: true }),
    null
  );
  assert.notEqual(res.action, "close");
  assert.equal(getTrackedPosition(POS).oorSejak, null);
});

test("Spot dengan bin atas sudah terisi token (maxFilledBin === upperBin setelah rebalance BidAsk): activeBin 305 tetap in-range", () => {
  resetState();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  // Setelah harga sempat turun dan kena rebalance BidAsk, token tersebar sampai upperBin (maxFilledBin = 315).
  // Saat harga di 305 (<= 315), bin tidak kosong dan sedang dapat fee -> TIDAK boleh memicu oor_kanan.
  const res = evaluateExit(
    makePosition(305, { lowerBin: 100, upperBin: 315, maxFilledBin: 315, hasX: true, hasY: true }),
    null
  );
  assert.notEqual(res.action, "close");
  assert.doesNotMatch(String(res.reason || ""), /^oor_kanan/);
  assert.equal(getTrackedPosition(POS).oorSejak, null);
});

test("OOR kanan spot: volume 5m <= $100k tetap menunggu 2 menit (Hold di 1.5m, Close di 2m)", () => {
  resetState();
  clearSpotReentryCooldown();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  // Volume 5m = $50k (<= $100k) -> timer normal 2 menit
  let res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, volume5m: 50000 }),
    null
  );
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "oor_kanan_0m");

  // Di menit ke-1.5 -> masih hold (belum 2 menit)
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].oorSejak = Date.now() - 1.5 * 60000;
  state.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, volume5m: 50000 }),
    null
  );
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "oor_kanan_1m");

  // Di menit ke-2.1 -> close
  state.positions[POS].oorSejak = Date.now() - 2.1 * 60000;
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, volume5m: 50000 }),
    null
  );
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");
  assert.equal(getEffectiveSpotReentryCooldownSec({ volume5m: 50000 }), 120);
});

test("OOR kanan spot & bin kosong atas: volume 5m > $100k mempercepat reposisi jadi 1 menit (60s timer & cooldown)", () => {
  resetState();
  clearSpotReentryCooldown();
  trackPosition(POS, POOL, "X-SOL", "mint", null, "spot");

  assert.equal(config.spot.oorKananHighVol5mUsd, 100000);
  assert.equal(config.spot.oorKananFastMinutes, 1);
  assert.equal(config.spotReentry.fastCooldownSec, 60);
  assert.equal(getEffectiveSpotReentryCooldownSec({ volume5m: 150000 }), 60);

  // 1. Masuk bin kosong atas (301 > maxFilledBin 300) dengan volume5m = $150k (> $100k)
  let res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, volume5m: 150000 }),
    null
  );
  assert.equal(res.action, "hold");
  assert.equal(res.reason, "oor_kanan_0m");

  // Setelah 1.05 menit -> langsung CLOSE (tidak perlu tunggu 2 menit!)
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state.positions[POS].oorSejak = Date.now() - 1.05 * 60000;
  state.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state));

  res = evaluateExit(
    makePosition(301, { lowerBin: 100, upperBin: 315, maxFilledBin: 300, volume5m: 150000 }),
    null
  );
  assert.equal(res.action, "close");
  assert.equal(res.reason, "oor_kanan");

  // 2. Cooldown per-pool dengan volume > $100k: di detik ke-30 masih cooldown, di detik ke-65 sudah bebas cooldown!
  setLastSpotReentryAt(POOL, Date.now() - 30_000);
  res = evaluateExit(
    makePosition(UPPER + 5, { volume5m: 150000 }),
    null
  );
  assert.equal(res.action, "hold");
  assert.match(res.reason, /^oor_kanan_cooldown_/);

  // Setelah 65 detik (> 60s fastCooldownSec), cooldown sudah selesai untuk high volume (sedangkan volume rendah masih kena cooldown 120s)
  setLastSpotReentryAt(POOL, Date.now() - 65_000);
  const resLowVol = evaluateExit(
    makePosition(UPPER + 5, { volume5m: 50000 }),
    null
  );
  assert.equal(resLowVol.action, "hold");
  assert.match(resLowVol.reason, /^oor_kanan_cooldown_/);

  // Untuk volume > $100k dan timer oorSejak >= 1m -> langsung close oor_kanan!
  const state2 = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  state2.positions[POS].oorSejak = Date.now() - 1.05 * 60000;
  state2.positions[POS].oorArah = "kanan";
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state2));

  const resHighVol = evaluateExit(
    makePosition(UPPER + 5, { volume5m: 150000 }),
    null
  );
  assert.equal(resHighVol.action, "close");
  assert.equal(resHighVol.reason, "oor_kanan");
  clearSpotReentryCooldown();
});
