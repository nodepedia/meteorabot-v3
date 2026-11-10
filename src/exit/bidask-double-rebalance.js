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
import { readPoolSolPerToken } from "../entry/pool-price.js";
import { poolPriceChangePct } from "../state/dca.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  protectMint,
  releaseMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  isEntryInProgressPool,
  isPoolClosing,
  recordAction,
} from "../entry/runtime.js";
import { getTrackedPosition, getPoolTrackedPositions, updateBidaskDoubleRebalanceState } from "../state/positions.js";
import { depositContinuousBidAsk, extractTokenSideLiquidity } from "./spot-token-bidask.js";

const rebalanceInProgress = new Set();

// Step dari turunnya harga pool vs entry posisi ini.
// -10% → 10, -19.9% → 10, -20% → 20. Harga naik atau flat → 0.
export function bidaskDoubleStepLevel(priceChangePct, stepPct = 10) {
  const step = Math.max(1, Number(stepPct) || 10);
  const change = Number(priceChangePct);
  if (!Number.isFinite(change) || change >= 0) return 0;
  return Math.floor((-change + 1e-9) / step) * step;
}

// Bin token yang dibentuk ulang. Tidak menyentuh bin aktif (bisa campur SOL+token)
// dan tidak menyentuh bin di bawahnya (sisi SOL).
// - Masih di dalam range: (active+1 .. upper).
// - Harga sudah di bawah range: seluruh posisi ada di atas active dan isinya token,
//   jadi (lower .. upper).
// - Active di upper atau di atasnya: tidak ada token di atas active.
export function tokenSideBinsForBidaskRebalance(activeBinId, lowerBinId, upperBinId) {
  const active = Number(activeBinId);
  const lower = Number(lowerBinId);
  const upper = Number(upperBinId);
  if (!Number.isFinite(active) || !Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) {
    return null;
  }
  if (active >= upper) return null;
  const fromBinId = active < lower ? lower : active + 1;
  if (fromBinId > upper) return null;
  return { fromBinId, toBinId: upper };
}

export function poolHasPendingDcaConfirm(trackedList) {
  return (trackedList || []).some((t) => t && t.closed !== true && t.pendingDcaTrough != null);
}

// Rebalance tidak jalan bersamaan dengan eksekusi apa pun di pool yang sama,
// dan tidak jalan selagi konfirmasi rebound DCA masih pending.
export function evaluateBidaskDoubleRebalance({
  pos,
  tracked,
  cfg,
  now = Date.now(),
  priceChangePct = null,
  entryInProgress = false,
  poolClosing = false,
  dcaConfirmPending = false,
}) {
  if (!pos || pos.mode !== "bidask:double") {
    return { action: "none", reason: "not_bidask_double" };
  }
  if (!cfg?.enabled) return { action: "none", reason: "disabled" };
  if (dcaConfirmPending) return { action: "none", reason: "dca_confirm_pending" };
  if (entryInProgress) return { action: "none", reason: "entry_in_progress" };
  if (poolClosing) return { action: "none", reason: "pool_closing" };

  const entry = Number(tracked?.entryPoolPrice);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { action: "none", reason: "no_entry_price" };
  }
  if (priceChangePct == null || !Number.isFinite(Number(priceChangePct))) {
    return { action: "none", reason: "no_pool_price" };
  }
  const change = Number(priceChangePct);

  const step = Math.max(1, Number(cfg.stepPct) || 10);
  const stepLevel = bidaskDoubleStepLevel(change, step);
  const lastPct = Math.max(0, Number(tracked?.lastBidaskDoubleRebalancePct) || 0);
  const lastAt = Number(tracked?.lastBidaskDoubleRebalanceAt) || 0;
  const cooldownMs = Math.max(0, Number(cfg.cooldownSec) || 0) * 1000;

  if (stepLevel >= lastPct + step && stepLevel >= step) {
    if (lastAt > 0 && cooldownMs > 0 && now - lastAt < cooldownMs) {
      return {
        action: "cooldown",
        reason: "cooldown",
        remainingMs: cooldownMs - (now - lastAt),
        lastPct,
        stepLevel,
        priceChangePct: change,
      };
    }
    return {
      action: "rebalance",
      reason: `step_${stepLevel}pct`,
      lastPct,
      stepLevel,
      priceChangePct: change,
    };
  }

  return { action: "none", reason: "below_next_step", lastPct, stepLevel, priceChangePct: change };
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

function livePoolBlock(pool) {
  if (!pool) return null;
  if (poolHasPendingDcaConfirm(getPoolTrackedPositions(pool))) return "dca_confirm_pending";
  if (isEntryInProgressPool(pool)) return "entry_in_progress";
  if (isPoolClosing(pool)) return "pool_closing";
  return null;
}

// Tarik token di atas bin aktif, setor ulang ke posisi yang sama dengan kurva BidAsk.
// Tidak menyetor SOL, tidak menutup posisi, tidak mengecilkan range
// (deposit >70 bin lewat rebalance_liquidity + NoShrinkBoth, sama seperti spot).
export async function handleBidaskDoubleRebalance(pos, deps = {}) {
  const cfg = deps.cfg || config.bidaskDoubleRebalance;
  const now = deps.now ? deps.now() : Date.now();
  const tracked = deps.tracked !== undefined ? deps.tracked : getTrackedPosition(pos?.position);
  const poolTracked =
    deps.poolTracked !== undefined ? deps.poolTracked : pos?.pool ? getPoolTrackedPositions(pos.pool) : [];

  let priceChangePct = deps.priceChangePct;
  if (priceChangePct === undefined) {
    const entry = Number(tracked?.entryPoolPrice);
    if (!Number.isFinite(entry) || entry <= 0) priceChangePct = null;
    else {
      try {
        const read = deps.readPoolSolPerToken || readPoolSolPerToken;
        const nowPrice = deps.nowPrice !== undefined ? deps.nowPrice : await read(pos?.pool);
        priceChangePct = poolPriceChangePct(entry, nowPrice);
      } catch (err) {
        log.debug(`[detail] BidAsk rebalance ${pos?.position?.slice(0, 8) || "?"}: harga gagal (${err.message})`);
        priceChangePct = null;
      }
    }
  }

  const decision = evaluateBidaskDoubleRebalance({
    pos,
    tracked,
    cfg,
    now,
    priceChangePct,
    entryInProgress:
      deps.entryInProgress !== undefined ? deps.entryInProgress : pos?.pool ? isEntryInProgressPool(pos.pool) : false,
    poolClosing: deps.poolClosing !== undefined ? deps.poolClosing : pos?.pool ? isPoolClosing(pos.pool) : false,
    dcaConfirmPending:
      deps.dcaConfirmPending !== undefined ? deps.dcaConfirmPending : poolHasPendingDcaConfirm(poolTracked),
  });

  const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";
  if (decision.action !== "rebalance") {
    return { triggered: false, reason: decision.reason, decision };
  }
  if (!pos?.position || !pos?.pool || !pos?.baseMint) {
    return { triggered: false, reason: "missing_position_fields", decision };
  }
  if (rebalanceInProgress.has(pos.position)) {
    return { triggered: false, reason: "in_progress", decision };
  }

  // Cek ulang dari disk sebelum kunci, supaya konfirmasi DCA yang baru
  // masuk tidak ketimpa rebalance.
  if (!deps.skipLiveGuard) {
    const live = livePoolBlock(pos.pool);
    if (live) return { triggered: false, reason: live, decision };
  }

  const isDryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  if (isDryRun) {
    updateBidaskDoubleRebalanceState(pos.position, decision.stepLevel, now);
    log.info(
      `[DRY RUN] Would rebalance bidask:double token→BidAsk ${pair} (step ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
    );
    return { triggered: true, success: true, dryRun: true, stepLevel: decision.stepLevel, decision };
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
  const notifyFn = deps.notifyBidaskDoubleRebalance || tg.notifyBidaskDoubleRebalance;
  const depositFn = deps.depositContinuousBidAsk || depositContinuousBidAsk;

  const baseMint = pos.baseMint;
  const poolAddress = pos.pool;
  const positionAddress = pos.position;

  rebalanceInProgress.add(positionAddress);
  addEntryInProgressMint(baseMint);
  protectMint(baseMint, "bidask_rebalance");
  addEntryInProgressPool(poolAddress);

  try {
    const again = livePoolBlock(poolAddress);
    if (again === "dca_confirm_pending") {
      return { triggered: false, reason: again, decision };
    }

    const { pool, baseIsX, unsupported, pairName } = await getPoolInfoFn(poolAddress);
    if (unsupported) return { triggered: false, success: false, error: "unsupported_pool" };

    const { StrategyType } = await getDlmmSdkFn();
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const positionPubKey = new PublicKey(positionAddress);
    const onChainPos = await fetchPositionOnChain(pool, positionPubKey, wallet.publicKey);
    if (!onChainPos) {
      log.warn(`BidAsk rebalance ${pair}: posisi tidak ditemukan on-chain`);
      return { triggered: false, success: false, error: "position_not_found" };
    }

    let activeBinId = Number(pos.activeBin);
    if (typeof pool.getActiveBin === "function") {
      try {
        const liveActive = await pool.getActiveBin();
        if (Number.isFinite(Number(liveActive?.binId))) activeBinId = Number(liveActive.binId);
      } catch {
        // pakai activeBin dari snapshot exit
      }
    }
    const lowerBinId = Number.isFinite(Number(onChainPos.positionData?.lowerBinId))
      ? Number(onChainPos.positionData.lowerBinId)
      : Number(pos.lowerBin);
    const upperBinId = Number.isFinite(Number(onChainPos.positionData?.upperBinId))
      ? Number(onChainPos.positionData.upperBinId)
      : Number(pos.upperBin);
    const span = tokenSideBinsForBidaskRebalance(activeBinId, lowerBinId, upperBinId);
    if (!span) {
      log.info(`BidAsk rebalance ${pair}: tidak ada bin token di atas active ${activeBinId} — step dicatat`);
      updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now());
      return { triggered: false, skipped: true, reason: "no_token_bins", decision };
    }

    const { fromBinId, toBinId } = span;
    const liqCheck = extractTokenSideLiquidity(onChainPos.positionData, fromBinId, toBinId, baseIsX);
    if (liqCheck.hasBinData && !liqCheck.hasTokenLiquidity) {
      log.info(`BidAsk rebalance ${pair}: tidak ada likuiditas token di bin ${fromBinId}→${toBinId} — step dicatat`);
      updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now());
      return { triggered: false, skipped: true, reason: "no_token_liquidity", decision };
    }

    const feePlan = buildFeePlanFn();
    const feeCap = checkFeeCapFn(feePlan);
    if (!feeCap.ok) {
      const errMsg = `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`;
      log.warn(`BidAsk rebalance ${pair} ditunda: ${errMsg}`);
      return { triggered: false, success: false, error: errMsg, feeCap: true };
    }

    const label = pairName || pair;
    log.info(
      `📐 BIDASK REBALANCE ${label} — tarik token bin ${fromBinId}→${toBinId} lalu add BidAsk (step ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
    );

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
      const sent = await sendAndConfirmFn({ connection, tx, signers: [wallet], feePlan, wallet });
      if (sent?.signature) removeSignatures.push(sent.signature);
    }

    const decimals = await getMintDecimalsFn(baseMint);
    const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
    const bidAskStrategyType = StrategyType?.BidAsk ?? 2;
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
              const next = tokenSideBinsForBidaskRebalance(Number(refreshed.binId), lowerBinId, upperBinId);
              if (next) depositFromBinId = next.fromBinId;
            }
          } catch {
            // tetap pakai fromBinId awal
          }
        }

        const sigs = await depositFn({
          pool,
          positionPubKey,
          wallet,
          connection,
          feePlan,
          sendAndConfirmFn,
          minBinId: depositFromBinId,
          maxBinId: toBinId,
          totalXAmount: baseIsX ? baseAmountRaw : new BN(0),
          totalYAmount: baseIsX ? new BN(0) : baseAmountRaw,
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
        log.warn(`BidAsk rebalance ${label}: gagal re-deposit (${attempt}/${maxRetry}): ${lastErr}`);
        if (attempt < maxRetry) await sleepFn(2500);
      }
    }

    if (lastErr) {
      log.error(
        `BidAsk rebalance ${label}: gagal re-deposit setelah ${maxRetry}x (${lastErr}) — kunci dilepas agar bisa di-sweep`
      );
      recordAction(`BIDASK REBALANCE ${label} GAGAL (step ${decision.stepLevel}%) — ${lastErr}`);
      notifyFn({
        pair: label,
        pool: poolAddress,
        position: positionAddress,
        stepPct: decision.stepLevel,
        priceChangePct: decision.priceChangePct,
        fromBinId,
        toBinId,
        success: false,
        error: lastErr,
      });
      return { triggered: true, success: false, error: lastErr, stepLevel: decision.stepLevel, removeSignatures };
    }

    updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now());
    log.info(
      `✅ BIDASK REBALANCE ${label} — step ${decision.stepLevel}% (harga ${decision.priceChangePct.toFixed(1)}%, bin ${fromBinId}→${toBinId})`
    );
    recordAction(
      `BIDASK REBALANCE ${label} — step ${decision.stepLevel}% (harga ${decision.priceChangePct.toFixed(1)}%, bin ${fromBinId}→${toBinId})`
    );
    notifyFn({
      pair: label,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      priceChangePct: decision.priceChangePct,
      fromBinId,
      toBinId,
      amount: depositedUi,
      success: true,
    });
    return {
      triggered: true,
      success: true,
      stepLevel: decision.stepLevel,
      fromBinId,
      toBinId,
      amount: depositedUi,
      removeSignatures,
      addSignatures,
    };
  } catch (err) {
    const msg = err.message || String(err);
    log.error(`BidAsk rebalance ${pair} error: ${msg}`);
    recordAction(`BIDASK REBALANCE ${pair} GAGAL — ${msg}`);
    notifyFn({
      pair,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      priceChangePct: decision.priceChangePct,
      success: false,
      error: msg,
    });
    return { triggered: true, success: false, error: msg, stepLevel: decision.stepLevel };
  } finally {
    removeEntryInProgressMint(baseMint);
    releaseMint(baseMint, "bidask_rebalance");
    removeEntryInProgressPool(poolAddress);
    rebalanceInProgress.delete(positionAddress);
  }
}
