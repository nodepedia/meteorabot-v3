import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-spotind-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));

const { evaluateExit, indicatorAction } = await import("../src/exit/rules.js");
const config = (await import("../src/config/index.js")).default;
const { buildConfig } = await import("../src/config/index.js");

// Candle naik terus → RSI(2) ~100 & MACD hist > 0 (sinyal rsi_macd). Bar terakhir = berjalan.
const candles = Array.from({ length: 41 }, (_, i) => ({ open: 1.1 ** i, high: 1.1 ** (i + 1), low: 1.1 ** i, close: 1.1 ** (i + 0.9), volume: 1 }));
const pos = (mode, o = {}) => ({ position: `P-${mode}`, pool: "POOL", mode, activeBin: 150, lowerBin: 100, upperBin: 300,
  pnlPct: 1, baseMint: "mint", xIsSol: false, hasX: true, hasY: true, ...o });

test("default SPOT_INDICATOR_EXIT = immediate; nilai tak dikenal → immediate", () => {
  assert.equal(buildConfig({}).spot.indicatorExit, "immediate");
  assert.equal(buildConfig({ SPOT_INDICATOR_EXIT: "TRAILING" }).spot.indicatorExit, "trailing");
  assert.equal(buildConfig({ SPOT_INDICATOR_EXIT: "x" }).spot.indicatorExit, "immediate");
});

test("spot immediate: sinyal indikator → close langsung", () => {
  config.spot.indicatorExit = "immediate";
  const r = evaluateExit(pos("spot"), candles);
  assert.equal(r.action, "close");
  assert.match(r.reason, /^indicator_rsi_(macd|bb)$/);
});

test("spot immediate: warmup tetap menahan sinyal", () => {
  config.spot.indicatorExit = "immediate";
  assert.equal(evaluateExit(pos("spot"), candles, { warmup: true }).action, "hold");
});

test("spot trailing: sinyal indikator → arm trailing (perilaku lama)", () => {
  config.spot.indicatorExit = "trailing";
  const r = evaluateExit(pos("spot"), candles);
  assert.equal(r.action, "arm_indicator_trailing");
  config.spot.indicatorExit = "immediate";
});

test("bidask tidak berubah: tetap arm trailing walau spot=immediate", () => {
  config.spot.indicatorExit = "immediate";
  for (const mode of ["bidask:double", "bidask:token", "bidask:sol"]) {
    const r = evaluateExit(pos(mode, { position: `B-${mode}` }), candles);
    assert.equal(r.action, "arm_indicator_trailing", mode);
  }
  assert.deepEqual(indicatorAction("bidask:double", "rsi_bb", { indicatorExit: "immediate" }), { action: "arm_indicator_trailing", reason: "rsi_bb" });
});
