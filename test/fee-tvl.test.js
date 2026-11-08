import test from "node:test";
import assert from "node:assert/strict";
import { applyPositionFeeTvl, positionFeePct24h } from "../src/meteora/positions.js";
import { rewardMintsOf } from "../src/meteora/close.js";
import { swapMintsFromCloseResult } from "../src/exit/close.js";
import { humanReason } from "../src/core/report.js";
import { WSOL_MINT } from "../src/core/constants.js";

test("24h Fee/TVL posisi dibaca dari feePerTvl24h sebagai poin persen", () => {
  assert.equal(positionFeePct24h({ feePerTvl24h: "7.25" }), 7.25);
  assert.equal(positionFeePct24h({ feePerTvl24h: 7.25 }), 7.25);
  // Rasio 0–1 tidak diubah jadi persen. 0.08 tetap 0.08, bukan 8.
  assert.equal(positionFeePct24h({ feePerTvl24h: "0.08" }), 0.08);
  assert.equal(positionFeePct24h({ feePerTvl24h: 0.08 }), 0.08);
});

test("sumber lain tidak dipakai sebagai 24h Fee/TVL posisi", () => {
  assert.equal(positionFeePct24h({ fee_tvl_ratio: 0.227, pnlPctChange: "40", pnlSolPctChange: "40" }), null);
  assert.equal(positionFeePct24h({ fee: 1200, fees24h: 50 }), null);
  assert.equal(positionFeePct24h({ feePerTvl24h: "" }), null);
  assert.equal(positionFeePct24h({ feePerTvl24h: "abc" }), null);
  assert.equal(positionFeePct24h({ feePerTvl24h: "Infinity" }), null);
  assert.equal(positionFeePct24h(null), null);
  assert.equal(positionFeePct24h(undefined), null);
});

test("waktu pengamatan ikut tersimpan hanya bila angkanya valid", () => {
  const pos = {};
  applyPositionFeeTvl(pos, { feePerTvl24h: "8.1" }, 1_700_000_000_000);
  assert.equal(pos.feePct24h, 8.1);
  assert.equal(pos.feePct24hAt, 1_700_000_000_000);
  assert.equal(pos.feePct24hUpdatedAt, null);

  applyPositionFeeTvl(pos, { feePerTvl24h: "nope" }, 1_700_000_000_000);
  assert.equal(pos.feePct24h, null);
  assert.equal(pos.feePct24hAt, null);

  applyPositionFeeTvl(pos, { feePerTvl24h: "9" }, null);
  assert.equal(pos.feePct24h, 9);
  assert.equal(pos.feePct24hAt, null);
});

test("close biasa men-swap saldo token sekali, tanpa menambah unclaimed fee", () => {
  const reward = rewardMintsOf({
    rewardInfos: [
      { mint: { toString: () => "TokenMint111" } },
      { mint: { toString: () => WSOL_MINT } },
      { mint: "TokenMint111" },
    ],
  });
  assert.deepEqual(reward, ["TokenMint111"]);

  const swapMints = swapMintsFromCloseResult({
    baseMint: "BaseMint111",
    rewardMints: reward,
    unclaimedFee: 1.25,
    claimTx: "sig",
  });
  assert.deepEqual(swapMints, ["BaseMint111", "TokenMint111"]);
  assert.equal(swapMints.includes(WSOL_MINT), false);
  assert.equal(humanReason("low_yield"), "24h Fee/TVL posisi di bawah ambang");
});
