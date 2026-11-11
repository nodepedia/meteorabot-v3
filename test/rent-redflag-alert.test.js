import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-rent-alert-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");

const { buildSpotNonRefundableSkipMessage, plainTg } = await import("../src/notify/telegram.js");
const { startSpotEntry, resetSpotRentRedflagAlerts } = await import("../src/entry/index.js");
const config = (await import("../src/config/index.js")).default;

// Tes ini mengunci alur redflag lama, tanpa mencari pool lain.
config.spotRentFallbackPool = false;

const POOL = "PoolTaolf11111111111111111111111111111111";
const MINT = "MintTaolf11111111111111111111111111111111";

function redflagResult(extra = {}) {
  return {
    success: false,
    skipped: true,
    redflagNonRefundable: true,
    costsByPct: { "-95": 0.214312, "-90": 0.142875, "-85": 0.142875, "-80": 0.071437 },
    upperPct: 15,
    maxNonRefundableSol: 0,
    pair: "TAOLF-SOL",
    reason: "non-refundable rent masih muncul pada -95%, -90%, -85%, -80%",
    ...extra,
  };
}

test("teks alert: angka yang ada, baris dinonaktifkan hanya bila # berhasil, teks dinamis diratakan", () => {
  assert.equal(plainTg("TAOLF\nSOL\tX"), "TAOLF SOL X");
  const msg = buildSpotNonRefundableSkipMessage({
    pair: "TAOLF-SOL\nmasuk baris palsu",
    pool: POOL,
    sizeSol: 0.1,
    costsByPct: { "-95": 0.214312, "-90": 0.142875, "-85": 0.142875 },
    upperPct: 15,
    maxNonRefundableSol: 0,
    context: "Entry Spot Instan",
    watchDisabled: true,
  });
  assert.match(msg, /^🚨 Entry Spot dibatalkan/);
  assert.match(msg, /^Pair: TAOLF-SOL masuk baris palsu$/m);
  assert.doesNotMatch(msg, /^masuk baris palsu$/m);
  assert.match(msg, new RegExp(`Pool: ${POOL}`));
  assert.match(msg, /Modal: 0\.1 SOL/);
  assert.match(msg, /-95%\.\.\+15%: 0\.214312 SOL/);
  assert.match(msg, /-90%\.\.\+15%: 0\.142875 SOL/);
  assert.match(msg, /-85%\.\.\+15%: 0\.142875 SOL/);
  assert.doesNotMatch(msg, /-80%/);
  assert.match(msg, /Batas sewa non-refundable: 0 SOL/);
  assert.match(msg, /Pool ditandai # dan tidak dipantau lagi\./);

  const hidden = buildSpotNonRefundableSkipMessage({
    pair: "TAOLF-SOL",
    pool: POOL,
    costsByPct: { "-95": 0.214312 },
    watchDisabled: false,
  });
  assert.doesNotMatch(hidden, /ditandai #/);
  assert.doesNotMatch(hidden, /\.\.\+15%/);
});

test("entry: seluruh tangga gagal kirim satu alert dan menandai pool", async () => {
  resetSpotRentRedflagAlerts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-alert-ok-"));
  const poolFile = path.join(dir, "pool.txt");
  fs.writeFileSync(poolFile, `${POOL},1x,1,spot\n`);
  const saved = { dryRun: config.dryRun, file: config.entry.poolListFile };
  config.dryRun = false;
  config.entry.poolListFile = poolFile;
  const alerts = [];
  try {
    const res = await startSpotEntry(
      { pool: POOL, mint: MINT, sizeSol: 0.1, pairName: "TAOLF-SOL", mode: "spot" },
      async () => redflagResult(),
      { notifySpotNonRefundableSkipped: (payload) => alerts.push(payload) }
    );
    assert.equal(res.redflagNonRefundable, true);
    assert.equal(fs.readFileSync(poolFile, "utf8").startsWith("#"), true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].watchDisabled, true);
    assert.equal(alerts[0].sizeSol, 0.1);
    assert.match(buildSpotNonRefundableSkipMessage(alerts[0]), /0\.214312 SOL/);
    assert.match(buildSpotNonRefundableSkipMessage(alerts[0]), /ditandai #/);
  } finally {
    config.dryRun = saved.dryRun;
    config.entry.poolListFile = saved.file;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("entry: alert gagal tidak membatalkan penandaan pool dan tidak dilempar", async () => {
  resetSpotRentRedflagAlerts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-alert-throw-"));
  const poolFile = path.join(dir, "pool.txt");
  const pool = "PoolThrow1111111111111111111111111111111";
  fs.writeFileSync(poolFile, `${pool},1x,1,spot\n`);
  const saved = { dryRun: config.dryRun, file: config.entry.poolListFile };
  config.dryRun = false;
  config.entry.poolListFile = poolFile;
  try {
    const res = await startSpotEntry(
      { pool, mint: MINT, sizeSol: 0.1, pairName: "TAOLF-SOL", mode: "spot" },
      async () => redflagResult(),
      {
        notifySpotNonRefundableSkipped: () => {
          throw new Error("telegram down");
        },
      }
    );
    assert.equal(res.redflagNonRefundable, true);
    assert.equal(fs.readFileSync(poolFile, "utf8").startsWith("#"), true);
  } finally {
    config.dryRun = saved.dryRun;
    config.entry.poolListFile = saved.file;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("entry: sukses, skip lain, atau ulang pool yang sama tidak menambah alert sewa", async () => {
  resetSpotRentRedflagAlerts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-alert-once-"));
  const poolFile = path.join(dir, "pool.txt");
  fs.writeFileSync(poolFile, `${POOL},1x,1,spot\n`);
  const saved = { dryRun: config.dryRun, file: config.entry.poolListFile };
  config.dryRun = false;
  config.entry.poolListFile = poolFile;
  const alerts = [];
  const notify = (payload) => alerts.push(payload);
  try {
    await startSpotEntry(
      { pool: "PoolOk1111111111111111111111111111111111", mint: MINT, sizeSol: 0.1, pairName: "OK-SOL" },
      async () => ({ success: true }),
      { notifySpotNonRefundableSkipped: notify }
    );
    await startSpotEntry(
      {
        pool: "PoolSkip11111111111111111111111111111111",
        mint: "MintSkip1111111111111111111111111111111",
        sizeSol: 0.1,
        pairName: "SKIP-SOL",
      },
      async () => ({ success: false, skipped: true, reason: "bukan sewa" }),
      { notifySpotNonRefundableSkipped: notify }
    );
    assert.equal(alerts.length, 0);

    await startSpotEntry({ pool: POOL, mint: MINT, sizeSol: 0.1, pairName: "TAOLF-SOL" }, async () => redflagResult(), {
      notifySpotNonRefundableSkipped: notify,
    });
    await startSpotEntry({ pool: POOL, mint: MINT, sizeSol: 0.1, pairName: "TAOLF-SOL" }, async () => redflagResult(), {
      notifySpotNonRefundableSkipped: notify,
    });
    assert.equal(alerts.length, 1);
  } finally {
    config.dryRun = saved.dryRun;
    config.entry.poolListFile = saved.file;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
