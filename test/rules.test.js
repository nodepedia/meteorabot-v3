import test from "node:test";
import assert from "node:assert/strict";
import { modeRules, LEGACY_MODE, RULE_DEFAULTS } from "../src/config/rules.js";

test("modeRules falls back to defaults when env is empty", () => {
  const rules = modeRules({}, "FOO");
  assert.equal(rules.enableStopLoss, RULE_DEFAULTS.enableStopLoss);
  assert.equal(rules.trailingDropRatioPct, RULE_DEFAULTS.trailingDropRatioPct);
  assert.equal(rules.trailingDropPct, RULE_DEFAULTS.trailingDropPct);
});

test("modeRules applies prefixed overrides", () => {
  const rules = modeRules({ FOO_ENABLE_STOP_LOSS: "true", FOO_STOP_LOSS_PCT: "-50" }, "FOO");
  assert.equal(rules.enableStopLoss, true);
  assert.equal(rules.stopLossPct, -50);
});

test("modeRules supports per-mode overrides", () => {
  const rules = modeRules({}, "FOO", { trailingTakeProfit: true, trailingTriggerPct: 15 });
  assert.equal(rules.trailingTakeProfit, true);
  assert.equal(rules.trailingTriggerPct, 15);
});

test("LEGACY_MODE maps legacy mode names", () => {
  assert.equal(LEGACY_MODE.bidask, "bidask:double");
  assert.equal(LEGACY_MODE["token-only"], "bidask:token");
  assert.equal(LEGACY_MODE["sol-only"], "bidask:sol");
});
