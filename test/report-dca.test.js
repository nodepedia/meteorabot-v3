import test from "node:test";
import assert from "node:assert/strict";
process.env.TELEGRAM_BOT_TOKEN = "";
const { default: config } = await import("../src/config/index.js");
const { buildSummaryBlock } = await import("../src/core/report.js");
const { isDcaApplicable } = await import("../src/entry/dca.js");
const { buildDcaLines } = await import("../src/exit/index.js");

const pos = [{ position: "S1", pool: "PS", pnlPct: -1.88 }, { position: "B1", pool: "PB", pnlPct: -2 }];
const tracked = { S1: { mode: "spot", pair: "Impeach-SOL" }, B1: { mode: "bidask:double", pair: "Foo-SOL" } };

test("isDcaApplicable: spot tidak pernah, bidask:double ya, DCA nonaktif → tidak", () => {
  const cfg = { ...config.dca, enabled: true, eligibleModes: ["bidask:double"] };
  assert.equal(isDcaApplicable({ mode: "spot" }, cfg), false);
  assert.equal(isDcaApplicable({ mode: "spot:double" }, cfg), false);
  assert.equal(isDcaApplicable({ mode: "bidask:double" }, { ...cfg, enabled: false }), false);
  assert.equal(isDcaApplicable(null, cfg), false);
});

test("buildDcaLines: posisi spot tidak masuk ▸ DCA", () => {
  const saved = { ...config.dca };
  Object.assign(config.dca, { enabled: true, eligibleModes: ["bidask:double"] });
  try {
    assert.deepEqual(buildDcaLines([pos[0]], (id) => tracked[id]), []);
    const lines = buildDcaLines(pos, (id) => tracked[id]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Foo-SOL/);
  } finally {
    Object.assign(config.dca, saved);
  }
});

test("ringkasan: section DCA & klaim DCA di 'Kerja' hilang kalau hanya spot", () => {
  const b = buildSummaryBlock({ mode: "LIVE", positions: [{ pair: "Impeach-SOL", pnlPct: -1.88 }], dcaLines: [] });
  assert.doesNotMatch(b, /▸ DCA/);
  assert.match(b, /Kerja   : pantau tren → cari titik masuk → atur exit\n/);
  const b2 = buildSummaryBlock({ mode: "LIVE", dcaLines: ["Foo-SOL : belum menyentuh -10%"] });
  assert.match(b2, /▸ DCA\n  • Foo-SOL/);
  assert.match(b2, /→ DCA saat posisi turun/);
});
