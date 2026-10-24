import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-workers-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const runtime = await import("../src/entry/runtime.js");
const walletWorker = await import("../src/worker-wallet.js");

test("runtime locks & state sinkron lintas proses (worker-entry <-> worker-exit <-> worker-wallet)", () => {
  runtime.resetRuntimeState();

  // Simulasikan proses terpisah (worker-entry) menulis lock mint, pool, usage, dan aksi
  const childScript = `
    import {
      addEntryInProgressMint,
      addEntryInProgressPool,
      addClosingPool,
      addClosingMint,
      incrementEntryUsage,
      setDcaCooldown,
      recordAction,
      setWatchSnapshot,
    } from "./src/entry/runtime.js";

    addEntryInProgressMint("MintEntryInFlight111");
    addEntryInProgressPool("PoolEntryInFlight222");
    addClosingPool("PoolClosing333");
    addClosingMint("MintClosing444");
    incrementEntryUsage("PoolEntryInFlight222");
    incrementEntryUsage("PoolEntryInFlight222");
    setDcaCooldown("PoolEntryInFlight222", 60000);
    recordAction("ENTRY BONK-SOL — 1 SOL");
    setWatchSnapshot([{ pool: "PoolEntryInFlight222", pairName: "BONK-SOL", mint: "MintEntryInFlight111" }]);
  `;

  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      RUNTIME_STATE_FILE: process.env.RUNTIME_STATE_FILE,
      STATE_FILE: process.env.STATE_FILE,
    },
  });

  // Proses ini (mis. worker-wallet / worker-exit) langsung melihat perubahan dari disk
  assert.equal(runtime.getEntryInProgressMints().has("MintEntryInFlight111"), true);
  assert.equal(runtime.isEntryInProgressPool("PoolEntryInFlight222"), true);
  assert.equal(runtime.isPoolClosing("PoolClosing333"), true);
  assert.equal(runtime.isMintClosing("MintClosing444"), true);
  assert.equal(runtime.getEntryUsage("PoolEntryInFlight222"), 2);
  assert.ok(runtime.getDcaCooldownUntil("PoolEntryInFlight222") > Date.now());
  assert.deepEqual(runtime.takeRecentActions(60_000), ["ENTRY BONK-SOL — 1 SOL"]);
  assert.equal(runtime.getSharedWatchSnapshot().length, 1);
  assert.equal(runtime.getSharedWatchSnapshot()[0].pairName, "BONK-SOL");

  // Hapus lock dari proses ini dan pastikan bersih
  runtime.removeEntryInProgressMint("MintEntryInFlight111");
  runtime.removeEntryInProgressPool("PoolEntryInFlight222");
  runtime.removeClosingPool("PoolClosing333");
  runtime.removeClosingMint("MintClosing444");

  assert.equal(runtime.getEntryInProgressMints().has("MintEntryInFlight111"), false);
  assert.equal(runtime.isEntryInProgressPool("PoolEntryInFlight222"), false);
  assert.equal(runtime.isPoolClosing("PoolClosing333"), false);
  assert.equal(runtime.isMintClosing("MintClosing444"), false);
});

test("runtime lock otomatis kedaluwarsa saat melewati TTL (tahan worker crash)", async () => {
  runtime.resetRuntimeState();
  process.env.RUNTIME_LOCK_TTL_MS = "30";

  try {
    runtime.addEntryInProgressMint("StaleMint999");
    runtime.addClosingPool("StalePool999");
    assert.equal(runtime.getEntryInProgressMints().has("StaleMint999"), true);
    assert.equal(runtime.isPoolClosing("StalePool999"), true);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(runtime.getEntryInProgressMints().has("StaleMint999"), false);
    assert.equal(runtime.isPoolClosing("StalePool999"), false);
  } finally {
    delete process.env.RUNTIME_LOCK_TTL_MS;
    runtime.resetRuntimeState();
  }
});

test("worker-wallet runWalletCycle mencatat status wallet & ringkasan PnL ke runtime state", async () => {
  runtime.resetRuntimeState();
  fs.writeFileSync(
    process.env.STATE_FILE,
    JSON.stringify({
      positions: {
        pos1: { closed: false, pair: "SOL-USDC" },
        pos2: { closed: true, realizedPnlPct: 12.5 },
        pos3: { closed: true, realizedPnlPct: -2.5 },
      },
    })
  );

  const { sweepResult, status } = await walletWorker.runWalletCycle({
    sweepFn: async () => ({ swapped: 1, totalAmount: 42, failedMints: [] }),
    balancesFn: async () => ({
      sol: 2.5,
      tokens: [{ mint: "TokenMint11111111", symbol: "TKN", balance: 100, usd: 5.2 }],
    }),
  });

  assert.equal(sweepResult.swapped, 1);
  assert.equal(status.sol, 2.5);
  assert.equal(status.tokenCount, 1);
  assert.equal(status.lastSweepSwapped, 1);

  const sharedStatus = runtime.getWalletStatus();
  assert.ok(sharedStatus);
  assert.equal(sharedStatus.sol, 2.5);
  assert.equal(sharedStatus.tokenCount, 1);

  const pnlSummary = walletWorker.computeTrackedPnlSummary();
  assert.equal(pnlSummary.openCount, 1);
  assert.equal(pnlSummary.closedCount, 2);
  assert.equal(pnlSummary.wins, 1);
  assert.equal(pnlSummary.losses, 1);
  assert.equal(pnlSummary.avgRealizedPct, 5);
});
