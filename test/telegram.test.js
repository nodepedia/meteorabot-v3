import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul state di-import
// agar test tidak menyentuh state.json / decision-log.json produksi.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tg-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { buildCloseMessage, buildStatusMessage, exitLabel, buildSpotReentryAlert, buildSpotReentryFailedMessage } =
  await import("../src/notify/telegram.js");
const { trackPosition, updatePnlPeaks } = await import("../src/state/positions.js");
const { armIndicatorTrailing } = await import("../src/state/trailing.js");

const POOL = "PoolFries111111111111111111111111111111111";
const POS = "PosFries1111111111111111111111111111111111";

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

// --- Closed ---

test("close: template trailing TP lengkap", () => {
  const msg = buildCloseMessage(
    "familiars-SOL",
    "trailing_tp: peak 11.40% -> 9.42%",
    9.42,
    { success: true },
    -3.5,
    11.4
  );
  assert.equal(
    msg,
    [
      "🔒 Closed familiars-SOL",
      "",
      "Trigger Exit    : Trailing TP",
      "Peak            : +11.40%",
      "Drawdown        : -3.50%",
      "",
      "Realized PnL    : +9.42%",
    ].join("\n")
  );
});

test("close: OOR kanan menampilkan Peak dan PnL di bawah", () => {
  const msg = buildCloseMessage("Agency-SOL", "oor_kanan", 0.01, { success: true }, -0.0042, 5.67);
  assert.equal(
    msg,
    [
      "🔒 Closed Agency-SOL",
      "",
      "Trigger Exit    : OOR Kanan",
      "Peak            : +5.67%",
      "Drawdown        : -0.00%",
      "",
      "Realized PnL    : +0.01%",
    ].join("\n")
  );
});

test("close: swap sukses tidak menampilkan baris swap", () => {
  const msg = buildCloseMessage("X-SOL", "stop_loss", -12.3, { success: true }, -15.1, 2);
  assert.doesNotMatch(msg, /Swap/);
});

test("close: swap gagal menampilkan alasan", () => {
  const msg = buildCloseMessage("X-SOL", "stop_loss", -12.3, { success: false, error: "slippage too high" }, -15.1, 2);
  assert.match(msg, /⚠️ Swap GAGAL: slippage too high/);
});

test("close: drawdown null tidak menampilkan baris Drawdown", () => {
  const msg = buildCloseMessage("X-SOL", "oor_kanan", 4, null, null);
  assert.doesNotMatch(msg, /Drawdown/);
});

test("exitLabel menerjemahkan alasan exit ke label pendek", () => {
  assert.equal(exitLabel("trailing_tp: peak 1 -> 2"), "Trailing TP");
  assert.equal(exitLabel("indicator_trailing(rsi_bb): peak 1 -> 2"), "Trailing Indikator");
  assert.equal(exitLabel("stop_loss"), "Stop Loss");
  assert.equal(exitLabel("oor_kanan"), "OOR Kanan");
  assert.equal(exitLabel("oor_kiri"), "OOR Kiri");
  assert.equal(exitLabel("low_yield"), "Yield Rendah");
  assert.equal(exitLabel("high_yield"), "Yield Tinggi");
  assert.equal(exitLabel("bounce_recovery: peak -8 -> -10"), "Bounce Recovery");
  assert.equal(exitLabel("not_detected"), "Tidak Terdeteksi");
});

// --- Status ---

test("status in-range: yield tampil tanpa label In Range / OOR / MC / Vol", () => {
  resetState();
  const msg = buildStatusMessage([
    {
      pair: "familiars-SOL",
      position: "PosNoState",
      ageMinutes: 56,
      pnlPct: 10.36,
      feePct24h: 22.37,
      activeBin: 100,
      lowerBin: 90,
      upperBin: 110,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /Yield: 22\.37%/);
  assert.doesNotMatch(msg, /In Range/);
  assert.doesNotMatch(msg, /OOR/);
  assert.doesNotMatch(msg, /MC:/);
  assert.doesNotMatch(msg, /Vol /);
});

test("status out-of-range: menampilkan tanda OOR", () => {
  resetState();
  const msg = buildStatusMessage([
    {
      pair: "familie-SOL",
      position: "PosNoState",
      ageMinutes: 10,
      pnlPct: 2,
      feePct24h: 5,
      activeBin: 100,
      lowerBin: 80,
      upperBin: 90,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /OOR 🟢/);
});

test("status trailing aktif: menampilkan Trailing, Peak, dan Exit at", () => {
  resetState();
  trackPosition(POS, POOL, "familiars-SOL", "mint", 1, "bidask:double");
  updatePnlPeaks(POS, 11.4);
  armIndicatorTrailing(POS, "rsi_bb", 7);

  const msg = buildStatusMessage([
    {
      pair: "familiars-SOL",
      position: POS,
      ageMinutes: 56,
      pnlPct: 9,
      feePct24h: 22.37,
      activeBin: 100,
      lowerBin: 90,
      upperBin: 110,
      mode: "bidask:double",
    },
  ]);
  assert.match(msg, /Trailing: 🔁/);
  assert.match(msg, /Peak: \+11\.40%/);
  assert.match(msg, /Exit at : [+-]?\d+\.\d{2}%/);
});

const SUCCESS_PAYLOAD = {
  pair: "RUN-SOL",
  pool: "PoolReentry11111111111111111111111111111111",
  oldPosition: "PosLama",
  newPosition: "PosBaru111111111111111111111111111111111",
  sizeSol: 0.3,
  minBin: 719,
  maxBin: 1034,
  span: 315,
  count: 1,
  max: 50,
  txSig: "sigabc123",
  dryRun: false,
  switchedPool: true,
  previousPool: "OldPool111111111111111111111111111111111111",
};

test("re-entry sukses tidak lagi menulis TIDAK dibuka", () => {
  const msg = buildSpotReentryAlert(SUCCESS_PAYLOAD);
  assert.doesNotMatch(msg, /TIDAK dibuka/);
  assert.equal(
    msg,
    [
      "🔁 RE-ENTRY RUN-SOL (1/50)",
      "Size: 0.3 SOL",
      "Range: 719..1034 (span 315)",
      "Pool: PoolReentry11111111111111111111111111111111",
      "Pindah pool: OldPool111111111111111111111111111111111111 → PoolReentry11111111111111111111111111111111",
      "Tx: https://solscan.io/tx/sigabc123",
    ].join("\n")
  );
});

test("re-entry sukses lewat newPosition walau success tidak dikirim", () => {
  const msg = buildSpotReentryAlert({
    pair: "RUN-SOL",
    pool: "Pool111",
    newPosition: "dry-run",
    sizeSol: 0.3,
    minBin: 699,
    maxBin: 1014,
    span: 315,
    count: 2,
    max: 50,
    dryRun: true,
    previousPool: "Pool111",
    switchedPool: false,
  });
  assert.doesNotMatch(msg, /TIDAK dibuka/);
  assert.match(msg, /🔁 RE-ENTRY RUN-SOL \(2\/50\) \[DRY RUN\]/);
  assert.doesNotMatch(msg, /Pindah pool/);
  assert.doesNotMatch(msg, /solscan/);
});

test("re-entry sukses eksplisit success:true tanpa newPosition", () => {
  const msg = buildSpotReentryAlert({
    pair: "RUN-SOL",
    pool: "Pool111",
    success: true,
    sizeSol: 1,
    count: 3,
    max: 50,
    minBin: 1,
    maxBin: 10,
    span: 9,
  });
  assert.doesNotMatch(msg, /TIDAK dibuka/);
  assert.match(msg, /🔁 RE-ENTRY RUN-SOL \(3\/50\)/);
});

test("re-entry gagal menulis alasan dan rantai dihentikan", () => {
  const msg = buildSpotReentryFailedMessage({
    pair: "RUN-SOL",
    pool: "Pool111",
    count: 4,
    max: 50,
    reason: "saldo SOL kurang",
  });
  assert.equal(
    msg,
    [
      "⚠️ RE-ENTRY RUN-SOL TIDAK dibuka (4/50)",
      "Alasan: saldo SOL kurang",
      "Rantai re-entry dihentikan.",
      "Pool: Pool111",
    ].join("\n")
  );
});

test("close OOR kanan spot: baris akan re-entry", () => {
  const msg = buildCloseMessage("RUN-SOL", "oor_kanan", 1.25, null, -0.5, 4, {
    willReenter: true,
    nextCount: 2,
    max: 50,
    mode: "spot",
  });
  assert.match(msg, /Trigger Exit\s+: OOR Kanan/);
  assert.match(msg, /↪️ Akan re-entry \(2\/50\)/);
  assert.doesNotMatch(msg, /Tidak re-entry/);
});

test("close OOR kanan spot yang tidak re-entry menulis alasan singkat", () => {
  const msg = buildCloseMessage("RUN-SOL", "oor_kanan", 0.2, null, null, null, {
    willReenter: false,
    nextCount: 51,
    max: 50,
    mode: "spot",
    skipReason: "max re-entry tercapai",
  });
  assert.match(msg, /↪️ Tidak re-entry: max re-entry tercapai/);
  assert.doesNotMatch(msg, /Akan re-entry/);
});

test("close mode atau alasan lain tidak menambah baris re-entry", () => {
  const stop = buildCloseMessage("RUN-SOL", "stop_loss", -3, null, null, null, {
    willReenter: false,
    mode: "spot",
    skipReason: "max re-entry tercapai",
  });
  assert.doesNotMatch(stop, /re-entry/);

  const bidask = buildCloseMessage("RUN-SOL", "oor_kanan", 1, null, null, null, {
    willReenter: false,
    mode: "bidask:double",
    skipReason: "max re-entry tercapai",
  });
  assert.doesNotMatch(bidask, /re-entry/);

  const plain = buildCloseMessage("Agency-SOL", "oor_kanan", 0.01, { success: true }, -0.0042, 5.67);
  assert.doesNotMatch(plain, /re-entry/);
});
