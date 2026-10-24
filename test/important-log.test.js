import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-important-log-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.IMPORTANT_LOG_FILE = path.join(TMP, "important.log");
process.env.IMPORTANT_EVENTS_FILE = path.join(TMP, "important-events.jsonl");

const {
  formatWibTimestamp,
  recordImportantEvent,
  readImportantEvents,
  resetImportantLogs,
} = await import("../src/core/important-log.js");
const log = (await import("../src/core/logger.js")).default;
const { recordAction, resetRuntimeState } = await import("../src/entry/runtime.js");
const { backfillImportantLogs, buildImportantLogsReport } = await import("../src/tools/important-logs.js");

function resetAll() {
  resetImportantLogs();
  resetRuntimeState();
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
  fs.writeFileSync(process.env.DECISION_LOG_FILE, JSON.stringify([]));
  fs.writeFileSync(process.env.PNL_HISTORY_FILE, JSON.stringify([]));
}

test("recordImportantEvent: menulis format WIB ke important.log dan JSONL ke important-events.jsonl", () => {
  resetAll();
  // 2026-10-24T11:05:12.000Z = 2026-10-24 18:05:12 WIB (UTC+7)
  const ts = Date.UTC(2026, 9, 24, 11, 5, 12);
  assert.equal(formatWibTimestamp(ts), "2026-10-24 18:05:12 WIB");

  const ev1 = recordImportantEvent({
    ts,
    type: "SUCCESS",
    category: "ENTRY",
    message: "ENTRY Moustache-SOL — 0.2 SOL",
  });
  assert.ok(ev1);
  assert.equal(ev1.type, "SUCCESS");
  assert.equal(ev1.actionNeeded, null);

  const ev2 = recordImportantEvent({
    ts: ts + 60_000,
    type: "ERROR",
    category: "ENTRY",
    message: "Pool 7sjam6qS dibatalkan: harga pool menyimpang — dinonaktifkan",
    actionNeeded: "Cek pool.txt jika ingin mengaktifkan ulang",
  });
  assert.ok(ev2);
  assert.equal(ev2.type, "ERROR");

  const logContent = fs.readFileSync(process.env.IMPORTANT_LOG_FILE, "utf8").trim().split("\n");
  assert.equal(logContent.length, 2);
  assert.equal(logContent[0], "[2026-10-24 18:05:12 WIB] [✅ SUKSES] [ENTRY] ENTRY Moustache-SOL — 0.2 SOL");
  assert.equal(
    logContent[1],
    "[2026-10-24 18:06:12 WIB] [❌ ERROR] [ENTRY] Pool 7sjam6qS dibatalkan: harga pool menyimpang — dinonaktifkan | Tindakan: Cek pool.txt jika ingin mengaktifkan ulang"
  );

  const events = readImportantEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].category, "ENTRY");
  assert.equal(events[1].actionNeeded, "Cek pool.txt jika ingin mengaktifkan ulang");
});

test("recordAction: otomatis mencatat log SUKSES dan ERROR beserta kategori dan saran tindakan", () => {
  resetAll();

  recordAction("ENTRY BONK-SOL — 0.15 SOL");
  recordAction("DCA BONK-SOL — tambah 0.15 SOL");
  recordAction("SPOT BIDASK BONK-SOL — step 15% (bin 271→300)");
  recordAction("SPOT SOL REBALANCE BONK-SOL — recover 15%→0% (0.6000 SOL, bin 100→299)");
  recordAction("FALLBACK BONK-SOL — posisi token-only dibuka (5000 token)");
  recordAction("RE-ENTRY BONK-SOL — 0.15 SOL (1/2)");
  recordAction("CLOSE BONK-SOL — profit turun dari puncak (trailing TP) | PnL +4.25%");
  recordAction("SWEEP 1 token yatim → SOL");

  // Aksi gagal / batas tercapai harus tercatat sebagai ERROR
  recordAction("RE-ENTRY BONK-SOL — batas 2x tercapai");
  recordAction("SPOT SOL REBALANCE BONK-SOL GAGAL (recover 30%→15%) — RPC timeout");
  recordAction("FALLBACK BONK-SOL GAGAL — slippage exceeded");

  const events = readImportantEvents();
  assert.equal(events.length, 11);

  const successes = events.filter((e) => e.type === "SUCCESS");
  const errors = events.filter((e) => e.type === "ERROR");
  assert.equal(successes.length, 8);
  assert.equal(errors.length, 3);

  assert.deepEqual(
    successes.map((e) => e.category),
    ["ENTRY", "DCA", "REBALANCE_BIDASK", "REBALANCE_SOL_SPOT", "FALLBACK", "REENTRY", "CLOSE", "SWEEP"]
  );
  assert.deepEqual(
    errors.map((e) => e.category),
    ["REENTRY", "REBALANCE_SOL_SPOT", "FALLBACK"]
  );
  for (const err of errors) {
    assert.ok(err.actionNeeded && err.actionNeeded.length > 10, `actionNeeded harus terisi untuk ${err.category}`);
  }
});

test("log.error & log.warn: otomatis menangkap error dan warning penting, mengabaikan warning biasa, serta deduplikasi", () => {
  resetAll();

  // Warning transient biasa (tidak boleh masuk important.log)
  log.warn("Jupiter price gagal: The operation was aborted due to timeout");
  log.warn("Moustache-SOL: position tidak terbaca (1/5)");
  assert.equal(readImportantEvents().length, 0);

  // Warning penting yang wajib masuk important.log sebagai ERROR + actionNeeded
  log.warn("Pool 7sjam6qS dibatalkan: harga pool menyimpang — dinonaktifkan");
  log.warn("Wallet SOL rendah: 0.0200 SOL < cadangan gas 0.0500 SOL");
  log.warn("Sweep failed for 3w67qwok after 3 attempts — token left unsold");
  log.warn("Swap failed for Moustache-SOL: failed after 3 attempts");

  // Error langsung dari log.error
  log.error("Entry 7sjam6qS dibatalkan: estimasi fee 0.005000 SOL > cap 0.002 SOL (mode priority)");

  // Deduplikasi pesan identik berurutan
  log.error("Entry 7sjam6qS dibatalkan: estimasi fee 0.005000 SOL > cap 0.002 SOL (mode priority)");

  // Deduplikasi pasangan log.error + recordAction pada kegagalan rebalance yang sama
  log.error("Spot Token BidAsk TEST-SOL: gagal re-deposit setelah 3x (RPC down) — kunci dilepas agar bisa di-sweep");
  recordAction("SPOT BIDASK TEST-SOL GAGAL (step 15%) — RPC down");

  const events = readImportantEvents();
  assert.equal(events.length, 6);
  assert.deepEqual(
    events.map((e) => e.category),
    ["ENTRY", "WALLET", "SWEEP", "CLOSE", "ENTRY", "REBALANCE_BIDASK"]
  );
  assert.match(events[1].actionNeeded, /cadangan gas 0\.05 SOL/);
  assert.match(events[2].actionNeeded, /sweep otomatis/);
});

test("backfillImportantLogs & buildImportantLogsReport: idempoten dan menghasilkan laporan terstruktur", () => {
  resetAll();

  const t1 = Date.UTC(2026, 9, 24, 8, 45, 31);
  const t2 = Date.UTC(2026, 9, 24, 9, 22, 20);
  const t3 = Date.UTC(2026, 9, 24, 9, 32, 42);

  fs.writeFileSync(
    process.env.STATE_FILE,
    JSON.stringify({
      positions: {
        PosClosed1111111111111111111111111111111111: {
          position: "PosClosed1111111111111111111111111111111111",
          pool: "PoolMoustache111111111111111111111111111111",
          pair: "Moustache-SOL",
          mode: "spot",
          firstSeenAt: t1,
          lowerBin: -792,
          upperBin: -490,
          binSpan: 302,
          closed: true,
          closedAt: t2,
          closeReason: "not_detected",
          lastPnlPeak: 0.42,
        },
        PosOpen222222222222222222222222222222222222: {
          position: "PosOpen222222222222222222222222222222222222",
          pool: "PoolMoustache111111111111111111111111111111",
          pair: "Moustache-SOL",
          mode: "spot",
          firstSeenAt: t3,
          lowerBin: -784,
          upperBin: -468,
          binSpan: 316,
          closed: false,
          lastPnlPeak: 1.12,
          lastPnlLowest: -0.48,
          lastSpotTokenBidaskPct: 0,
        },
      },
    })
  );

  fs.writeFileSync(
    process.env.DECISION_LOG_FILE,
    JSON.stringify([
      {
        ts: t2,
        position: "PosClosed1111111111111111111111111111111111",
        pool: "PoolMoustache111111111111111111111111111111",
        pair: "Moustache-SOL",
        pnlPct: null,
        closeReason: "not_detected",
        lastPnlPeak: 0.42,
      },
    ])
  );

  fs.writeFileSync(
    process.env.PNL_HISTORY_FILE,
    JSON.stringify([
      { t: t2 - 5000, pos: "PosClosed1111111111111111111111111111111111", pair: "Moustache-SOL", pnl: 0.42 },
      { t: t3 + 10000, pos: "PosOpen222222222222222222222222222222222222", pair: "Moustache-SOL", pnl: 0.88 },
    ])
  );

  const firstRun = backfillImportantLogs({ logDir: TMP });
  assert.equal(firstRun.added, 3);
  assert.equal(firstRun.total, 3);

  // Idempoten saat dijalankan ulang
  const secondRun = backfillImportantLogs({ logDir: TMP });
  assert.equal(secondRun.added, 0);
  assert.equal(secondRun.total, 3);

  const report = buildImportantLogsReport();
  assert.match(report, /STATUS WORKER & RINGKASAN SAAT INI/);
  assert.match(report, /Tidak ada error yang membutuhkan tindakan saat ini/);
  assert.match(report, /LOG SUKSES TERBARU/);
  assert.match(report, /Moustache-SOL/);
});
