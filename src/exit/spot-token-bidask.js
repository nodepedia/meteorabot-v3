import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sleep } from "../core/utils.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance, getMintDecimals } from "../solana/balances.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "../meteora/sdk.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { poolPriceSolPerToken } from "../entry/price-guard.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  recordAction,
} from "../entry/runtime.js";
import { getTrackedPosition, updateSpotTokenBidaskState } from "../state/positions.js";

const DEFAULT_MAX_BINS_PER_TX = 70;
const REBALANCE_LIQUIDITY_DISCRIMINATOR = Buffer.from([92, 4, 176, 193, 119, 185, 83, 9]);
// Offset byte `shrink_mode` pada instruksi Anchor `rebalance_liquidity`:
// 8 (discriminator) + 4 (active_id: i32) + 2 (max_active_bin_slippage: u16)
// + 1 (should_claim_fee: bool) + 1 (should_claim_reward: bool)
// + 8 (min_withdraw_x_amount: u64) + 8 (max_deposit_x_amount: u64)
// + 8 (min_withdraw_y_amount: u64) + 8 (max_deposit_y_amount: u64) = 48.
const REBALANCE_SHRINK_MODE_OFFSET = 48;
const SHRINK_MODE_NO_SHRINK_BOTH = 3;

const rebalanceInProgress = new Set();

// Pure: pastikan seluruh instruksi `rebalance_liquidity` di dalam tx memakai
// `shrink_mode = 3` (NoShrinkBoth) agar batas lowerBinId / upperBinId posisi
// tidak pernah menyusut ketika deposit dilakukan per chunk 70 bin setelah withdraw.
export function patchRebalanceNoShrink(txs) {
  const list = Array.isArray(txs) ? txs : txs ? [txs] : [];
  for (const tx of list) {
    const ixs = tx?.instructions;
    if (!Array.isArray(ixs)) continue;
    for (const ix of ixs) {
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

// Pure: hitung metrik bin token (di atas activeBin) & bin SOL (<= activeBin) untuk posisi spot.
// Ketika harga turun di dalam rentang (lowerBin <= activeBin < upperBin),
// bin di (activeBin + 1 .. upperBin) berisi token base, sedangkan bin <= activeBin berisi SOL.
export function calcSpotTokenBinMetrics({
  activeBin,
  lowerBin,
  upperBin,
  stepPct = config.spotTokenBidask?.stepPct ?? 10,
}) {
  const active = Number(activeBin);
  const lower = Number(lowerBin);
  const upper = Number(upperBin);
  const step = Math.max(1, Number(stepPct) || (config.spotTokenBidask?.stepPct ?? 10));

  if (!Number.isFinite(active) || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    return {
      inRange: false,
      binSpan: 0,
      tokenBins: 0,
      tokenBinPct: 0,
      stepLevel: 0,
      fromBinId: null,
      toBinId: null,
      solBins: 0,
      solBinPct: 0,
      solFromBinId: null,
      solToBinId: null,
    };
  }

  const binSpan = upper - lower;
  if (active < lower || active > upper) {
    return {
      inRange: false,
      binSpan,
      tokenBins: 0,
      tokenBinPct: 0,
      stepLevel: 0,
      fromBinId: null,
      toBinId: null,
      solBins: 0,
      solBinPct: 0,
      solFromBinId: null,
      solToBinId: null,
    };
  }

  if (active === upper) {
    return {
      inRange: true,
      binSpan,
      tokenBins: 0,
      tokenBinPct: 0,
      stepLevel: 0,
      fromBinId: null,
      toBinId: null,
      solBins: active - lower + 1,
      solBinPct: 100,
      solFromBinId: lower,
      solToBinId: active,
    };
  }

  const tokenBins = upper - active;
  const tokenBinPct = (tokenBins * 100) / binSpan;
  const stepLevel = Math.floor((tokenBinPct + 1e-9) / step) * step;

  return {
    inRange: true,
    binSpan,
    tokenBins,
    tokenBinPct,
    stepLevel,
    fromBinId: active + 1,
    toBinId: upper,
    solBins: active - lower + 1,
    solBinPct: 100 - tokenBinPct,
    solFromBinId: lower,
    solToBinId: active,
  };
}

// Pure: evaluasi apakah posisi spot perlu:
// - di-rebalance sisi tokennya ke BidAsk saat harga turun -step% bin (`action: "rebalance"`),
// - di-rebalance sisi SOL-nya kembali ke Spot murni saat harga naik +step% bin sejak rebalance (`action: "rebalance_sol_spot"`),
// - atau ditahan karena cooldown / belum mencapai step berikutnya.
export function evaluateSpotTokenBidaskTrigger({
  pos,
  tracked,
  cfg = config.spotTokenBidask,
  spotMinBins = config.spotMinBins,
  now = Date.now(),
}) {
  if (!cfg?.enabled) {
    return { action: "none", reason: "disabled" };
  }
  if (!pos || pos.mode !== "spot") {
    return { action: "none", reason: "not_spot" };
  }

  const lowerBin = Number.isFinite(Number(pos.lowerBin)) ? Number(pos.lowerBin) : Number(tracked?.lowerBin);
  const upperBin = Number.isFinite(Number(pos.upperBin)) ? Number(pos.upperBin) : Number(tracked?.upperBin);
  const binSpan =
    Number.isFinite(lowerBin) && Number.isFinite(upperBin)
      ? upperBin - lowerBin
      : Number(pos.binSpan ?? tracked?.binSpan);

  const minBins = Math.max(1, Number(spotMinBins) || 200);
  if (!Number.isFinite(binSpan) || binSpan < minBins) {
    return { action: "none", reason: "span_below_min", binSpan };
  }

  const step = Math.max(1, Number(cfg.stepPct) || (config.spotTokenBidask?.stepPct ?? 10));
  const metrics = calcSpotTokenBinMetrics({
    activeBin: pos.activeBin,
    lowerBin,
    upperBin,
    stepPct: step,
  });

  if (!metrics.inRange) {
    return { action: "none", reason: "out_of_range", ...metrics };
  }

  const lastPct = Math.max(0, Number(tracked?.lastSpotTokenBidaskPct) || 0);
  const lastAt = Number(tracked?.lastSpotTokenBidaskAt) || 0;
  const lastBin =
    tracked?.lastSpotTokenBidaskBin != null && Number.isFinite(Number(tracked.lastSpotTokenBidaskBin))
      ? Number(tracked.lastSpotTokenBidaskBin)
      : null;
  const cooldownMs = Math.max(0, Number(cfg.cooldownSec) || 0) * 1000;

  // 1. Harga turun mencapai step berikutnya: rebalance token di atas activeBin ke BidAsk.
  if (metrics.stepLevel >= lastPct + step && metrics.stepLevel >= step) {
    if (lastAt > 0 && cooldownMs > 0 && now - lastAt < cooldownMs) {
      return {
        action: "cooldown",
        reason: "cooldown",
        remainingMs: cooldownMs - (now - lastAt),
        lastPct,
        ...metrics,
      };
    }
    return {
      action: "rebalance",
      reason: `step_${metrics.stepLevel}pct`,
      lastPct,
      ...metrics,
    };
  }

  // 2. Harga naik kembali >= +step% sejak posisi rebalance:
  //    bin yang tadinya BidAsk token berubah jadi BidAsk SOL (bercampur dengan Spot SOL di bawahnya).
  //    Tarik seluruh SOL di posisi terlebih dahulu, lalu deposit ulang dengan mode Spot agar seluruh SOL kembali berbentuk Spot murni yang rapi.
  const risePctFromLastBin = lastBin != null ? ((Number(pos.activeBin) - lastBin) * 100) / binSpan : null;
  const risePctFromLastStep = lastPct - metrics.tokenBinPct;
  const recoveredEnough =
    lastPct >= step &&
    metrics.stepLevel <= lastPct - step &&
    (risePctFromLastStep + 1e-9 >= step || (risePctFromLastBin != null && risePctFromLastBin + 1e-9 >= step));

  if (recoveredEnough) {
    if (lastAt > 0 && cooldownMs > 0 && now - lastAt < cooldownMs) {
      return {
        action: "cooldown",
        reason: "cooldown",
        remainingMs: cooldownMs - (now - lastAt),
        lastPct,
        ...metrics,
      };
    }
    return {
      action: "rebalance_sol_spot",
      reason: `recover_${lastPct}_to_${metrics.stepLevel}pct`,
      lastPct,
      ...metrics,
    };
  }

  return {
    action: "none",
    reason: "below_next_step",
    lastPct,
    ...metrics,
  };
}

// Pure: bagi rentang [fromBinId, toBinId] ke chunk <= maxBinsPerChunk (70 bin)
// dengan bobot linear BidAsk sisi Token (bin lebih jauh di atas activeBin mendapat porsi
// token lebih besar). Bila <= 70 bin, dikembalikan 1 chunk utuh.
export function chunkBidAskRanges(fromBinId, toBinId, totalAmountRaw, maxBinsPerChunk = DEFAULT_MAX_BINS_PER_TX) {
  const from = Math.floor(Number(fromBinId));
  const to = Math.floor(Number(toBinId));
  const total = BN.isBN(totalAmountRaw) ? totalAmountRaw : new BN(String(totalAmountRaw || 0));
  const maxChunk = Math.max(1, Math.floor(Number(maxBinsPerChunk) || DEFAULT_MAX_BINS_PER_TX));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || total.lte(new BN(0))) {
    return [];
  }

  const totalBins = to - from + 1;
  if (totalBins <= maxChunk) {
    return [{ minBinId: from, maxBinId: to, amountRaw: total }];
  }

  const ranges = [];
  for (let cur = from; cur <= to; cur += maxChunk) {
    const end = Math.min(cur + maxChunk - 1, to);
    // Bobot BidAsk linear relatif terhadap fromBinId: w(b) = (b - from + 1)
    let weight = 0;
    for (let b = cur; b <= end; b++) {
      weight += b - from + 1;
    }
    ranges.push({ minBinId: cur, maxBinId: end, weight });
  }

  const totalWeight = (totalBins * (totalBins + 1)) / 2;
  const totalWeightBn = new BN(String(Math.round(totalWeight)));
  let allocated = new BN(0);

  return ranges
    .map((r, idx) => {
      if (idx === ranges.length - 1) {
        const rem = total.sub(allocated);
        return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: BN.max(rem, new BN(0)) };
      }
      const part = total.mul(new BN(String(Math.round(r.weight)))).div(totalWeightBn);
      allocated = allocated.add(part);
      return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: part };
    })
    .filter((c) => c.amountRaw.gt(new BN(0)));
}

// Pure: bagi rentang [fromBinId, toBinId] ke chunk <= maxBinsPerChunk (70 bin)
// dengan bobot linear BidAsk sisi SOL (bin lebih jauh di bawah activeBin / dekat fromBinId
// mendapat porsi SOL lebih besar: w(b) = to - b + 1).
export function chunkSolBidAskRanges(fromBinId, toBinId, totalAmountRaw, maxBinsPerChunk = DEFAULT_MAX_BINS_PER_TX) {
  const from = Math.floor(Number(fromBinId));
  const to = Math.floor(Number(toBinId));
  const total = BN.isBN(totalAmountRaw) ? totalAmountRaw : new BN(String(totalAmountRaw || 0));
  const maxChunk = Math.max(1, Math.floor(Number(maxBinsPerChunk) || DEFAULT_MAX_BINS_PER_TX));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || total.lte(new BN(0))) {
    return [];
  }

  const totalBins = to - from + 1;
  if (totalBins <= maxChunk) {
    return [{ minBinId: from, maxBinId: to, amountRaw: total }];
  }

  const ranges = [];
  for (let cur = from; cur <= to; cur += maxChunk) {
    const end = Math.min(cur + maxChunk - 1, to);
    let weight = 0;
    for (let b = cur; b <= end; b++) {
      weight += to - b + 1;
    }
    ranges.push({ minBinId: cur, maxBinId: end, weight });
  }

  const totalWeight = (totalBins * (totalBins + 1)) / 2;
  const totalWeightBn = new BN(String(Math.round(totalWeight)));
  let allocated = new BN(0);

  return ranges
    .map((r, idx) => {
      if (idx === ranges.length - 1) {
        const rem = total.sub(allocated);
        return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: BN.max(rem, new BN(0)) };
      }
      const part = total.mul(new BN(String(Math.round(r.weight)))).div(totalWeightBn);
      allocated = allocated.add(part);
      return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: part };
    })
    .filter((c) => c.amountRaw.gt(new BN(0)));
}

// Pure: bagi rentang [fromBinId, toBinId] ke chunk <= maxBinsPerChunk (70 bin)
// dengan bobot merata (Spot) proporsional terhadap jumlah bin di tiap chunk,
// sehingga setiap bin di seluruh rentang menerima jumlah SOL yang sama rata.
export function chunkSpotRanges(fromBinId, toBinId, totalAmountRaw, maxBinsPerChunk = DEFAULT_MAX_BINS_PER_TX) {
  const from = Math.floor(Number(fromBinId));
  const to = Math.floor(Number(toBinId));
  const total = BN.isBN(totalAmountRaw) ? totalAmountRaw : new BN(String(totalAmountRaw || 0));
  const maxChunk = Math.max(1, Math.floor(Number(maxBinsPerChunk) || DEFAULT_MAX_BINS_PER_TX));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || total.lte(new BN(0))) {
    return [];
  }

  const totalBins = to - from + 1;
  if (totalBins <= maxChunk) {
    return [{ minBinId: from, maxBinId: to, amountRaw: total }];
  }

  const ranges = [];
  for (let cur = from; cur <= to; cur += maxChunk) {
    const end = Math.min(cur + maxChunk - 1, to);
    const binCount = end - cur + 1;
    ranges.push({ minBinId: cur, maxBinId: end, binCount });
  }

  const totalBinsBn = new BN(String(totalBins));
  let allocated = new BN(0);

  return ranges
    .map((r, idx) => {
      if (idx === ranges.length - 1) {
        const rem = total.sub(allocated);
        return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: BN.max(rem, new BN(0)) };
      }
      const part = total.mul(new BN(String(r.binCount))).div(totalBinsBn);
      allocated = allocated.add(part);
      return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: part };
    })
    .filter((c) => c.amountRaw.gt(new BN(0)));
}

function parseRawBn(rawVal) {
  const cleanStr = String(rawVal ?? "0").split(".")[0] || "0";
  try {
    return new BN(cleanStr);
  } catch {
    return new BN(0);
  }
}

// Pure: periksa apakah ada likuiditas token base non-zero pada bin [fromBinId .. toBinId].
export function extractTokenSideLiquidity(positionData, fromBinId, toBinId, baseIsX) {
  const bins = positionData?.positionBinData;
  if (!Array.isArray(bins) || bins.length === 0) {
    return { hasBinData: false, hasTokenLiquidity: false, tokenBinsCount: 0, totalTokenRaw: new BN(0) };
  }

  let totalTokenRaw = new BN(0);
  let tokenBinsCount = 0;
  for (const bin of bins) {
    const binId = Number(bin.binId);
    if (!Number.isFinite(binId) || binId < fromBinId || binId > toBinId) continue;
    const rawVal = baseIsX ? bin.positionXAmount : bin.positionYAmount;
    const amtBn = parseRawBn(rawVal);
    if (amtBn.gt(new BN(0))) {
      totalTokenRaw = totalTokenRaw.add(amtBn);
      tokenBinsCount++;
    }
  }

  return {
    hasBinData: true,
    hasTokenLiquidity: totalTokenRaw.gt(new BN(0)),
    tokenBinsCount,
    totalTokenRaw,
  };
}

// Pure: tentukan rentang bin sisi SOL [fromBinId .. toBinId] dan jumlah exact SOL (lamports)
// yang ada di dalam posisi. Jika activeBinId mengandung base token > 0, kecualikan activeBinId
// (pakai toBinId = activeBinId - 1) agar kita hanya menarik SOL dan tidak menarik base token.
export function extractSolSideLiquidity(positionData, lowerBinId, activeBinId, baseIsX) {
  const lower = Math.floor(Number(lowerBinId));
  const active = Math.floor(Number(activeBinId));
  const bins = positionData?.positionBinData;

  if (!Array.isArray(bins) || bins.length === 0) {
    return {
      hasBinData: false,
      hasSolLiquidity: false,
      solBinsCount: 0,
      totalSolLamports: new BN(0),
      fromBinId: lower,
      toBinId: active,
      activeBinHasBase: false,
    };
  }

  let activeBinHasBase = false;
  for (const bin of bins) {
    if (Number(bin.binId) === active) {
      const baseRaw = baseIsX ? bin.positionXAmount : bin.positionYAmount;
      if (parseRawBn(baseRaw).gt(new BN(0))) {
        activeBinHasBase = true;
      }
      break;
    }
  }

  const fromBinId = lower;
  const toBinId = activeBinHasBase ? active - 1 : active;
  if (toBinId < fromBinId) {
    return {
      hasBinData: true,
      hasSolLiquidity: false,
      solBinsCount: 0,
      totalSolLamports: new BN(0),
      fromBinId,
      toBinId,
      activeBinHasBase,
    };
  }

  let totalSolLamports = new BN(0);
  let solBinsCount = 0;
  for (const bin of bins) {
    const binId = Number(bin.binId);
    if (!Number.isFinite(binId) || binId < fromBinId || binId > toBinId) continue;
    const solRaw = baseIsX ? bin.positionYAmount : bin.positionXAmount;
    const amtBn = parseRawBn(solRaw);
    if (amtBn.gt(new BN(0))) {
      totalSolLamports = totalSolLamports.add(amtBn);
      solBinsCount++;
    }
  }

  return {
    hasBinData: true,
    hasSolLiquidity: totalSolLamports.gt(new BN(0)),
    solBinsCount,
    totalSolLamports,
    fromBinId,
    toBinId,
    activeBinHasBase,
  };
}

// Pure: komposisi nilai posisi spot — persen sisi token vs sisi SOL dari total
// nilai posisi. Sisi token dihargai dengan harga SOL-per-token di bin aktif.
// Mengembalikan { tokenPct, solPct } (1 desimal) atau null bila data tidak cukup.
export function computeSpotComposition({
  positionData,
  lowerBinId,
  upperBinId,
  activeBinId,
  baseIsX,
  tokenDecimals,
  solPerToken,
}) {
  const price = Number(solPerToken);
  const tokDec = Number(tokenDecimals);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tokDec) || tokDec < 0) return null;
  const tokenSide = extractTokenSideLiquidity(positionData, activeBinId + 1, upperBinId, baseIsX);
  const solSide = extractSolSideLiquidity(positionData, lowerBinId, activeBinId, baseIsX);
  const tokenUi = Number(tokenSide.totalTokenRaw.toString()) / Math.pow(10, tokDec);
  const solUi = Number(solSide.totalSolLamports.toString()) / 1e9;
  if (!Number.isFinite(tokenUi) || !Number.isFinite(solUi) || tokenUi < 0 || solUi < 0) return null;
  const tokenVal = tokenUi * price;
  const totalVal = tokenVal + solUi;
  if (!Number.isFinite(totalVal) || totalVal <= 0) return null;
  const tokenPct = (tokenVal * 100) / totalVal;
  if (!Number.isFinite(tokenPct)) return null;
  const rounded = Number(tokenPct.toFixed(1));
  return { tokenPct: rounded, solPct: Number(Math.max(0, 100 - rounded).toFixed(1)) };
}

async function fetchPositionOnChain(pool, positionPubKey, walletPubKey) {
  if (typeof pool.getPosition === "function") {
    return await pool.getPosition(positionPubKey);
  }
  if (typeof pool.getPositionsByUserAndLbPair === "function") {
    const { userPositions } = await pool.getPositionsByUserAndLbPair(walletPubKey);
    const target = positionPubKey.toBase58();
    return (
      (userPositions || []).find((p) => p.publicKey?.toBase58?.() === target || String(p.publicKey) === target) || null
    );
  }
  return null;
}

// Helper: bangun & kirim transaksi deposit BidAsk sisi Token utuh yang mulus (tanpa patahan di kelipatan 70 bin).
// - Jika pool menyediakan `addLiquidityByStrategyChunkable` dan rentang > 70 bin, gunakan metode tersebut untuk
//   menghitung 1 kurva BidAsk global `(x0, deltaX, y0, deltaY)` di seluruh [minBinId .. maxBinId] lalu pecah
//   ke transaksi per 70 bin menggunakan `rebalance_liquidity` dengan `shrinkMode = NoShrinkBoth (3)`.
// - Jika <= 70 bin (atau pada unit test mock yang hanya menyediakan `addLiquidityByStrategy`),
//   gunakan `addLiquidityByStrategy`.
async function depositContinuousBidAsk({
  pool,
  positionPubKey,
  wallet,
  connection,
  feePlan,
  sendAndConfirmFn,
  minBinId,
  maxBinId,
  totalXAmount,
  totalYAmount,
  strategyType,
  slippage,
  baseIsX = true,
}) {
  const totalBins = maxBinId - minBinId + 1;
  const signatures = [];

  if (typeof pool.refetchStates === "function") {
    try {
      await pool.refetchStates();
    } catch {}
  }

  if (typeof pool.addLiquidityByStrategyChunkable === "function" && totalBins > DEFAULT_MAX_BINS_PER_TX) {
    const rawAddTxs = await pool.addLiquidityByStrategyChunkable({
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType,
        singleSidedX: false,
      },
      slippage,
    });
    const addTxs = patchRebalanceNoShrink(rawAddTxs);
    for (const tx of addTxs) {
      const sent = await sendAndConfirmFn({
        connection,
        tx,
        signers: [wallet],
        feePlan,
        wallet,
      });
      if (sent?.signature) signatures.push(sent.signature);
    }
    return signatures;
  }

  const rawAmount = baseIsX ? totalXAmount : totalYAmount;
  const chunks = chunkBidAskRanges(minBinId, maxBinId, rawAmount, DEFAULT_MAX_BINS_PER_TX);
  if (chunks.length === 0) {
    throw new Error("chunkBidAskRanges menghasilkan 0 chunk untuk deposit token");
  }

  for (const chunk of chunks) {
    const chunkX = baseIsX ? chunk.amountRaw : new BN(0);
    const chunkY = baseIsX ? new BN(0) : chunk.amountRaw;

    const rawAddTxs = await pool.addLiquidityByStrategy({
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount: chunkX,
      totalYAmount: chunkY,
      strategy: {
        minBinId: chunk.minBinId,
        maxBinId: chunk.maxBinId,
        strategyType,
      },
      slippage,
    });
    const addTxs = Array.isArray(rawAddTxs) ? rawAddTxs : [rawAddTxs];
    for (const tx of addTxs) {
      const sent = await sendAndConfirmFn({
        connection,
        tx,
        signers: [wallet],
        feePlan,
        wallet,
      });
      if (sent?.signature) signatures.push(sent.signature);
    }
  }

  return signatures;
}

// Eksekusi rebalance posisi spot:
// - Saat harga turun tiap step % bin (`action === "rebalance"`): tarik semua token di atas activeBin -> deposit ulang BidAsk mulus.
// - Saat harga naik kembali +step% bin sejak rebalance (`action === "rebalance_sol_spot"`): tarik semua SOL di posisi -> catat jumlahnya -> deposit ulang Spot merata.
export async function handleSpotTokenBidask(pos, deps = {}) {
  const cfg = deps.cfg || config.spotTokenBidask;
  const now = deps.now ? deps.now() : Date.now();
  const tracked = deps.tracked !== undefined ? deps.tracked : getTrackedPosition(pos?.position);

  const decision = evaluateSpotTokenBidaskTrigger({
    pos,
    tracked,
    cfg,
    spotMinBins: deps.spotMinBins ?? config.spotMinBins,
    now,
  });

  const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";

  if (decision.action !== "rebalance" && decision.action !== "rebalance_sol_spot") {
    return { triggered: false, reason: decision.reason, decision };
  }

  if (!pos?.position || !pos?.pool || !pos?.baseMint) {
    return { triggered: false, reason: "missing_position_fields", decision };
  }

  if (rebalanceInProgress.has(pos.position)) {
    log.info(`Spot Rebalance ${pair}: sedang diproses, lewati`);
    return { triggered: false, reason: "in_progress", decision };
  }

  const isSolSpotRebalance = decision.action === "rebalance_sol_spot";
  const isDryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  if (isDryRun) {
    const nextBin = decision.stepLevel > 0 ? Number(pos.activeBin) : null;
    updateSpotTokenBidaskState(pos.position, decision.stepLevel, now, nextBin);
    if (isSolSpotRebalance) {
      log.info(
        `[DRY RUN] Would rebalance spot SOL-side → Spot ${pair} (recover ${decision.lastPct}% → ${decision.stepLevel}%, bin ${decision.solFromBinId}→${decision.solToBinId})`
      );
      return {
        triggered: true,
        success: true,
        dryRun: true,
        rebalanceType: "sol_spot",
        stepLevel: decision.stepLevel,
        fromBinId: decision.solFromBinId,
        toBinId: decision.solToBinId,
      };
    }
    log.info(
      `[DRY RUN] Would rebalance spot token-side → BidAsk ${pair} (step ${decision.stepLevel}%, ${decision.tokenBinPct.toFixed(1)}% bin token, bin ${decision.fromBinId}→${decision.toBinId})`
    );
    return {
      triggered: true,
      success: true,
      dryRun: true,
      rebalanceType: "token_bidask",
      stepLevel: decision.stepLevel,
      fromBinId: decision.fromBinId,
      toBinId: decision.toBinId,
    };
  }

  const getPoolInfoFn = deps.getPoolInfo || getPoolInfo;
  const getDlmmSdkFn = deps.getDlmmSdk || getDlmmSdk;
  const getConnectionFn = deps.getConnection || getConnection;
  const getWalletFn = deps.getWallet || getWallet;
  const getTokenBalanceFn = deps.getTokenBalance || getTokenBalance;
  const getMintDecimalsFn = deps.getMintDecimals || getMintDecimals;
  const buildFeePlanFn = deps.buildFeePlan || buildFeePlan;
  const checkFeeCapFn = deps.checkFeeCap || checkFeeCap;
  const sendAndConfirmFn = deps.sendAndConfirmRobust || sendAndConfirmRobust;
  const sleepFn = deps.sleep || sleep;
  const notifyTokenFn = deps.notifySpotTokenBidask || tg.notifySpotTokenBidask;
  const notifySolFn = deps.notifySpotSolRebalance || deps.notifySpotTokenBidask || tg.notifySpotSolRebalance;

  const baseMint = pos.baseMint;
  const poolAddress = pos.pool;
  const positionAddress = pos.position;

  rebalanceInProgress.add(positionAddress);
  // CRITICAL: Lindungi baseMint dan pool di runtime-state.json sebelum withdraw
  // agar worker wallet (runSafetySweep) TIDAK men-swap token ke SOL saat proses berlangsung!
  addEntryInProgressMint(baseMint);
  addEntryInProgressPool(poolAddress);

  try {
    const { pool, baseIsX, unsupported, pairName } = await getPoolInfoFn(poolAddress);
    if (unsupported) {
      return { triggered: false, success: false, error: "unsupported_pool" };
    }

    const { StrategyType } = await getDlmmSdkFn();
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const positionPubKey = new PublicKey(positionAddress);

    const onChainPos = await fetchPositionOnChain(pool, positionPubKey, wallet.publicKey);
    if (!onChainPos) {
      log.warn(`Spot Rebalance ${pair}: posisi ${positionAddress.slice(0, 8)} tidak ditemukan on-chain`);
      return { triggered: false, success: false, error: "position_not_found" };
    }

    let activeBinId = Number(pos.activeBin);
    if (typeof pool.getActiveBin === "function") {
      try {
        const liveActive = await pool.getActiveBin();
        if (Number.isFinite(Number(liveActive?.binId))) {
          activeBinId = Number(liveActive.binId);
        }
      } catch {}
    }

    const lowerBinId = Number.isFinite(Number(onChainPos.positionData?.lowerBinId))
      ? Number(onChainPos.positionData.lowerBinId)
      : Number(pos.lowerBin);
    const upperBinId = Number.isFinite(Number(onChainPos.positionData?.upperBinId))
      ? Number(onChainPos.positionData.upperBinId)
      : Number(pos.upperBin);

    // Komposisi nilai posisi (token vs SOL) sekarang + yield fee 24 jam — untuk notifikasi.
    let comp = null;
    try {
      const liveBin = typeof pool.getActiveBin === "function" ? await pool.getActiveBin() : null;
      const tokDec = await getMintDecimalsFn(baseMint);
      comp = computeSpotComposition({
        positionData: onChainPos.positionData,
        lowerBinId,
        upperBinId,
        activeBinId,
        baseIsX,
        tokenDecimals: tokDec,
        solPerToken: poolPriceSolPerToken(liveBin, baseIsX),
      });
    } catch (err) {
      log.warn(`Spot Rebalance ${pair}: komposisi gagal dihitung (${err.message || err}) — notifikasi tanpa komposisi`);
    }
    const feePct24h = Number.isFinite(Number(pos.feePct24h)) ? Number(pos.feePct24h) : null;

    // --- JALUR A: Rebalance sisi SOL kembali ke Spot murni saat harga naik +step% dari posisi rebalance ---
    if (isSolSpotRebalance) {
      if (activeBinId < lowerBinId || activeBinId > upperBinId) {
        log.info(
          `Spot SOL Rebalance ${pair}: activeBin ${activeBinId} di luar rentang ${lowerBinId}→${upperBinId} — batal`
        );
        return { triggered: false, skipped: true, reason: "active_bin_moved" };
      }

      const solCheck = extractSolSideLiquidity(onChainPos.positionData, lowerBinId, activeBinId, baseIsX);
      const fromBinId = solCheck.fromBinId;
      const toBinId = solCheck.toBinId;

      if (toBinId < fromBinId || (solCheck.hasBinData && !solCheck.hasSolLiquidity)) {
        log.info(`Spot SOL Rebalance ${pair}: tidak ada likuiditas SOL di bin ${fromBinId}→${toBinId} — dilewati`);
        updateSpotTokenBidaskState(
          positionAddress,
          decision.stepLevel,
          Date.now(),
          decision.stepLevel > 0 ? activeBinId : null
        );
        return { triggered: false, skipped: true, reason: "no_sol_liquidity" };
      }

      const feePlan = buildFeePlanFn();
      const feeCap = checkFeeCapFn(feePlan);
      if (!feeCap.ok) {
        const errMsg = `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`;
        log.warn(`Spot SOL Rebalance ${pair} ditunda: ${errMsg}`);
        return { triggered: false, success: false, error: errMsg, feeCap: true };
      }

      let solBalanceBeforeLamports = null;
      if (typeof connection?.getBalance === "function") {
        try {
          solBalanceBeforeLamports = await connection.getBalance(wallet.publicKey);
        } catch {}
      }

      const label = pairName || pair;
      const recordedSolUi = Number(solCheck.totalSolLamports.toString()) / 1e9;
      log.info(
        `🔄 SPOT SOL REBALANCE ${label} — tarik semua (${recordedSolUi > 0 ? `${recordedSolUi.toFixed(4)} ` : ""}SOL) dari bin ${fromBinId}→${toBinId} lalu add Spot (recover ${decision.lastPct}% → ${decision.stepLevel}%)`
      );

      // 1. Tarik 100% seluruh likuiditas SOL dari [fromBinId .. toBinId] terlebih dahulu tanpa menutup posisi.
      const rawRemoveTxs = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId,
        toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: false,
      });
      const removeTxs = Array.isArray(rawRemoveTxs) ? rawRemoveTxs : [rawRemoveTxs];
      const removeSignatures = [];
      for (const tx of removeTxs) {
        const sent = await sendAndConfirmFn({
          connection,
          tx,
          signers: [wallet],
          feePlan,
          wallet,
        });
        if (sent?.signature) removeSignatures.push(sent.signature);
      }

      // 2. Catat jumlah exact SOL yang ditarik dari posisi (dibatasi saldo wallet setelah dikurangi gas reserve).
      let solBalanceAfterLamports = null;
      if (typeof connection?.getBalance === "function") {
        try {
          solBalanceAfterLamports = await connection.getBalance(wallet.publicKey);
        } catch {}
      }

      let targetSolLamports = solCheck.totalSolLamports;
      if (
        targetSolLamports.lte(new BN(0)) &&
        solBalanceBeforeLamports != null &&
        solBalanceAfterLamports != null &&
        solBalanceAfterLamports > solBalanceBeforeLamports
      ) {
        targetSolLamports = new BN(String(Math.floor(solBalanceAfterLamports - solBalanceBeforeLamports)));
      }

      if (solBalanceAfterLamports != null && Number.isFinite(Number(solBalanceAfterLamports))) {
        const gasReserveSol = Number(config.wallet?.minSolReserve ?? config.entry?.gasReserve ?? 0.05) || 0;
        const gasReserveLamports = new BN(String(Math.floor(gasReserveSol * 1e9)));
        const afterBn = new BN(String(Math.floor(Number(solBalanceAfterLamports))));
        const maxAvailableLamports = BN.max(new BN(0), afterBn.sub(gasReserveLamports));
        targetSolLamports = BN.min(targetSolLamports, maxAvailableLamports);
      }

      const spotStrategyType = StrategyType?.Spot ?? 0;
      const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
      let lastErr = null;
      let remainingSolRaw = targetSolLamports;
      let nextFromBinId = fromBinId;
      const addSignatures = [];

      for (let attempt = 1; attempt <= maxRetry; attempt++) {
        try {
          if (targetSolLamports.lte(new BN(0))) {
            throw new Error("jumlah SOL yang ditarik dari posisi 0 atau di bawah cadangan gas");
          }
          if (remainingSolRaw.lte(new BN(0))) break;

          let depositToBinId = toBinId;
          if (attempt > 1 && typeof pool.getActiveBin === "function") {
            try {
              const refreshed = await pool.getActiveBin();
              if (Number.isFinite(Number(refreshed?.binId))) {
                const maxAllowedBin = solCheck.activeBinHasBase
                  ? Number(refreshed.binId) - 1
                  : Number(refreshed.binId);
                depositToBinId = Math.max(nextFromBinId, Math.min(toBinId, maxAllowedBin));
              }
            } catch {}
          }

          const chunks = chunkSpotRanges(nextFromBinId, depositToBinId, remainingSolRaw, DEFAULT_MAX_BINS_PER_TX);
          if (chunks.length === 0) {
            throw new Error("chunkSpotRanges menghasilkan 0 chunk untuk deposit SOL");
          }

          for (const chunk of chunks) {
            const totalXAmount = baseIsX ? new BN(0) : chunk.amountRaw;
            const totalYAmount = baseIsX ? chunk.amountRaw : new BN(0);

            const rawAddTxs = await pool.addLiquidityByStrategy({
              positionPubKey,
              user: wallet.publicKey,
              totalXAmount,
              totalYAmount,
              strategy: {
                minBinId: chunk.minBinId,
                maxBinId: chunk.maxBinId,
                strategyType: spotStrategyType,
              },
              slippage: config.entry.activeBinSlippagePct,
            });
            const addTxs = Array.isArray(rawAddTxs) ? rawAddTxs : [rawAddTxs];
            for (const tx of addTxs) {
              const sent = await sendAndConfirmFn({
                connection,
                tx,
                signers: [wallet],
                feePlan,
                wallet,
              });
              if (sent?.signature) addSignatures.push(sent.signature);
            }
            remainingSolRaw = BN.max(new BN(0), remainingSolRaw.sub(chunk.amountRaw));
            nextFromBinId = chunk.maxBinId + 1;
          }

          lastErr = null;
          break;
        } catch (err) {
          lastErr = err.message || String(err);
          log.warn(`Spot SOL Rebalance ${label}: gagal re-deposit Spot (${attempt}/${maxRetry}): ${lastErr}`);
          if (attempt < maxRetry) await sleepFn(2500);
        }
      }

      const depositedSolUi = Number(targetSolLamports.toString()) / 1e9;

      if (lastErr) {
        log.error(`Spot SOL Rebalance ${label}: gagal re-deposit Spot setelah ${maxRetry}x (${lastErr})`);
        recordAction(
          `SPOT SOL REBALANCE ${label} GAGAL (recover ${decision.lastPct}%→${decision.stepLevel}%) — ${lastErr}`
        );
        notifySolFn({
          rebalanceType: "sol_spot",
          pair: label,
          pool: poolAddress,
          position: positionAddress,
          lastPct: decision.lastPct,
          stepPct: decision.stepLevel,
          fromBinId,
          toBinId,
          amountSol: depositedSolUi,
          amount: depositedSolUi,
          success: false,
          error: lastErr,
        });
        return {
          triggered: true,
          success: false,
          rebalanceType: "sol_spot",
          error: lastErr,
          stepLevel: decision.stepLevel,
          removeSignatures,
        };
      }

      updateSpotTokenBidaskState(
        positionAddress,
        decision.stepLevel,
        Date.now(),
        decision.stepLevel > 0 ? activeBinId : null
      );
      log.info(
        `✅ SPOT SOL REBALANCE ${label} — recover ${decision.lastPct}% → ${decision.stepLevel}% (bin ${fromBinId}→${toBinId}) — ${depositedSolUi.toFixed(4)} SOL diatur kembali ke Spot`
      );
      recordAction(
        `SPOT SOL REBALANCE ${label} — recover ${decision.lastPct}%→${decision.stepLevel}% (${depositedSolUi.toFixed(4)} SOL, bin ${fromBinId}→${toBinId})`
      );
      notifySolFn({
        rebalanceType: "sol_spot",
        pair: label,
        pool: poolAddress,
        position: positionAddress,
        lastPct: decision.lastPct,
        stepPct: decision.stepLevel,
        fromBinId,
        toBinId,
        amountSol: depositedSolUi,
        amount: depositedSolUi,
        tokenPct: comp?.tokenPct ?? null,
        solPct: comp?.solPct ?? null,
        feePct24h,
        success: true,
      });

      return {
        triggered: true,
        success: true,
        rebalanceType: "sol_spot",
        lastPct: decision.lastPct,
        stepLevel: decision.stepLevel,
        fromBinId,
        toBinId,
        amountSol: depositedSolUi,
        amountSolLamports: targetSolLamports.toString(),
        removeSignatures,
        addSignatures,
      };
    }

    // --- JALUR B: Rebalance sisi token ke BidAsk mulus saat harga turun tiap kelipatan step % bin ---
    const bidAskStrategyType = StrategyType?.BidAsk ?? 2;

    if (activeBinId < lowerBinId || activeBinId >= upperBinId) {
      log.info(
        `Spot Token BidAsk ${pair}: activeBin ${activeBinId} tidak lagi di bawah upperBin ${upperBinId} — batal`
      );
      return { triggered: false, skipped: true, reason: "active_bin_moved" };
    }

    const fromBinId = activeBinId + 1;
    const toBinId = upperBinId;

    const liqCheck = extractTokenSideLiquidity(onChainPos.positionData, fromBinId, toBinId, baseIsX);
    if (liqCheck.hasBinData && !liqCheck.hasTokenLiquidity) {
      log.info(`Spot Token BidAsk ${pair}: tidak ada likuiditas token di bin ${fromBinId}→${toBinId} — dilewati`);
      updateSpotTokenBidaskState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
      return { triggered: false, skipped: true, reason: "no_token_liquidity" };
    }

    const feePlan = buildFeePlanFn();
    const feeCap = checkFeeCapFn(feePlan);
    if (!feeCap.ok) {
      const errMsg = `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`;
      log.warn(`Spot Token BidAsk ${pair} ditunda: ${errMsg}`);
      return { triggered: false, success: false, error: errMsg, feeCap: true };
    }

    const label = pairName || pair;
    log.info(
      `📐 SPOT TOKEN BIDASK ${label} — tarik semua token dari bin ${fromBinId}→${toBinId} lalu add BidAsk (step ${decision.stepLevel}%, ${decision.tokenBinPct.toFixed(1)}% bin token)`
    );

    // 1. Tarik 100% seluruh likuiditas dari bin di atas activeBin (fromBinId .. toBinId) terlebih dahulu tanpa menutup posisi.
    const rawRemoveTxs = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(10000),
      shouldClaimAndClose: false,
    });
    const removeTxs = Array.isArray(rawRemoveTxs) ? rawRemoveTxs : [rawRemoveTxs];
    const removeSignatures = [];
    for (const tx of removeTxs) {
      const sent = await sendAndConfirmFn({
        connection,
        tx,
        signers: [wallet],
        feePlan,
        wallet,
      });
      if (sent?.signature) removeSignatures.push(sent.signature);
    }

    // 2. Baca saldo base token di wallet dan deposit ulang 100% ke posisi yang sama dengan kurva BidAsk utuh yang mulus.
    const decimals = await getMintDecimalsFn(baseMint);
    const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
    let lastErr = null;
    let depositedUi = 0;
    const addSignatures = [];

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        const balanceUi = await getTokenBalanceFn(baseMint);
        if (!Number.isFinite(balanceUi) || balanceUi <= 0) {
          if (depositedUi > 0) break;
          throw new Error("saldo token base 0 setelah removeLiquidity");
        }

        const baseAmountRaw = new BN(Math.floor(balanceUi * Math.pow(10, decimals)));
        if (baseAmountRaw.lte(new BN(0))) {
          if (depositedUi > 0) break;
          throw new Error("jumlah raw token base 0 setelah konversi desimal");
        }

        let depositFromBinId = fromBinId;
        if (typeof pool.getActiveBin === "function") {
          try {
            const refreshed = await pool.getActiveBin();
            if (Number.isFinite(Number(refreshed?.binId))) {
              depositFromBinId = Math.min(toBinId, Math.max(lowerBinId, Number(refreshed.binId) + 1));
            }
          } catch {}
        }

        const totalXAmount = baseIsX ? baseAmountRaw : new BN(0);
        const totalYAmount = baseIsX ? new BN(0) : baseAmountRaw;

        const sigs = await depositContinuousBidAsk({
          pool,
          positionPubKey,
          wallet,
          connection,
          feePlan,
          sendAndConfirmFn,
          minBinId: depositFromBinId,
          maxBinId: toBinId,
          totalXAmount,
          totalYAmount,
          strategyType: bidAskStrategyType,
          slippage: config.entry.activeBinSlippagePct,
          baseIsX,
        });
        addSignatures.push(...sigs);

        depositedUi = balanceUi;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err.message || String(err);
        log.warn(`Spot Token BidAsk ${label}: gagal re-deposit BidAsk (${attempt}/${maxRetry}): ${lastErr}`);
        if (attempt < maxRetry) await sleepFn(2500);
      }
    }

    if (lastErr) {
      log.error(
        `Spot Token BidAsk ${label}: gagal re-deposit setelah ${maxRetry}x (${lastErr}) — kunci dilepas agar bisa di-sweep`
      );
      recordAction(`SPOT BIDASK ${label} GAGAL (step ${decision.stepLevel}%) — ${lastErr}`);
      notifyTokenFn({
        rebalanceType: "token_bidask",
        pair: label,
        pool: poolAddress,
        position: positionAddress,
        stepPct: decision.stepLevel,
        tokenBinPct: decision.tokenBinPct,
        fromBinId,
        toBinId,
        success: false,
        error: lastErr,
      });
      return {
        triggered: true,
        success: false,
        rebalanceType: "token_bidask",
        error: lastErr,
        stepLevel: decision.stepLevel,
        removeSignatures,
      };
    }

    updateSpotTokenBidaskState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
    log.info(
      `✅ SPOT TOKEN BIDASK ${label} — step ${decision.stepLevel}% (${decision.tokenBinPct.toFixed(1)}% bin token, bin ${fromBinId}→${toBinId}) — ${depositedUi} token diatur ke BidAsk`
    );
    recordAction(`SPOT BIDASK ${label} — step ${decision.stepLevel}% (bin ${fromBinId}→${toBinId})`);
    notifyTokenFn({
      rebalanceType: "token_bidask",
      pair: label,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      fromBinId,
      toBinId,
      amount: depositedUi,
      tokenPct: comp?.tokenPct ?? null,
      solPct: comp?.solPct ?? null,
      feePct24h,
      success: true,
    });

    return {
      triggered: true,
      success: true,
      rebalanceType: "token_bidask",
      stepLevel: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      fromBinId,
      toBinId,
      amount: depositedUi,
      removeSignatures,
      addSignatures,
    };
  } catch (err) {
    const msg = err.message || String(err);
    log.error(`Spot Rebalance ${pair} error: ${msg}`);
    recordAction(`SPOT REBALANCE ${pair} ERROR — ${msg}`);
    const notifyErrFn = isSolSpotRebalance ? notifySolFn : notifyTokenFn;
    notifyErrFn({
      rebalanceType: isSolSpotRebalance ? "sol_spot" : "token_bidask",
      pair,
      pool: poolAddress,
      position: positionAddress,
      lastPct: decision.lastPct,
      stepPct: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      fromBinId: isSolSpotRebalance ? decision.solFromBinId : decision.fromBinId,
      toBinId: isSolSpotRebalance ? decision.solToBinId : decision.toBinId,
      success: false,
      error: msg,
    });
    return {
      triggered: true,
      success: false,
      rebalanceType: isSolSpotRebalance ? "sol_spot" : "token_bidask",
      error: msg,
      stepLevel: decision.stepLevel,
    };
  } finally {
    removeEntryInProgressMint(baseMint);
    removeEntryInProgressPool(poolAddress);
    rebalanceInProgress.delete(positionAddress);
  }
}
