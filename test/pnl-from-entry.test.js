import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config/index.js";
import { WSOL_MINT } from "../src/core/constants.js";
import { pnlFromEntry, initialCapitalForPosition, initialDepositSol } from "../src/meteora/positions.js";

// Sakura-SOL 8ksEo9xQK9eYsA3MukPoCurTpGTx4xc4VxomhRew9M7T.
// Setoran seumur hidup membengkak karena rebalance; modal bersih = 0.125 SOL.
const SAKURA = {
  pnlSol: "-0.03174",
  pnlSolPctChange: "-2.99",
  allTimeDeposits: { total: { sol: "1.0610" } },
  allTimeWithdrawals: { total: { sol: "0.9360" } },
};

function sakuraPct() {
  return (-0.03174 / (1.061 - 0.936)) * 100;
}

test("rebalance: PnL % = pnlSol / modal bersih, bukan pnlSolPctChange", () => {
  const pnl = pnlFromEntry(SAKURA, { solMode: true });
  const expected = sakuraPct();
  assert.ok(Math.abs(pnl - expected) < 1e-9, `pnl ${pnl} expected ${expected}`);
  assert.ok(Math.abs(pnl - -25.4) < 0.05, `sekitar -25.4%, dapat ${pnl}`);
  assert.ok(Math.abs(pnl - -2.99) > 10, "tidak boleh memakai persen Meteora yang terencer");
});

test("tanpa rebalance (tarikan 0) sama dengan perilaku lama", () => {
  const entry = {
    pnlSol: "-1",
    pnlSolPctChange: "-25",
    allTimeDeposits: { total: { sol: "4" } },
    allTimeWithdrawals: { total: { sol: "0" } },
  };
  const pnl = pnlFromEntry(entry, { solMode: true });
  assert.equal(pnl, -25);
  assert.equal(pnl, parseFloat(entry.pnlSolPctChange));
});

test("tarikan tidak ada dihitung 0 (posisi tanpa rebalance)", () => {
  const entry = {
    pnlSol: "0.5",
    pnlSolPctChange: "10",
    allTimeDeposits: { total: { sol: "5" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true }), 10);
});

test("fallback: modal bersih ~0 memakai field persen Meteora", () => {
  const entry = {
    pnlSol: "-0.03174",
    pnlSolPctChange: "-2.99",
    allTimeDeposits: { total: { sol: "1.0610" } },
    allTimeWithdrawals: { total: { sol: "1.0610" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true }), -2.99);
});

test("fallback: modal bersih ≤ 1e-6 memakai field persen Meteora", () => {
  const entry = {
    pnlSol: "-0.0000001",
    pnlSolPctChange: "4.5",
    allTimeDeposits: { total: { sol: "0.000001" } },
    allTimeWithdrawals: { total: { sol: "0" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true }), 4.5);
});

test("fallback: modal bersih ≤ 1% setoran memakai field persen Meteora", () => {
  const entry = {
    pnlSol: "-0.1",
    pnlSolPctChange: "-3.5",
    allTimeDeposits: { total: { sol: "1" } },
    allTimeWithdrawals: { total: { sol: "0.995" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true }), -3.5);
});

test("fallback: modal negatif memakai field persen Meteora", () => {
  const entry = {
    pnlSol: "-0.1",
    pnlSolPctChange: "-1.5",
    allTimeDeposits: { total: { sol: "1" } },
    allTimeWithdrawals: { total: { sol: "1.1" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true }), -1.5);
});

test("fallback: pnlSol tidak ada memakai field persen Meteora", () => {
  assert.equal(pnlFromEntry({ pnlSolPctChange: "12.5" }, { solMode: true }), 12.5);
});

test("fallback: setoran tidak ada memakai field persen Meteora", () => {
  const entry = { pnlSol: "-1", pnlSolPctChange: "4.2" };
  assert.equal(pnlFromEntry(entry, { solMode: true }), 4.2);
});

test("fallback: field persen kosong dihitung 0", () => {
  assert.equal(pnlFromEntry({}, { solMode: true }), 0);
});

test("field persen bukan angka dan pnl/setoran tidak ada → null", () => {
  assert.equal(pnlFromEntry({ pnlSolPctChange: "nope" }, { solMode: true }), null);
});

test("entri kosong → null", () => {
  assert.equal(pnlFromEntry(null, { solMode: true }), null);
  assert.equal(pnlFromEntry(undefined, { solMode: true }), null);
});

test("mode USD memakai pnlUsd dan total.usd", () => {
  const entry = {
    pnlUsd: "-0.03174",
    pnlPctChange: "-2.99",
    pnlSol: "-999",
    pnlSolPctChange: "-99",
    allTimeDeposits: { total: { usd: "1.0610", sol: "50" } },
    allTimeWithdrawals: { total: { usd: "0.9360", sol: "40" } },
  };
  const pnl = pnlFromEntry(entry, { solMode: false });
  assert.ok(Math.abs(pnl - sakuraPct()) < 1e-9, `pnl ${pnl}`);
});

test("mode USD: pnl/setoran tidak ada jatuh ke pnlPctChange", () => {
  const entry = {
    pnlPctChange: "4.5",
    pnlSolPctChange: "9",
    pnlSol: "1",
    allTimeDeposits: { total: { sol: "2" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: false }), 4.5);
});

test("mode SOL mengabaikan angka USD", () => {
  const entry = {
    ...SAKURA,
    pnlUsd: "-1",
    pnlPctChange: "-99",
    allTimeDeposits: { total: { sol: "1.0610", usd: "10" } },
    allTimeWithdrawals: { total: { sol: "0.9360", usd: "9" } },
  };
  const pnl = pnlFromEntry(entry, { solMode: true });
  assert.ok(Math.abs(pnl - sakuraPct()) < 1e-9, `pnl ${pnl}`);
});

test("tanpa opsi mengikuti config.solMode", () => {
  const pnl = pnlFromEntry(SAKURA);
  assert.equal(pnl, pnlFromEntry(SAKURA, { solMode: config.solMode }));
  assert.ok(Math.abs(pnl - sakuraPct()) < 1e-9, "strat.conf SOL_MODE=true");
});

// CLAUDIA-SOL, ditutup 2026-11-18. Rebalance membuat tarikan > setoran.
const CLAUDIA = {
  pnlSol: "0.1134",
  pnlSolPctChange: "3.22",
  allTimeDeposits: { total: { sol: "3.5217" } },
  allTimeWithdrawals: { total: { sol: "3.5733" } },
};

function solAdd(amount, blockTime) {
  return {
    eventType: "add",
    blockTime,
    tokenX: "MintClaudia1111111111111111111111111111111",
    tokenY: WSOL_MINT,
    amountX: "0",
    amountY: String(amount),
    amountXUsd: "0",
    amountYUsd: String(amount * 100),
  };
}

test("tanpa rebalance + modal awal = setoran: sama dengan hasil lama", () => {
  const entry = {
    pnlSol: "-1",
    pnlSolPctChange: "-25",
    allTimeDeposits: { total: { sol: "4" } },
    allTimeWithdrawals: { total: { sol: "0" } },
  };
  const old = pnlFromEntry(entry, { solMode: true });
  const next = pnlFromEntry(entry, { solMode: true, initialCapitalSol: 4 });
  assert.equal(old, -25);
  assert.equal(next, old);
});

test("rebalance tarikan > setoran: pnlSol / modal awal (CLAUDIA ~11.34%)", () => {
  const pnl = pnlFromEntry(CLAUDIA, { solMode: true, initialCapitalSol: 1 });
  assert.ok(Math.abs(pnl - 11.34) < 1e-9, `pnl ${pnl}`);
  assert.ok(Math.abs(pnl - 3.22) > 1, "bukan persen Meteora yang terencer");
});

test("modal awal tidak diketahui: tarikan > setoran jatuh ke pnlSolPctChange", () => {
  assert.equal(pnlFromEntry(CLAUDIA, { solMode: true }), 3.22);
  assert.equal(pnlFromEntry(CLAUDIA, { solMode: true, initialCapitalSol: null }), 3.22);
  assert.equal(pnlFromEntry(CLAUDIA, { solMode: true, initialCapitalSol: 0 }), 3.22);
});

test("modal awal ada tapi pnlSol tidak ada: tetap cadangan", () => {
  const entry = {
    pnlSolPctChange: "3.22",
    allTimeDeposits: { total: { sol: "3.5217" } },
    allTimeWithdrawals: { total: { sol: "3.5733" } },
  };
  assert.equal(pnlFromEntry(entry, { solMode: true, initialCapitalSol: 1 }), 3.22);
});

test("mode USD mengabaikan modal awal SOL", () => {
  const entry = {
    pnlUsd: "-0.03174",
    pnlPctChange: "-2.99",
    pnlSol: "-999",
    pnlSolPctChange: "-99",
    allTimeDeposits: { total: { usd: "1.0610", sol: "50" } },
    allTimeWithdrawals: { total: { usd: "0.9360", sol: "40" } },
  };
  const pnl = pnlFromEntry(entry, { solMode: false, initialCapitalSol: 1 });
  assert.ok(Math.abs(pnl - sakuraPct()) < 1e-9, `pnl ${pnl}`);
});

test("modal awal dari deposit pertama, bukan allTimeDeposits yang membengkak", () => {
  const events = [solAdd(0.4, 20), solAdd(0.6, 10), { ...solAdd(1, 30), eventType: "remove" }, solAdd(5, 40)];
  assert.ok(Math.abs(initialDepositSol(events) - 1) < 1e-9, `deposit ${initialDepositSol(events)}`);
  const entry = { ...CLAUDIA, events };
  assert.equal(initialCapitalForPosition(entry, { adopted: false }), 1);
  assert.equal(initialCapitalForPosition(entry, { adopted: true }), 1);
});

test("adopsi tanpa deposit pertama memakai allTimeDeposits; posisi lama yang sudah di-rebalance tidak", () => {
  assert.ok(Math.abs(initialCapitalForPosition(CLAUDIA, { adopted: true }) - 3.5217) < 1e-9);
  assert.equal(initialCapitalForPosition(CLAUDIA, { adopted: false }), null);
  const fresh = {
    pnlSol: "0.01",
    allTimeDeposits: { total: { sol: "1" } },
    allTimeWithdrawals: { total: { sol: "0" } },
  };
  assert.equal(initialCapitalForPosition(fresh, { adopted: false }), 1);
  assert.equal(initialCapitalForPosition(fresh, { adopted: true }), 1);
  assert.equal(initialCapitalForPosition(null), null);
});

test("deposit dua sisi: sisi token diubah ke SOL lewat harga setoran", () => {
  const event = {
    eventType: "add",
    blockTime: 1,
    tokenY: WSOL_MINT,
    tokenX: "MintToken",
    amountY: "0.5",
    amountYUsd: "50",
    amountX: "1000",
    amountXUsd: "50",
  };
  assert.ok(Math.abs(initialDepositSol(event) - 1) < 1e-9);
});
