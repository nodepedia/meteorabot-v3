import { Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { toAmountIntoBins } from "@meteora-ag/dlmm";

// Batas bin per transaksi rebalance. Lebih lebar dari ini mudah melewati
// batas compute unit, jadi rentang panjang dipecah (sama seperti setor chunk 70).
export const DEFAULT_MAX_BINS_PER_TX = 70;

const REBALANCE_LIQUIDITY_DISCRIMINATOR = Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]);
// Offset byte `shrink_mode` pada instruksi Anchor `rebalance_liquidity`:
// 8 (discriminator) + 4 (active_id: i32) + 2 (max_active_bin_slippage: u16)
// + 1 (should_claim_fee: bool) + 1 (should_claim_reward: bool)
// + 8 (min_withdraw_x_amount: u64) + 8 (max_deposit_x_amount: u64)
// + 8 (min_withdraw_y_amount: u64) + 8 (max_deposit_y_amount: u64) = 48.
const REBALANCE_SHRINK_MODE_OFFSET = 48;
const SHRINK_MODE_NO_SHRINK_BOTH = 3;

function asBn(value) {
  if (value == null) return null;
  if (BN.isBN(value)) return value;
  if (typeof value === "bigint") return new BN(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new BN(String(Math.floor(value)));
  }
  const text = String(value?.toString?.() ?? value)
    .split(".")[0]
    .trim();
  if (!/^-?\d+$/.test(text)) return null;
  try {
    return new BN(text);
  } catch {
    return null;
  }
}

// Pure: pastikan seluruh instruksi `rebalance_liquidity` memakai
// `shrink_mode = 3` (NoShrinkBoth) agar batas posisi tidak menyusut.
export function patchRebalanceNoShrink(txs) {
  const list = Array.isArray(txs) ? txs : txs ? [txs] : [];
  for (const tx of list) {
    const ixs = tx?.instructions;
    if (!Array.isArray(ixs)) continue;
    for (const ix of ixs) {
      if (ix?.data && !Buffer.isBuffer(ix.data)) {
        try {
          ix.data = Buffer.from(ix.data);
        } catch {
          continue;
        }
      }
      const data = ix?.data;
      if (
        Buffer.isBuffer(data) &&
        data.length > REBALANCE_SHRINK_MODE_OFFSET &&
        data.subarray(0, 8).equals(REBALANCE_LIQUIDITY_DISCRIMINATOR)
      ) {
        data[REBALANCE_SHRINK_MODE_OFFSET] = SHRINK_MODE_NO_SHRINK_BOTH;
      }
    }
  }
  return list;
}

// "withdraw" = tarik lalu setor. Nilai lain (termasuk kosong) = di tempat.
export function resolveRebalanceMode(explicit, fallback = "inplace") {
  const raw = explicit == null || explicit === "" ? fallback : explicit;
  return String(raw).trim().toLowerCase() === "withdraw" ? "withdraw" : "inplace";
}

// Jumlah yang boleh disetor ulang. Tidak pernah memakai saldo wallet penuh.
// - Ada pembacaan posisi dan delta saldo > 0: ambil yang lebih kecil.
// - Delta 0 / tidak terbaca: pakai jumlah di posisi (bukan isi wallet).
// - Posisi tidak terbaca: pakai delta saja.
// - walletCapRaw (cadangan gas) memotong hasilnya.
export function capRedepositRaw({ positionRaw, balanceBeforeRaw, balanceAfterRaw, walletCapRaw } = {}) {
  const position = asBn(positionRaw);
  const before = asBn(balanceBeforeRaw);
  const after = asBn(balanceAfterRaw);
  let delta = null;
  if (before && after) delta = after.gte(before) ? after.sub(before) : new BN(0);

  let amount = position && position.gtn(0) ? position : null;
  if (delta) {
    if (!amount) amount = delta;
    else if (delta.gtn(0)) amount = BN.min(amount, delta);
  }
  if (!amount) amount = new BN(0);

  const cap = asBn(walletCapRaw);
  if (cap) amount = BN.min(amount, BN.max(cap, new BN(0)));
  if (amount.isNeg()) return new BN(0);
  return amount;
}

export function uiToRaw(ui, decimals) {
  const n = Number(ui);
  const d = Number(decimals);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(d) || d < 0) return null;
  const scaled = Math.floor(n * Math.pow(10, d));
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  return new BN(String(scaled));
}

// Saldo lamports yang masih boleh dipakai setelah cadangan gas.
export function solSpendCapRaw(balanceLamports, gasReserveSol) {
  const balance = asBn(balanceLamports);
  if (!balance) return null;
  const gasSol = Number(gasReserveSol);
  const gas = Number.isFinite(gasSol) && gasSol > 0 ? Math.floor(gasSol * 1e9) : 0;
  const cap = balance.sub(new BN(String(gas)));
  return cap.isNeg() ? new BN(0) : cap;
}

export function splitBinRange(fromBinId, toBinId, maxBins = DEFAULT_MAX_BINS_PER_TX) {
  const from = Math.floor(Number(fromBinId));
  const to = Math.floor(Number(toBinId));
  const max = Math.max(1, Math.floor(Number(maxBins) || DEFAULT_MAX_BINS_PER_TX));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const chunks = [];
  for (let cur = from; cur <= to; cur += max) {
    chunks.push({ fromBinId: cur, toBinId: Math.min(cur + max - 1, to) });
  }
  return chunks;
}

// Token base di atas bin aktif = X bila base adalah X. SOL = sisi sebaliknya.
export function depositTokenForSide(side, baseIsX) {
  if (side === "sol") return baseIsX ? "y" : "x";
  return baseIsX ? "x" : "y";
}

// X hanya bisa dibentuk di atas bin aktif. Y hanya di bin aktif ke bawah.
export function rangeSupportsDepositToken(fromBinId, toBinId, activeBinId, token) {
  const active = Math.floor(Number(activeBinId));
  const from = Math.floor(Number(fromBinId));
  const to = Math.floor(Number(toBinId));
  if (![active, from, to].every((n) => Number.isFinite(n)) || from > to) return false;
  if (token === "x") return from > active;
  if (token === "y") return to <= active;
  return false;
}

export function sumPositionSideRaw(positionData, fromBinId, toBinId, token) {
  const bins = positionData?.positionBinData;
  if (!Array.isArray(bins) || bins.length === 0) return null;
  const useX = token === "x";
  let total = new BN(0);
  let seen = false;
  for (const bin of bins) {
    const id = Number(bin?.binId);
    if (!Number.isFinite(id) || id < fromBinId || id > toBinId) continue;
    seen = true;
    const amt = asBn(useX ? bin.positionXAmount : bin.positionYAmount) || new BN(0);
    if (amt.gtn(0)) total = total.add(amt);
  }
  return seen ? total : null;
}

// Sama seperti SDK: ceil(persen slippage / (binStep / 100)).
export function maxActiveBinSlippageBins(slippagePct, binStep) {
  const pct = Number(slippagePct);
  const step = Number(binStep);
  if (!Number.isFinite(pct) || pct <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, Math.ceil(pct / (step / 100)));
}

export function rebalanceBuildersFromSdk(sdk) {
  if (typeof sdk?.buildLiquidityStrategyParameters !== "function") return null;
  if (typeof sdk?.getLiquidityStrategyParameterBuilder !== "function") return null;
  return {
    buildLiquidityStrategyParameters: sdk.buildLiquidityStrategyParameters,
    getLiquidityStrategyParameterBuilder: sdk.getLiquidityStrategyParameterBuilder,
  };
}

// Parameter setor satu sisi. null bila sisi token tidak cocok dengan rentang bin.
export function buildOneSidedDeposit({
  amountRaw,
  fromBinId,
  toBinId,
  activeBinId,
  binStep,
  strategyType,
  token,
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
}) {
  const amount = asBn(amountRaw) || new BN(0);
  if (amount.lte(new BN(0))) return null;
  if (!rangeSupportsDepositToken(fromBinId, toBinId, activeBinId, token)) return null;
  const active = Math.floor(Number(activeBinId));
  const minDeltaId = new BN(Math.floor(fromBinId) - active);
  const maxDeltaId = new BN(Math.floor(toBinId) - active);
  const built = buildLiquidityStrategyParameters(
    token === "x" ? amount : new BN(0),
    token === "y" ? amount : new BN(0),
    minDeltaId,
    maxDeltaId,
    new BN(String(Math.floor(Number(binStep)))),
    false,
    new BN(active),
    getLiquidityStrategyParameterBuilder(strategyType)
  );
  const x0 = asBn(built?.x0) || new BN(0);
  const y0 = asBn(built?.y0) || new BN(0);
  const deltaX = asBn(built?.deltaX) || new BN(0);
  const deltaY = asBn(built?.deltaY) || new BN(0);
  if (x0.isZero() && y0.isZero() && deltaX.isZero() && deltaY.isZero()) return null;
  return {
    minDeltaId,
    maxDeltaId,
    x0,
    y0,
    deltaX,
    deltaY,
    favorXInActiveBin: false,
  };
}

// Satu kurva untuk seluruh rentang. Tiap slice <=70 bin hanya mengambil porsi
// bin-nya (x0, deltaX, y0, deltaY yang sama). Bentuk tidak dihitung ulang di
// dalam slice, supaya BidAsk tidak pecah jadi tanjakan baru di tiap batas 70 bin.
export function globalShapeSlices({
  amountRaw,
  fromBinId,
  toBinId,
  activeBinId,
  binStep,
  strategyType,
  token,
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
  maxBinsPerTx = DEFAULT_MAX_BINS_PER_TX,
}) {
  const global = buildOneSidedDeposit({
    amountRaw,
    fromBinId,
    toBinId,
    activeBinId,
    binStep,
    strategyType,
    token,
    buildLiquidityStrategyParameters,
    getLiquidityStrategyParameterBuilder,
  });
  if (!global) return null;
  const active = Math.floor(Number(activeBinId));
  const activeBn = new BN(active);
  const stepBn = new BN(String(Math.floor(Number(binStep))));
  return splitBinRange(fromBinId, toBinId, maxBinsPerTx).map((slice) => {
    const deposit = {
      minDeltaId: new BN(slice.fromBinId - active),
      maxDeltaId: new BN(slice.toBinId - active),
      x0: global.x0,
      y0: global.y0,
      deltaX: global.deltaX,
      deltaY: global.deltaY,
      favorXInActiveBin: global.favorXInActiveBin,
    };
    let targetRaw = new BN(0);
    for (const bin of toAmountIntoBins(
      activeBn,
      deposit.minDeltaId,
      deposit.maxDeltaId,
      deposit.deltaX,
      deposit.deltaY,
      deposit.x0,
      deposit.y0,
      stepBn,
      !!deposit.favorXInActiveBin
    )) {
      targetRaw = targetRaw.add(token === "y" ? bin.amountY : bin.amountX);
    }
    return { fromBinId: slice.fromBinId, toBinId: slice.toBinId, deposit, targetRaw };
  });
}

function simulationBn(sim, key) {
  return asBn(sim?.simulationResult?.[key]) || new BN(0);
}

// Token yang ditarik dari wallet hanya boleh sebesar yang sudah kembali dari
// slice sebelumnya pada rebalance ini. Sisi token yang lain tetap ditolak.
function walletTopupBeyondReleased(sim, token, released) {
  const xIn = simulationBn(sim, "actualAmountXDeposited");
  const yIn = simulationBn(sim, "actualAmountYDeposited");
  const own = token === "y" ? yIn : xIn;
  const other = token === "y" ? xIn : yIn;
  if (other.gtn(0)) return true;
  return own.gt(released);
}

function releaseAfterSlice(sim, token, released) {
  const ownIn = simulationBn(sim, token === "y" ? "actualAmountYDeposited" : "actualAmountXDeposited");
  const ownOut = simulationBn(sim, token === "y" ? "actualAmountYWithdrawn" : "actualAmountXWithdrawn");
  const left = released.gt(ownIn) ? released.sub(ownIn) : new BN(0);
  return left.add(ownOut);
}

export function instructionsToTransaction(ixs) {
  const tx = new Transaction();
  for (const ix of ixs || []) {
    if (ix) tx.add(ix);
  }
  return tx;
}

// Bentuk ulang satu sisi lewat rebalance_liquidity.
// Kurva dihitung sekali untuk seluruh rentang, lalu tiap slice <=70 bin
// menyetor porsi bin itu. Slice yang mengembalikan token ke wallet jalan
// lebih dulu, supaya slice berikutnya tidak menarik saldo wallet lain.
// Gagal sebelum ada tx terkirim → pemanggil boleh jatuh ke tarik+setor.
// Sebagian chunk sudah terkirim → jangan tarik lagi.
export async function tryInPlaceRebalance({
  pool,
  positionPubKey,
  positionData,
  wallet,
  connection,
  feePlan,
  sendAndConfirmFn,
  fromBinId,
  toBinId,
  activeBinId,
  binStep,
  token,
  strategyType,
  builders,
  slippagePct = 0,
  maxBinsPerTx = DEFAULT_MAX_BINS_PER_TX,
}) {
  const empty = { ok: false, partial: false, signatures: [], depositedRaw: new BN(0) };
  if (!builders) return { ...empty, reason: "sdk_missing" };
  if (typeof pool?.simulateRebalancePosition !== "function" || typeof pool?.rebalancePosition !== "function") {
    return { ...empty, reason: "sdk_missing" };
  }
  const step = Number(binStep);
  if (!Number.isFinite(step) || step <= 0) return { ...empty, reason: "no_bin_step" };

  const slices = splitBinRange(fromBinId, toBinId, maxBinsPerTx);
  if (slices.length === 0) return { ...empty, reason: "empty_range" };

  const signatures = [];
  let deposited = new BN(0);
  const fail = (reason, error) => ({
    ok: false,
    reason,
    error,
    partial: signatures.length > 0,
    signatures,
    depositedRaw: deposited,
  });

  const rangeFrom = slices[0].fromBinId;
  const rangeTo = slices[slices.length - 1].toBinId;
  const total = sumPositionSideRaw(positionData, rangeFrom, rangeTo, token);
  if (total == null) return fail("no_bin_amounts");
  if (total.lte(new BN(0))) return fail("no_amount");

  let planned;
  try {
    planned = globalShapeSlices({
      amountRaw: total,
      fromBinId: rangeFrom,
      toBinId: rangeTo,
      activeBinId,
      binStep: step,
      strategyType,
      token,
      buildLiquidityStrategyParameters: builders.buildLiquidityStrategyParameters,
      getLiquidityStrategyParameterBuilder: builders.getLiquidityStrategyParameterBuilder,
      maxBinsPerTx,
    });
  } catch (err) {
    return fail("strategy_failed", err.message || String(err));
  }
  if (!planned) return fail("side_mismatch");

  const queue = [];
  for (const slice of planned) {
    const withdrawn = sumPositionSideRaw(positionData, slice.fromBinId, slice.toBinId, token);
    if (withdrawn == null) return fail("no_bin_amounts");
    if (withdrawn.lte(new BN(0)) && slice.targetRaw.lte(new BN(0))) continue;
    queue.push({ ...slice, withdrawn });
  }
  if (queue.length === 0) return fail("no_amount");
  queue.sort((a, b) => {
    const cmp = b.withdrawn.sub(b.targetRaw).cmp(a.withdrawn.sub(a.targetRaw));
    return cmp !== 0 ? cmp : a.fromBinId - b.fromBinId;
  });

  const prepared = [];
  let released = new BN(0);
  for (const slice of queue) {
    const withdraws = [{ minBinId: new BN(slice.fromBinId), maxBinId: new BN(slice.toBinId), bps: new BN(10000) }];
    let sim;
    try {
      sim = await pool.simulateRebalancePosition(
        positionPubKey,
        positionData,
        false,
        false,
        [slice.deposit],
        withdraws
      );
    } catch (err) {
      return fail("simulate_failed", err.message || String(err));
    }
    if (walletTopupBeyondReleased(sim, token, released)) return fail("wallet_topup");
    released = releaseAfterSlice(sim, token, released);

    let built;
    try {
      built = await pool.rebalancePosition(
        sim,
        new BN(maxActiveBinSlippageBins(slippagePct, step)),
        wallet?.publicKey,
        0
      );
    } catch (err) {
      return fail("build_failed", err.message || String(err));
    }

    const groups = [built?.initBinArrayInstructions, built?.rebalancePositionInstruction].filter(
      (group) => Array.isArray(group) && group.length > 0
    );
    if (groups.length === 0) return fail("empty_tx");
    prepared.push({ withdrawn: slice.withdrawn, groups });
  }

  for (const item of prepared) {
    try {
      for (const group of item.groups) {
        const tx = instructionsToTransaction(group);
        patchRebalanceNoShrink([tx]);
        const sent = await sendAndConfirmFn({ connection, tx, signers: [wallet], feePlan, wallet });
        if (sent?.signature) signatures.push(sent.signature);
      }
    } catch (err) {
      return fail("send_failed", err.message || String(err));
    }
    deposited = deposited.add(item.withdrawn);
  }

  if (deposited.lte(new BN(0))) return fail("no_amount");
  return { ok: true, reason: "inplace", partial: false, signatures, depositedRaw: deposited };
}
