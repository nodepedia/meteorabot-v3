import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { buildConfig } from "../src/config/index.js";
import { calcSpotTokenBinMetrics, evaluateSpotTokenBidaskTrigger } from "../src/exit/spot-token-bidask.js";

function parseStratConf() {
  const raw = fs.readFileSync(path.resolve("strat.conf"), "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function stripFunctions(obj) {
  return JSON.parse(JSON.stringify(obj));
}

test("config-sync: fallback default di src/config/index.js 100% identik dengan strat.conf", () => {
  const stratEnv = parseStratConf();
  assert.ok(Object.keys(stratEnv).length > 50, "strat.conf harus memiliki seluruh parameter strategi");

  const fromStrat = stripFunctions(buildConfig(stratEnv));
  const fromDefaults = stripFunctions(buildConfig({}));

  assert.deepEqual(
    fromDefaults,
    fromStrat,
    "Ada parameter di strat.conf yang fallback default-nya di src/config/index.js atau src/config/rules.js belum disamakan!"
  );
});

test("config-sync: parameter kembar OOR Kanan & Re-entry Cooldown wajib sinkron (normal & high volume >$100k)", () => {
  const stratEnv = parseStratConf();
  const cfg = buildConfig(stratEnv);

  // Normal OOR kanan timer (2 menit = 120 detik)
  assert.equal(cfg.spot.oorKananMinutes, 2);
  assert.equal(cfg.spotReentry.cooldownSec, 120);
  assert.equal(
    cfg.spot.oorKananMinutes * 60,
    cfg.spotReentry.cooldownSec,
    "SPOT_OOR_KANAN_MINUTES * 60 harus sama persis dengan SPOT_REENTRY_COOLDOWN_SEC"
  );

  // High volume (> $100k / 5m) fast OOR kanan timer (1 menit = 60 detik)
  assert.equal(cfg.spot.oorKananHighVol5mUsd, 100000);
  assert.equal(cfg.spotReentry.highVol5mUsd, 100000);
  assert.equal(
    cfg.spot.oorKananHighVol5mUsd,
    cfg.spotReentry.highVol5mUsd,
    "SPOT_OOR_KANAN_HIGH_VOL_5M_USD harus sinkron antara spot rules dan spotReentry"
  );

  assert.equal(cfg.spot.oorKananFastMinutes, 1);
  assert.equal(cfg.spotReentry.fastCooldownSec, 60);
  assert.equal(
    cfg.spot.oorKananFastMinutes * 60,
    cfg.spotReentry.fastCooldownSec,
    "SPOT_OOR_KANAN_FAST_MINUTES * 60 harus sama persis dengan SPOT_REENTRY_FAST_COOLDOWN_SEC"
  );
});

test("config-sync: default stepPct di calcSpotTokenBinMetrics & evaluateSpotTokenBidaskTrigger sinkron dengan SPOT_TOKEN_BIDASK_STEP_PCT (10%)", () => {
  const stratEnv = parseStratConf();
  const cfg = buildConfig(stratEnv);
  assert.equal(cfg.spotTokenBidask.stepPct, 10);

  // Tanpa argumen stepPct eksplisit, calcSpotTokenBinMetrics wajib memakai default 10% (bukan 15% lama)
  // Range 200 bin (100..300): activeBin 280 -> 20 bin token = 10% -> stepLevel harus 10
  const m10 = calcSpotTokenBinMetrics({ activeBin: 280, lowerBin: 100, upperBin: 300 });
  assert.equal(m10.tokenBinPct, 10);
  assert.equal(m10.stepLevel, 10);

  const trig = evaluateSpotTokenBidaskTrigger({
    pos: { position: "pos1", pool: "pool1", mode: "spot", lowerBin: 100, upperBin: 300, activeBin: 280 },
    tracked: { lastSpotTokenBidaskPct: 0, lastSpotTokenBidaskAt: null },
  });
  assert.equal(trig.action, "rebalance");
  assert.equal(trig.stepLevel, 10);
});
