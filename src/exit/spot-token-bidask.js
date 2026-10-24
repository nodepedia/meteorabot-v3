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
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  recordAction,
} from "../entry/runtime.js";
import { getTrackedPosition, updateSpotTokenBidaskState } from "../state/positions.js";

const DEFAULT_MAX_BINS_PER_TX = 70;
const rebalanceInProgress = new Set();

// Pure: hitung metrik bin token di atas activeBin untuk posisi spot.
// Ketika harga turun di dalam rentang (lowerBin <= activeBin < upperBin),
// bin di (activeBin + 1 .. upperBin) berisi token base, sedangkan bin <= activeBin berisi SOL.
export function calcSpotTokenBinMetrics({ activeBin, lowerBin, upperBin, stepPct = 15 }) {
  const active = Number(activeBin);
  const lower = Number(lowerBin);
  const upper = Number(upperBin);
  const step = Math.max(1, Number(stepPct) || 15);

  if (!Number.isFinite(active) || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    return {
      inRange: false,
      binSpan: 0,
      tokenBins: 0,
      tokenBinPct: 0,
      stepLevel: 0,
      fromBinId: null,
      toBinId: null,
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
  };
}

// Pure: evaluasi apakah posisi spot perlu di-rebalance sisi tokennya ke BidAsk,
// ditahan karena cooldown, atau di-reset level step-nya saat harga kembali naik.
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
    Number.isFinite(lowerBin) && Number.isFinite(upperBin) ? upperBin - lowerBin : Number(pos.binSpan ?? tracked?.binSpan);

  const minBins = Math.max(1, Number(spotMinBins) || 200);
  if (!Number.isFinite(binSpan) || binSpan < minBins) {
    return { action: "none", reason: "span_below_min", binSpan };
  }

  const step = Math.max(1, Number(cfg.stepPct) || 15);
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
  const cooldownMs = Math.max(0, Number(cfg.cooldownSec) || 0) * 1000;

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

  if (metrics.stepLevel < lastPct) {
    return {
      action: "reset_down",
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
// dengan bobot linear BidAsk (bin lebih jauh di atas activeBin mendapat porsi
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

  return ranges.map((r, idx) => {
    if (idx === ranges.length - 1) {
      const rem = total.sub(allocated);
      return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: BN.max(rem, new BN(0)) };
    }
    const part = total.mul(new BN(String(Math.round(r.weight)))).div(totalWeightBn);
    allocated = allocated.add(part);
    return { minBinId: r.minBinId, maxBinId: r.maxBinId, amountRaw: part };
  }).filter((c) => c.amountRaw.gt(new BN(0)));
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
    const cleanStr = String(rawVal ?? "0").split(".")[0] || "0";
    let amtBn;
    try {
      amtBn = new BN(cleanStr);
    } catch {
      amtBn = new BN(0);
    }
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

async function fetchPositionOnChain(pool, positionPubKey, walletPubKey) {
  if (typeof pool.getPosition === "function") {
    return await pool.getPosition(positionPubKey);
  }
  if (typeof pool.getPositionsByUserAndLbPair === "function") {
    const { userPositions } = await pool.getPositionsByUserAndLbPair(walletPubKey);
    const target = positionPubKey.toBase58();
    return (userPositions || []).find((p) => p.publicKey?.toBase58?.() === target || String(p.publicKey) === target) || null;
  }
  return null;
}

// Eksekusi rebalance sisi token posisi spot ke distribusi BidAsk saat mencapai step 15% berikutnya.
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

  if (decision.action === "reset_down") {
    updateSpotTokenBidaskState(pos.position, decision.stepLevel, tracked?.lastSpotTokenBidaskAt ?? null);
    log.debug(
      `[detail] ${pair}: harga naik kembali (${decision.tokenBinPct.toFixed(1)}% bin token) — reset step BidAsk ${decision.lastPct}% → ${decision.stepLevel}%`
    );
    return { triggered: false, resetDown: true, stepLevel: decision.stepLevel, decision };
  }

  if (decision.action !== "rebalance") {
    return { triggered: false, reason: decision.reason, decision };
  }

  if (!pos?.position || !pos?.pool || !pos?.baseMint) {
    return { triggered: false, reason: "missing_position_fields", decision };
  }

  if (rebalanceInProgress.has(pos.position)) {
    log.info(`Spot Token BidAsk ${pair}: sedang diproses, lewati`);
    return { triggered: false, reason: "in_progress", decision };
  }

  const isDryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  if (isDryRun) {
    updateSpotTokenBidaskState(pos.position, decision.stepLevel, now);
    log.info(
      `[DRY RUN] Would rebalance spot token-side → BidAsk ${pair} (step ${decision.stepLevel}%, ${decision.tokenBinPct.toFixed(1)}% bin token, bin ${decision.fromBinId}→${decision.toBinId})`
    );
    return {
      triggered: true,
      success: true,
      dryRun: true,
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
  const notifyFn = deps.notifySpotTokenBidask || tg.notifySpotTokenBidask;

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
    const strategyType = StrategyType?.BidAsk ?? 2;

    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const positionPubKey = new PublicKey(positionAddress);

    const onChainPos = await fetchPositionOnChain(pool, positionPubKey, wallet.publicKey);
    if (!onChainPos) {
      log.warn(`Spot Token BidAsk ${pair}: posisi ${positionAddress.slice(0, 8)} tidak ditemukan on-chain`);
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

    if (activeBinId < lowerBinId || activeBinId >= upperBinId) {
      log.info(`Spot Token BidAsk ${pair}: activeBin ${activeBinId} tidak lagi di bawah upperBin ${upperBinId} — batal`);
      return { triggered: false, skipped: true, reason: "active_bin_moved" };
    }

    const fromBinId = activeBinId + 1;
    const toBinId = upperBinId;

    const liqCheck = extractTokenSideLiquidity(onChainPos.positionData, fromBinId, toBinId, baseIsX);
    if (liqCheck.hasBinData && !liqCheck.hasTokenLiquidity) {
      log.info(`Spot Token BidAsk ${pair}: tidak ada likuiditas token di bin ${fromBinId}→${toBinId} — dilewati`);
      updateSpotTokenBidaskState(positionAddress, decision.stepLevel, Date.now());
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
      `📐 SPOT TOKEN BIDASK ${label} — tarik token dari bin ${fromBinId}→${toBinId} (step ${decision.stepLevel}%, ${decision.tokenBinPct.toFixed(1)}% bin token)`
    );

    // 1. Tarik 100% likuiditas hanya dari bin di atas activeBin (fromBinId .. toBinId) tanpa menutup posisi.
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

    // 2. Baca saldo base token di wallet dan deposit ulang 100% ke posisi yang sama dengan strategi BidAsk.
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
        if (attempt > 1 && typeof pool.getActiveBin === "function") {
          try {
            const refreshed = await pool.getActiveBin();
            if (Number.isFinite(Number(refreshed?.binId))) {
              depositFromBinId = Math.min(toBinId, Math.max(lowerBinId, Number(refreshed.binId) + 1));
            }
          } catch {}
        }

        const chunks = chunkBidAskRanges(depositFromBinId, toBinId, baseAmountRaw, DEFAULT_MAX_BINS_PER_TX);
        for (const chunk of chunks) {
          const totalXAmount = baseIsX ? chunk.amountRaw : new BN(0);
          const totalYAmount = baseIsX ? new BN(0) : chunk.amountRaw;

          const rawAddTxs = await pool.addLiquidityByStrategy({
            positionPubKey,
            user: wallet.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
              minBinId: chunk.minBinId,
              maxBinId: chunk.maxBinId,
              strategyType,
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
        }

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
      notifyFn({
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
        error: lastErr,
        stepLevel: decision.stepLevel,
        removeSignatures,
      };
    }

    updateSpotTokenBidaskState(positionAddress, decision.stepLevel, Date.now());
    log.info(
      `✅ SPOT TOKEN BIDASK ${label} — step ${decision.stepLevel}% (${decision.tokenBinPct.toFixed(1)}% bin token, bin ${fromBinId}→${toBinId}) — ${depositedUi} token diatur ke BidAsk`
    );
    recordAction(`SPOT BIDASK ${label} — step ${decision.stepLevel}% (bin ${fromBinId}→${toBinId})`);
    notifyFn({
      pair: label,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      fromBinId,
      toBinId,
      amount: depositedUi,
      success: true,
    });

    return {
      triggered: true,
      success: true,
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
    log.error(`Spot Token BidAsk ${pair} error: ${msg}`);
    recordAction(`SPOT BIDASK ${pair} ERROR — ${msg}`);
    notifyFn({
      pair,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      fromBinId: decision.fromBinId,
      toBinId: decision.toBinId,
      success: false,
      error: msg,
    });
    return { triggered: true, success: false, error: msg, stepLevel: decision.stepLevel };
  } finally {
    removeEntryInProgressMint(baseMint);
    removeEntryInProgressPool(poolAddress);
    rebalanceInProgress.delete(positionAddress);
  }
}
