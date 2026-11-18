import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Arahkan file state ke direktori sementara SEBELUM modul di-import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-icap-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");

const { WSOL_MINT } = await import("../src/core/constants.js");
const { trackPosition, getTrackedPosition, getInitialCapitalSol, setInitialCapitalSol, updateBidaskSolRebalanceState } =
  await import("../src/state/positions.js");
const { pnlFromEntry, fetchInitialDepositEvents } = await import("../src/meteora/positions.js");
const { handleClose } = await import("../src/exit/close.js");

const POOL = "PoolClaudia111111111111111111111111111111";
const POS = "PosClaudia1111111111111111111111111111111";
const CHILD = "PosClaudiaChild11111111111111111111111111";

const CLAUDIA = {
  pnlSol: "0.1134",
  pnlSolPctChange: "3.22",
  allTimeDeposits: { total: { sol: "3.5217" } },
  allTimeWithdrawals: { total: { sol: "3.5733" } },
};

const realFetch = global.fetch;

test.after(() => {
  global.fetch = realFetch;
});

test("state lama tanpa initialCapitalSol tidak melempar dan PnL jatuh ke cadangan", () => {
  const legacy = {
    positions: {
      [POS]: {
        position: POS,
        pool: POOL,
        pair: "CLAUDIA-SOL",
        mode: "bidask:sol",
        closed: false,
        firstSeenAt: 1,
      },
    },
  };
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(legacy));

  const tracked = getTrackedPosition(POS);
  assert.equal(tracked.pair, "CLAUDIA-SOL");
  assert.equal(Object.hasOwn(tracked, "initialCapitalSol"), false);
  assert.equal(getInitialCapitalSol(POS), null);
  assert.equal(pnlFromEntry(CLAUDIA, { solMode: true, initialCapitalSol: getInitialCapitalSol(POS) }), 3.22);

  updateBidaskSolRebalanceState(POS, 10, 123, 4);
  assert.equal(getTrackedPosition(POS).lastBidaskSolRebalancePct, 10);
  assert.equal(getInitialCapitalSol(POS), null);
});

test("modal awal diisi sekali, rebalance tidak menimpa, rantai re-entry mewarisi", () => {
  if (!getTrackedPosition(POS)) {
    trackPosition(POS, POOL, "CLAUDIA-SOL", "mint", null, "bidask:sol");
  }
  assert.equal(setInitialCapitalSol(POS, 1), 1);
  assert.equal(getInitialCapitalSol(POS), 1);
  const pnl = pnlFromEntry(CLAUDIA, { solMode: true, initialCapitalSol: getInitialCapitalSol(POS) });
  assert.ok(Math.abs(pnl - 11.34) < 1e-9, `pnl ${pnl}`);

  updateBidaskSolRebalanceState(POS, 20, 456, 8);
  assert.equal(getInitialCapitalSol(POS), 1);
  assert.equal(setInitialCapitalSol(POS, 9), 1);

  const carried = getInitialCapitalSol(POS);
  trackPosition(CHILD, POOL, "CLAUDIA-SOL", "mint", null, "bidask:sol", false, {
    exitWarmupStartedAt: 111,
    initialCapitalSol: carried,
  });
  assert.equal(getInitialCapitalSol(CHILD), 1);
  assert.equal(getTrackedPosition(CHILD).exitWarmupStartedAt, 111);

  // Deteksi on-chain lebih dulu: baris ada, modal masih kosong, lalu diisi.
  const late = "PosLate1111111111111111111111111111111111";
  trackPosition(late, POOL, "CLAUDIA-SOL", "mint", null, "bidask:sol");
  assert.equal(getInitialCapitalSol(late), null);
  assert.equal(setInitialCapitalSol(late, carried), 1);
  assert.equal(setInitialCapitalSol(late, 4), 1);
});

test("close mengirim modal awal ke PnL final (alert Realized PnL)", async () => {
  const addr = "PosClose111111111111111111111111111111111";
  trackPosition(addr, POOL, "CLAUDIA-SOL", "mint", null, "bidask:sol");
  setInitialCapitalSol(addr, 1);
  let seen = null;
  const res = await handleClose({ position: addr, pool: POOL, pair: "CLAUDIA-SOL", pnlPct: 3.22 }, "stop_loss", {
    deps: {
      closePosition: async () => ({ success: true, rewardMints: [] }),
      waitClosedPositionPnl: async (_pool, _pos, opts) => {
        seen = opts;
        return 11.34;
      },
      deactivatePool: () => {},
      notifyClose: () => {},
    },
  });
  assert.equal(res.success, true);
  assert.equal(seen?.initialCapitalSol, 1);
  assert.equal(getTrackedPosition(addr).closePnlPct, 11.34);
});

test("fetch riwayat deposit pertama mengembalikan event, gagal → null", async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      events: [
        {
          eventType: "add",
          blockTime: 1,
          tokenX: "Mint",
          tokenY: WSOL_MINT,
          amountX: "0",
          amountY: "1",
          amountXUsd: "0",
          amountYUsd: "100",
        },
      ],
    }),
  });
  const events = await fetchInitialDepositEvents(POS);
  assert.equal(events.length, 1);
  assert.equal(events[0].amountY, "1");

  global.fetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchInitialDepositEvents(POS), null);
});
