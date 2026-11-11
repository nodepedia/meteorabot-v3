import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-prot-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.IMPORTANT_LOG_FILE = path.join(TMP, "important.log");

const config = (await import("../src/config/index.js")).default;
// Jangan pernah kirim Telegram dari test (telegram.js membaca token saat import).
config.telegramBotToken = "";
config.telegramChatId = "";
const runtime = await import("../src/entry/runtime.js");
const { getProtectedMints, resetProtectionCache, ProtectionUnavailableError } = await import("../src/exit/protection.js");
const { runSafetySweep, resetSweepState } = await import("../src/exit/sweep.js");
const { sweepToSol } = await import("../src/solana/swap.js");
const { getTokenBalanceStrict, listWalletTokenBalances } = await import("../src/solana/balances.js");
const { swapMintsToSol, enqueuePendingSwap, processPendingSwaps } = await import("../src/exit/pending-swaps.js");
const { handleClose } = await import("../src/exit/close.js");
const { rewardMintsOf } = await import("../src/meteora/close.js");
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, WSOL_MINT } = await import("../src/core/constants.js");

config.dryRun = false;
config.swap.autoSwapAfterClose = true;
config.swap.dustUsdThreshold = 0.5;

const mk = () => Keypair.generate().publicKey.toString();
const BASE = mk();
const REWARD = mk();
const OTHER = mk();
const T22 = mk();

function reset({ positions = {} } = {}) {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions }));
  runtime.resetRuntimeState();
  resetProtectionCache();
  resetSweepState();
}
const noChain = async () => [];
const prot = (extra = {}) => (opts = {}) => getProtectedMints({ ...opts, deps: { fetchOnchain: noChain, ...extra } });

// ---------- proteksi ----------

test("proteksi: USDC/WSOL selalu dilindungi, mint bebas tidak", async () => {
  reset();
  const m = await prot()();
  assert.ok(m.has(USDC_MINT));
  assert.ok(m.has(WSOL_MINT));
  assert.ok(!m.has(OTHER));
});

test("proteksi: reentry OOR kanan sedang berjalan → mint dilindungi, lalu dilepas", async () => {
  reset();
  runtime.protectMint(BASE, "oor_kanan_reentry");
  assert.deepEqual([...(await prot()()).get(BASE)], ["oor_kanan_reentry"]);
  runtime.releaseMint(BASE, "oor_kanan_reentry");
  assert.ok(!(await prot()()).has(BASE));
});

test("proteksi: fallback OOR kiri & entry in-flight dilindungi", async () => {
  reset();
  runtime.protectMint(BASE, "oor_kiri_fallback");
  runtime.addEntryInProgressMint(OTHER);
  const m = await prot()();
  assert.ok(m.get(BASE).has("oor_kiri_fallback"));
  assert.ok(m.get(OTHER).has("in_progress"));
});

test("proteksi: mint posisi aktif (state & on-chain) dilindungi; posisi yang sedang ditutup diabaikan", async () => {
  reset({ positions: { P1: { position: "P1", pool: "POOL", baseMint: BASE, closed: false } } });
  const chain = async () => [{ position: "P2", pool: "POOL2", mints: [OTHER, WSOL_MINT] }];
  const m = await prot({ fetchOnchain: chain })();
  assert.ok(m.get(BASE).has("open_position_state"));
  assert.ok(m.get(OTHER).has("open_position_onchain"));
  const ign = await prot({ fetchOnchain: chain })({ ignorePositions: ["P1", "P2"] });
  assert.ok(!ign.has(BASE));
  assert.ok(!ign.has(OTHER));
});

test("proteksi fail closed: state rusak / runtime rusak / RPC on-chain gagal → throw", async () => {
  reset();
  fs.writeFileSync(process.env.STATE_FILE, "{rusak");
  await assert.rejects(prot()(), ProtectionUnavailableError);
  reset();
  fs.writeFileSync(process.env.RUNTIME_STATE_FILE, "{rusak");
  await assert.rejects(prot()(), ProtectionUnavailableError);
  reset();
  await assert.rejects(prot({ fetchOnchain: async () => { throw new Error("rpc 429"); } })(), ProtectionUnavailableError);
  await assert.rejects(prot({ fetchOnchain: async () => null })({ useCache: false }), ProtectionUnavailableError);
});

// ---------- sweep ----------

function fakeSweep(balances, swapped) {
  return (opts) =>
    sweepToSol({
      ...opts,
      listBalances: async () => balances,
      valueFn: async () => 10,
      balanceFn: async () => 0,
      sleepFn: async () => {},
      swapFn: async (mint, amt) => {
        swapped.push(mint);
        return { success: true };
      },
    });
}

test("sweep: Token-2022 di-sweep bila tidak dilindungi; mint dilindungi dilewati", async () => {
  reset();
  runtime.protectMint(BASE, "oor_kanan_reentry");
  const swapped = [];
  const balances = [
    { mint: T22, balance: 5, programId: TOKEN_2022_PROGRAM_ID },
    { mint: BASE, balance: 7, programId: TOKEN_PROGRAM_ID },
    { mint: USDC_MINT, balance: 3, programId: TOKEN_PROGRAM_ID },
  ];
  const r = await runSafetySweep({ getProtectedMints: prot(), sweepToSol: fakeSweep(balances, swapped) });
  assert.deepEqual(swapped, [T22]);
  assert.equal(r.swapped, 1);
});

test("sweep: mint fallback OOR kiri & posisi aktif tidak di-swap", async () => {
  reset({ positions: { P1: { position: "P1", baseMint: OTHER, closed: false } } });
  runtime.protectMint(BASE, "oor_kiri_fallback");
  const swapped = [];
  await runSafetySweep({
    getProtectedMints: prot(),
    sweepToSol: fakeSweep([{ mint: BASE, balance: 1 }, { mint: OTHER, balance: 1 }], swapped),
  });
  assert.deepEqual(swapped, []);
});

test("sweep: proteksi muncul di tengah sweep (cek ulang per mint) → tidak di-swap", async () => {
  reset();
  const swapped = [];
  let calls = 0;
  const p = async (opts) => {
    calls++;
    if (calls > 1) runtime.protectMint(BASE, "oor_kanan_reentry");
    return prot()(opts);
  };
  await runSafetySweep({ getProtectedMints: p, sweepToSol: fakeSweep([{ mint: BASE, balance: 1 }], swapped) });
  assert.deepEqual(swapped, []);
});

test("sweep fail closed: proteksi tak terbaca → tidak ada swap", async () => {
  reset();
  let called = false;
  const r = await runSafetySweep({
    getProtectedMints: async () => { throw new ProtectionUnavailableError("state rusak"); },
    sweepToSol: async () => { called = true; return {}; },
  });
  assert.equal(called, false);
  assert.equal(r.failClosed, true);
});

test("sweep: token tanpa harga gagal 3x → berhenti + alert sekali", async () => {
  reset();
  config.swap.failureCooldownSec = 0;
  const alerts = [];
  let swaps = 0;
  const sweepFn = (opts) =>
    sweepToSol({
      ...opts,
      listBalances: async () => [{ mint: OTHER, balance: 9 }],
      valueFn: async () => null,
      balanceFn: async () => 9,
      sleepFn: async () => {},
      swapFn: async () => { swaps++; return { success: false, error: "no route" }; },
    });
  for (let i = 0; i < 5; i++) {
    await runSafetySweep({ getProtectedMints: prot(), sweepToSol: sweepFn, notifySwapGiveUp: (a) => alerts.push(a) });
  }
  assert.equal(alerts.length, 1);
  assert.equal(swaps, 9); // 3 siklus × 3 percobaan, lalu berhenti
  config.swap.failureCooldownSec = 1800;
});

// ---------- saldo ----------

test("getTokenBalanceStrict menjumlah semua token account mint; list mencakup Token-2022", async () => {
  const owner = Keypair.generate();
  const acc = (mint, ui) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount: ui } } } } } });
  const seenPrograms = [];
  const connection = {
    getParsedTokenAccountsByOwner: async (_o, filter) => {
      if (filter.mint) return { value: [acc(BASE, 1.5), acc(BASE, 2.5)] };
      const pid = filter.programId.toString();
      seenPrograms.push(pid);
      return { value: pid === TOKEN_2022_PROGRAM_ID ? [acc(T22, 4)] : [acc(BASE, 1), acc(BASE, 2), acc(WSOL_MINT, 9)] };
    },
  };
  assert.equal(await getTokenBalanceStrict(BASE, { connection, wallet: owner }), 4);
  const list = await listWalletTokenBalances({ connection, wallet: owner });
  assert.deepEqual(seenPrograms.sort(), [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].sort());
  assert.deepEqual(
    list.map((t) => [t.mint, t.balance]).sort(),
    [[BASE, 3], [T22, 4]].sort()
  );
});

test("rewardMintsOf: abaikan slot kosong & WSOL", () => {
  const lbPair = {
    rewardInfos: [{ mint: REWARD }, { mint: "11111111111111111111111111111111" }, { mint: WSOL_MINT }],
  };
  assert.deepEqual(rewardMintsOf(lbPair), [REWARD]);
});

// ---------- close ----------

function closeDeps({ swapResults = {}, protFn = prot(), balances = {} } = {}) {
  const swaps = [];
  const deactivated = [];
  const notices = [];
  return {
    swaps,
    deactivated,
    notices,
    deps: {
      closePosition: async () => ({ success: true, baseMint: BASE, rewardMints: [REWARD] }),
      waitClosedPositionPnl: async () => 1.23,
      deactivatePool: (p) => deactivated.push(p),
      notifyClose: (...a) => notices.push(a),
      swapDeps: {
        getProtectedMints: protFn,
        getTokenBalance: async (m) => balances[m] ?? 10,
        getTokenValueUsd: async () => 5,
        swapToSol: async (m) => {
          swaps.push(m);
          return swapResults[m] ?? { success: true };
        },
      },
    },
  };
}

test("close: base + reward mint di-swap ke SOL, pool dinonaktifkan", async () => {
  reset({ positions: { POS1: { position: "POS1", pool: "POOLA", baseMint: BASE, closed: false } } });
  const c = closeDeps();
  const r = await handleClose({ position: "POS1", pool: "POOLA", baseMint: BASE, pnlPct: 1 }, "stop_loss", { deps: c.deps });
  assert.equal(r.success, true);
  assert.deepEqual(c.swaps.sort(), [BASE, REWARD].sort());
  assert.deepEqual(c.deactivated, ["POOLA"]);
  assert.equal(r.swapPending, false);
});

test("close: swap gagal → swap tertunda, pool BELUM dinonaktifkan; retry sukses → baru dinonaktifkan", async () => {
  reset({ positions: { POS2: { position: "POS2", pool: "POOLB", baseMint: BASE, closed: false } } });
  const c = closeDeps({ swapResults: { [BASE]: { success: false, error: "slippage" } } });
  const r = await handleClose({ position: "POS2", pool: "POOLB", baseMint: BASE, pnlPct: 1 }, "stop_loss", { deps: c.deps });
  assert.equal(r.swapPending, true);
  assert.deepEqual(c.deactivated, []);
  assert.ok(runtime.isMintSwapPending(BASE));
  assert.ok(runtime.isPoolSwapPending("POOLB"));
  assert.ok(!runtime.isMintSwapPending(REWARD));
  const nextAt = runtime.getPendingSwaps()[BASE].nextAt;
  assert.ok(nextAt - Date.now() <= 120_000 && nextAt - Date.now() >= 60_000);

  // Belum jatuh tempo → tidak dicoba.
  const swaps = [];
  const deactivated = [];
  const deps = {
    getProtectedMints: prot(),
    getTokenBalance: async () => 10,
    getTokenValueUsd: async () => 5,
    swapToSol: async (m, _a, o) => { swaps.push([m, o.maxAttempts]); return { success: true }; },
    deactivatePool: (p) => deactivated.push(p),
  };
  await processPendingSwaps({ now: Date.now(), deps });
  assert.equal(swaps.length, 0);
  await processPendingSwaps({ now: nextAt + 1, deps });
  assert.deepEqual(swaps, [[BASE, 1]]);
  assert.deepEqual(deactivated, ["POOLB"]);
  assert.ok(!runtime.isMintSwapPending(BASE));
});

test("close: proteksi tak terbaca → tidak swap (fail closed), masuk swap tertunda", async () => {
  reset({ positions: { POS3: { position: "POS3", pool: "POOLC", baseMint: BASE, closed: false } } });
  const c = closeDeps({ protFn: async () => { throw new ProtectionUnavailableError("rpc"); } });
  const r = await handleClose({ position: "POS3", pool: "POOLC", baseMint: BASE, pnlPct: 1 }, "stop_loss", { deps: c.deps });
  assert.equal(c.swaps.length, 0);
  assert.equal(r.swapPending, true);
  assert.deepEqual(c.deactivated, []);
  assert.ok(runtime.isMintSwapPending(BASE) && runtime.isMintSwapPending(REWARD));
});

test("close OOR kanan (reentry terdaftar) → base TIDAK di-swap, reward bebas tetap di-swap", async () => {
  reset({ positions: { POS4: { position: "POS4", pool: "POOLD", baseMint: BASE, closed: false } } });
  runtime.addEntryInProgressMint(BASE);
  runtime.protectMint(BASE, "oor_kanan_reentry");
  const c = closeDeps();
  const r = await handleClose({ position: "POS4", pool: "POOLD", baseMint: BASE, pnlPct: 1 }, "oor_kanan", {
    deps: c.deps,
    skipDeactivate: true,
  });
  assert.deepEqual(c.swaps, [REWARD]);
  assert.equal(r.swapPending, false);
  assert.deepEqual(r.swapInfo.protected, [BASE]);
});

test("close: mint dipakai posisi aktif lain (mis. DCA/posisi asli) → tidak di-swap", async () => {
  reset({
    positions: {
      POS5: { position: "POS5", pool: "POOLE", baseMint: BASE, closed: false },
      POS6: { position: "POS6", pool: "POOLE", baseMint: BASE, closed: false },
    },
  });
  const c = closeDeps();
  await handleClose({ position: "POS5", pool: "POOLE", baseMint: BASE, pnlPct: 1 }, "trailing_tp", { deps: c.deps });
  assert.deepEqual(c.swaps, [REWARD]);
  assert.deepEqual(c.deactivated, []); // POS6 masih terbuka
});

test("close fallback OOR kiri (skipAutoSwap) → tidak ada swap sama sekali", async () => {
  reset({ positions: { POS7: { position: "POS7", pool: "POOLF", baseMint: BASE, closed: false } } });
  const c = closeDeps();
  await handleClose({ position: "POS7", pool: "POOLF", baseMint: BASE, pnlPct: 1 }, "oor_kiri", {
    deps: c.deps,
    skipAutoSwap: true,
    skipDeactivate: true,
  });
  assert.deepEqual(c.swaps, []);
});

// ---------- swap tertunda: give-up ----------

test("swap tertunda: token tanpa harga gagal 3x → dihentikan + alert, pool dinonaktifkan", async () => {
  reset();
  enqueuePendingSwap({ mint: OTHER, pool: "POOLG", pair: "X-SOL", reason: "stop_loss", now: 0 });
  const alerts = [];
  const deactivated = [];
  const deps = {
    getProtectedMints: prot(),
    getTokenBalance: async () => 10,
    getTokenValueUsd: async () => null,
    swapToSol: async () => ({ success: false, error: "no route" }),
    deactivatePool: (p) => deactivated.push(p),
    notifySwapGiveUp: (a) => alerts.push(a),
  };
  let t = 1e13;
  for (let i = 0; i < 3; i++) {
    await processPendingSwaps({ now: t, deps });
    t += 200_000;
  }
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /tidak punya harga/);
  assert.deepEqual(deactivated, ["POOLG"]);
  assert.ok(!runtime.isMintSwapPending(OTHER));
});

test("swap tertunda: mint dilindungi tidak di-swap & tidak dihitung gagal", async () => {
  reset();
  enqueuePendingSwap({ mint: OTHER, pool: "POOLH", now: 0 });
  runtime.protectMint(OTHER, "spot_rebalance");
  let swaps = 0;
  const r = await processPendingSwaps({
    now: 1e13,
    deps: { getProtectedMints: prot(), swapToSol: async () => { swaps++; return { success: true }; } },
  });
  assert.equal(swaps, 0);
  assert.deepEqual(r.protected, [OTHER]);
  assert.equal(runtime.getPendingSwaps()[OTHER].attempts, 0);
});

test("swapMintsToSol: dust/sukses dianggap tuntas, saldo 0 dilewati", async () => {
  reset();
  const r = await swapMintsToSol([OTHER, T22], {
    deps: {
      getProtectedMints: prot(),
      getTokenBalance: async (m) => (m === T22 ? 0 : 3),
      swapToSol: async () => ({ success: true, dust: true }),
    },
  });
  assert.deepEqual(r.swapped, [OTHER]);
  assert.deepEqual(r.empty, [T22]);
});

test("close OOR kanan spot meneruskan baris akan re-entry ke alert", async () => {
  reset({ positions: { POS8: { position: "POS8", pool: "POOLH", baseMint: BASE, closed: false, mode: "spot" } } });
  runtime.protectMint(BASE, "oor_kanan_reentry");
  const { buildCloseMessage } = await import("../src/notify/telegram.js");
  const notices = [];
  const c = closeDeps();
  c.deps.notifyClose = (...args) => notices.push(buildCloseMessage(...args));
  await handleClose(
    { position: "POS8", pool: "POOLH", baseMint: BASE, pair: "RUN-SOL", mode: "spot", pnlPct: 1 },
    "oor_kanan",
    { deps: c.deps, skipDeactivate: true, willReenter: true, nextCount: 2, max: 50 }
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0], /↪️ Akan re-entry \(2\/50\)/);
  assert.doesNotMatch(notices[0], /Tidak re-entry/);
});

test("close OOR kanan spot tanpa re-entry menulis alasan, alasan lain tidak", async () => {
  reset({ positions: { POS9: { position: "POS9", pool: "POOLI", baseMint: BASE, closed: false, mode: "spot" } } });
  const { buildCloseMessage } = await import("../src/notify/telegram.js");
  const notices = [];
  const c = closeDeps();
  c.deps.notifyClose = (...args) => notices.push(buildCloseMessage(...args));
  await handleClose(
    { position: "POS9", pool: "POOLI", baseMint: BASE, pair: "RUN-SOL", mode: "spot", pnlPct: 1 },
    "oor_kanan",
    {
      deps: c.deps,
      skipDeactivate: true,
      willReenter: false,
      nextCount: 51,
      max: 50,
      reentrySkipReason: "re-entry nonaktif",
    }
  );
  assert.match(notices[0], /↪️ Tidak re-entry: re-entry nonaktif/);
  assert.doesNotMatch(notices[0], /Akan re-entry/);

  reset({ positions: { POS10: { position: "POS10", pool: "POOLJ", baseMint: BASE, closed: false, mode: "spot" } } });
  const other = [];
  const c2 = closeDeps();
  c2.deps.notifyClose = (...args) => other.push(buildCloseMessage(...args));
  await handleClose(
    { position: "POS10", pool: "POOLJ", baseMint: BASE, pair: "RUN-SOL", mode: "spot", pnlPct: -2 },
    "stop_loss",
    { deps: c2.deps, willReenter: false, reentrySkipReason: "max re-entry tercapai" }
  );
  assert.doesNotMatch(other[0], /re-entry/);
});
