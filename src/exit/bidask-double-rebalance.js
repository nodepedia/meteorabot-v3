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
import {
  depositContinuousBidAsk,
  extractSolSideLiquidity,
  extractTokenSideLiquidity,
  chunkSolBidAskRanges,
} from "./spot-token-bidask.js";
import {
  DEFAULT_MAX_BINS_PER_TX,
  capRedepositRaw,
  rebalanceBuildersFromSdk,
  resolveRebalanceMode,
  solSpendCapRaw,
  tryInPlaceRebalance,
  uiToRaw,
} from "./rebalance-shape.js";

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
  const lastBin =
    tracked?.lastBidaskDoubleRebalanceBin != null && Number.isFinite(Number(tracked.lastBidaskDoubleRebalanceBin))
      ? Number(tracked.lastBidaskDoubleRebalanceBin)
      : null;
  const activeBin = Number(pos.activeBin);
  const lowerBin = Number.isFinite(Number(pos.lowerBin)) ? Number(pos.lowerBin) : Number(tracked?.lowerBin);
  const upperBin = Number.isFinite(Number(pos.upperBin)) ? Number(pos.upperBin) : Number(tracked?.upperBin);
  const haveBins =
    Number.isFinite(activeBin) && Number.isFinite(lowerBin) && Number.isFinite(upperBin) && upperBin >= lowerBin;
  const binSpan = haveBins ? upperBin - lowerBin : 0;
  const inCooldown = lastAt > 0 && cooldownMs > 0 && now - lastAt < cooldownMs;

  // 1. Harga turun satu step lagi dari entry: bentuk ulang token di atas bin aktif.
  if (stepLevel >= lastPct + step && stepLevel >= step) {
    if (inCooldown) {
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

  // 2. Harga pulih minimal satu step sejak rebalance terakhir (sama seperti spot):
  //    step yang tercatat turun, dan naiknya harga atau geser bin cukup satu step.
  const depthPct = change < 0 ? -change : 0;
  const risePctFromLastStep = lastPct - depthPct;
  const risePctFromLastBin = lastBin != null && binSpan > 0 ? ((activeBin - lastBin) * 100) / binSpan : null;
  const recoveredEnough =
    lastPct >= step &&
    stepLevel <= lastPct - step &&
    (risePctFromLastStep + 1e-9 >= step || (risePctFromLastBin != null && risePctFromLastBin + 1e-9 >= step));

  if (recoveredEnough) {
    if (haveBins && (activeBin < lowerBin || activeBin > upperBin)) {
      return { action: "none", reason: "out_of_range", lastPct, stepLevel, priceChangePct: change };
    }
    if (cfg.solEnabled === false) {
      return { action: "none", reason: "sol_disabled", lastPct, stepLevel, priceChangePct: change };
    }
    if (inCooldown) {
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
      action: "rebalance_sol",
      reason: `recover_${lastPct}_to_${stepLevel}pct`,
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

// Bentuk ulang posisi bidask:double di tempat yang sama, tanpa mengecilkan range.
// Token: tiap kelipatan turun harga dari entry. SOL: saat harga pulih satu step.
async function executeBidaskSolRebalance(ctx) {
  const {
    decision,
    pair,
    cfg,
    deps,
    pool,
    baseIsX,
    pairName,
    connection,
    wallet,
    positionPubKey,
    onChainPos,
    activeBinId,
    lowerBinId,
    upperBinId,
    sdkMod,
    StrategyType,
    positionAddress,
    poolAddress,
    buildFeePlanFn,
    checkFeeCapFn,
    sendAndConfirmFn,
    sleepFn,
    notifyFn,
  } = ctx;

  if (activeBinId < lowerBinId || activeBinId > upperBinId) {
    log.info(
      `BidAsk SOL rebalance ${pair}: activeBin ${activeBinId} di luar rentang ${lowerBinId}→${upperBinId} — batal`
    );
    return { triggered: false, skipped: true, reason: "active_bin_moved", decision };
  }

  const solCheck = extractSolSideLiquidity(onChainPos.positionData, lowerBinId, activeBinId, baseIsX);
  const fromBinId = solCheck.fromBinId;
  const toBinId = solCheck.toBinId;
  if (toBinId < fromBinId || (solCheck.hasBinData && !solCheck.hasSolLiquidity)) {
    log.info(`BidAsk SOL rebalance ${pair}: tidak ada likuiditas SOL di bin ${fromBinId}→${toBinId} — step dicatat`);
    updateBidaskDoubleRebalanceState(
      positionAddress,
      decision.stepLevel,
      Date.now(),
      decision.stepLevel > 0 ? activeBinId : null
    );
    return { triggered: false, skipped: true, reason: "no_sol_liquidity", decision };
  }

  const feePlan = buildFeePlanFn();
  const feeCap = checkFeeCapFn(feePlan);
  if (!feeCap.ok) {
    const errMsg = `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`;
    log.warn(`BidAsk SOL rebalance ${pair} ditunda: ${errMsg}`);
    return { triggered: false, success: false, error: errMsg, feeCap: true, decision };
  }

  const label = pairName || pair;
  const bidAskStrategyType = StrategyType?.BidAsk ?? 2;
  const mode = resolveRebalanceMode(deps.rebalanceMode, config.rebalance?.mode);
  const removeSignatures = [];
  const addSignatures = [];
  let targetSolLamports = solCheck.totalSolLamports;
  let usedInPlace = false;
  const recordedSolUi = Number(solCheck.totalSolLamports.toString()) / 1e9;

  if (mode === "inplace") {
    const inplace = await tryInPlaceRebalance({
      pool,
      positionPubKey,
      positionData: onChainPos.positionData,
      wallet,
      connection,
      feePlan,
      sendAndConfirmFn,
      fromBinId,
      toBinId,
      activeBinId,
      binStep: pool?.lbPair?.binStep,
      token: baseIsX ? "y" : "x",
      strategyType: bidAskStrategyType,
      builders: rebalanceBuildersFromSdk(sdkMod),
      slippagePct: config.entry.activeBinSlippagePct,
    });
    if (inplace.ok) {
      usedInPlace = true;
      addSignatures.push(...inplace.signatures);
      targetSolLamports = inplace.depositedRaw;
      log.info(
        `🔄 BIDASK SOL REBALANCE ${label} — bentuk ulang di tempat ${recordedSolUi > 0 ? `${recordedSolUi.toFixed(4)} ` : ""}SOL, bin ${fromBinId}→${toBinId} jadi BidAsk (pulih ${decision.lastPct}% → ${decision.stepLevel}%)`
      );
    } else if (inplace.partial) {
      const partialErr = inplace.error || inplace.reason;
      log.error(`BidAsk SOL rebalance ${label}: rebalance di tempat terputus (${partialErr})`);
      recordAction(
        `BIDASK SOL REBALANCE ${label} GAGAL (pulih ${decision.lastPct}%→${decision.stepLevel}%) — ${partialErr}`
      );
      notifyFn({
        pair: label,
        pool: poolAddress,
        position: positionAddress,
        lastPct: decision.lastPct,
        stepPct: decision.stepLevel,
        priceChangePct: decision.priceChangePct,
        fromBinId,
        toBinId,
        success: false,
        error: partialErr,
      });
      return {
        triggered: true,
        success: false,
        rebalanceType: "sol_bidask",
        error: partialErr,
        stepLevel: decision.stepLevel,
        addSignatures: inplace.signatures,
      };
    } else {
      log.info(
        `BidAsk SOL rebalance ${label}: rebalance di tempat tidak dipakai (${inplace.reason}${inplace.error ? `: ${inplace.error}` : ""}) — tarik lalu setor hanya jumlah yang keluar`
      );
    }
  }

  const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
  let lastErr = null;

  if (!usedInPlace) {
    log.info(
      `🔄 BIDASK SOL REBALANCE ${label} — tarik SOL bin ${fromBinId}→${toBinId} lalu add BidAsk (pulih ${decision.lastPct}% → ${decision.stepLevel}%)`
    );
    let solBalanceBeforeLamports = null;
    if (typeof connection?.getBalance === "function") {
      try {
        solBalanceBeforeLamports = await connection.getBalance(wallet.publicKey);
      } catch {}
    }
    const rawRemoveTxs = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(10000),
      shouldClaimAndClose: false,
    });
    const removeTxs = Array.isArray(rawRemoveTxs) ? rawRemoveTxs : [rawRemoveTxs];
    for (const tx of removeTxs) {
      const sent = await sendAndConfirmFn({ connection, tx, signers: [wallet], feePlan, wallet });
      if (sent?.signature) removeSignatures.push(sent.signature);
    }
    let solBalanceAfterLamports = null;
    if (typeof connection?.getBalance === "function") {
      try {
        solBalanceAfterLamports = await connection.getBalance(wallet.publicKey);
      } catch {}
    }
    const gasReserveSol = Number(config.wallet?.minSolReserve ?? config.entry?.gasReserve ?? 0.05) || 0;
    const beforeBn =
      solBalanceBeforeLamports == null ? null : new BN(String(Math.floor(Number(solBalanceBeforeLamports))));
    const afterBn =
      solBalanceAfterLamports == null ? null : new BN(String(Math.floor(Number(solBalanceAfterLamports))));
    targetSolLamports = capRedepositRaw({
      positionRaw: solCheck.totalSolLamports,
      balanceBeforeRaw: beforeBn,
      balanceAfterRaw: afterBn,
      walletCapRaw: afterBn ? solSpendCapRaw(afterBn, gasReserveSol) : null,
    });

    let remainingSolRaw = targetSolLamports;
    let nextFromBinId = fromBinId;
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
              const maxAllowedBin = solCheck.activeBinHasBase ? Number(refreshed.binId) - 1 : Number(refreshed.binId);
              depositToBinId = Math.max(nextFromBinId, Math.min(toBinId, maxAllowedBin));
            }
          } catch {}
        }
        const chunks = chunkSolBidAskRanges(nextFromBinId, depositToBinId, remainingSolRaw, DEFAULT_MAX_BINS_PER_TX);
        if (chunks.length === 0) throw new Error("chunkSolBidAskRanges menghasilkan 0 chunk untuk deposit SOL");
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
              strategyType: bidAskStrategyType,
            },
            slippage: config.entry.activeBinSlippagePct,
          });
          const addTxs = Array.isArray(rawAddTxs) ? rawAddTxs : [rawAddTxs];
          for (const tx of addTxs) {
            const sent = await sendAndConfirmFn({ connection, tx, signers: [wallet], feePlan, wallet });
            if (sent?.signature) addSignatures.push(sent.signature);
          }
          remainingSolRaw = BN.max(new BN(0), remainingSolRaw.sub(chunk.amountRaw));
          nextFromBinId = chunk.maxBinId + 1;
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err.message || String(err);
        log.warn(`BidAsk SOL rebalance ${label}: gagal re-deposit BidAsk (${attempt}/${maxRetry}): ${lastErr}`);
        if (attempt < maxRetry) await sleepFn(2500);
      }
    }
  }

  const depositedSolUi = Number(targetSolLamports.toString()) / 1e9;
  if (lastErr) {
    log.error(`BidAsk SOL rebalance ${label}: gagal re-deposit setelah ${maxRetry}x (${lastErr})`);
    recordAction(
      `BIDASK SOL REBALANCE ${label} GAGAL (pulih ${decision.lastPct}%→${decision.stepLevel}%) — ${lastErr}`
    );
    notifyFn({
      pair: label,
      pool: poolAddress,
      position: positionAddress,
      lastPct: decision.lastPct,
      stepPct: decision.stepLevel,
      priceChangePct: decision.priceChangePct,
      fromBinId,
      toBinId,
      amountSol: depositedSolUi,
      success: false,
      error: lastErr,
    });
    return {
      triggered: true,
      success: false,
      rebalanceType: "sol_bidask",
      error: lastErr,
      stepLevel: decision.stepLevel,
      removeSignatures,
    };
  }

  updateBidaskDoubleRebalanceState(
    positionAddress,
    decision.stepLevel,
    Date.now(),
    decision.stepLevel > 0 ? activeBinId : null
  );
  log.info(
    `✅ BIDASK SOL REBALANCE ${label} — pulih ${decision.lastPct}% → ${decision.stepLevel}% (bin ${fromBinId}→${toBinId}) — ${depositedSolUi.toFixed(4)} SOL dibentuk BidAsk`
  );
  recordAction(
    `BIDASK SOL REBALANCE ${label} — pulih ${decision.lastPct}%→${decision.stepLevel}% (${depositedSolUi.toFixed(4)} SOL, bin ${fromBinId}→${toBinId})`
  );
  notifyFn({
    pair: label,
    pool: poolAddress,
    position: positionAddress,
    lastPct: decision.lastPct,
    stepPct: decision.stepLevel,
    priceChangePct: decision.priceChangePct,
    fromBinId,
    toBinId,
    amountSol: depositedSolUi,
    success: true,
  });
  return {
    triggered: true,
    success: true,
    rebalanceType: "sol_bidask",
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
  const isSolRebalance = decision.action === "rebalance_sol";
  if (decision.action !== "rebalance" && !isSolRebalance) {
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
    const recordedBin = Number.isFinite(Number(pos.activeBin)) ? Number(pos.activeBin) : null;
    updateBidaskDoubleRebalanceState(
      pos.position,
      decision.stepLevel,
      now,
      decision.stepLevel > 0 ? recordedBin : null
    );
    if (isSolRebalance) {
      log.info(
        `[DRY RUN] Would rebalance bidask:double SOL→BidAsk ${pair} (pulih ${decision.lastPct}% → ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
      );
      return {
        triggered: true,
        success: true,
        dryRun: true,
        rebalanceType: "sol_bidask",
        stepLevel: decision.stepLevel,
        decision,
      };
    }
    log.info(
      `[DRY RUN] Would rebalance bidask:double token→BidAsk ${pair} (step ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
    );
    return {
      triggered: true,
      success: true,
      dryRun: true,
      rebalanceType: "token_bidask",
      stepLevel: decision.stepLevel,
      decision,
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
  const notifyFn = isSolRebalance
    ? deps.notifyBidaskDoubleSolRebalance || tg.notifyBidaskDoubleSolRebalance
    : deps.notifyBidaskDoubleRebalance || tg.notifyBidaskDoubleRebalance;
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

    const sdkMod = await getDlmmSdkFn();
    const { StrategyType } = sdkMod;
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
    if (isSolRebalance) {
      return await executeBidaskSolRebalance({
        pos,
        decision,
        pair,
        cfg,
        deps,
        pool,
        baseIsX,
        pairName,
        connection,
        wallet,
        positionPubKey,
        onChainPos,
        activeBinId,
        lowerBinId,
        upperBinId,
        sdkMod,
        StrategyType,
        positionAddress,
        poolAddress,
        buildFeePlanFn,
        checkFeeCapFn,
        sendAndConfirmFn,
        sleepFn,
        notifyFn,
      });
    }

    const span = tokenSideBinsForBidaskRebalance(activeBinId, lowerBinId, upperBinId);
    if (!span) {
      log.info(`BidAsk rebalance ${pair}: tidak ada bin token di atas active ${activeBinId} — step dicatat`);
      updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
      return { triggered: false, skipped: true, reason: "no_token_bins", decision };
    }

    const { fromBinId, toBinId } = span;
    const liqCheck = extractTokenSideLiquidity(onChainPos.positionData, fromBinId, toBinId, baseIsX);
    if (liqCheck.hasBinData && !liqCheck.hasTokenLiquidity) {
      log.info(`BidAsk rebalance ${pair}: tidak ada likuiditas token di bin ${fromBinId}→${toBinId} — step dicatat`);
      updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
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
    const bidAskStrategyType = StrategyType?.BidAsk ?? 2;
    const mode = resolveRebalanceMode(deps.rebalanceMode, config.rebalance?.mode);
    const decimals = await getMintDecimalsFn(baseMint);
    const removeSignatures = [];
    const addSignatures = [];
    let depositedUi = 0;
    let cappedRaw = new BN(0);
    let usedInPlace = false;

    if (mode === "inplace") {
      const inplace = await tryInPlaceRebalance({
        pool,
        positionPubKey,
        positionData: onChainPos.positionData,
        wallet,
        connection,
        feePlan,
        sendAndConfirmFn,
        fromBinId,
        toBinId,
        activeBinId,
        binStep: pool?.lbPair?.binStep,
        token: baseIsX ? "x" : "y",
        strategyType: bidAskStrategyType,
        builders: rebalanceBuildersFromSdk(sdkMod),
        slippagePct: config.entry.activeBinSlippagePct,
      });
      if (inplace.ok) {
        usedInPlace = true;
        addSignatures.push(...inplace.signatures);
        cappedRaw = inplace.depositedRaw;
        depositedUi = Number(cappedRaw.toString()) / Math.pow(10, decimals);
        log.info(
          `📐 BIDASK REBALANCE ${label} — bentuk ulang di tempat bin ${fromBinId}→${toBinId} jadi BidAsk (step ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
        );
      } else if (inplace.partial) {
        const partialErr = inplace.error || inplace.reason;
        log.error(`BidAsk rebalance ${label}: rebalance di tempat terputus (${partialErr})`);
        recordAction(`BIDASK REBALANCE ${label} GAGAL (step ${decision.stepLevel}%) — ${partialErr}`);
        notifyFn({
          pair: label,
          pool: poolAddress,
          position: positionAddress,
          stepPct: decision.stepLevel,
          priceChangePct: decision.priceChangePct,
          fromBinId,
          toBinId,
          success: false,
          error: partialErr,
        });
        return {
          triggered: true,
          success: false,
          error: partialErr,
          stepLevel: decision.stepLevel,
          addSignatures: inplace.signatures,
        };
      } else {
        log.info(
          `BidAsk rebalance ${label}: rebalance di tempat tidak dipakai (${inplace.reason}${inplace.error ? `: ${inplace.error}` : ""}) — tarik lalu setor hanya jumlah yang keluar`
        );
      }
    }

    const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
    let lastErr = null;

    if (!usedInPlace) {
      log.info(
        `📐 BIDASK REBALANCE ${label} — tarik token bin ${fromBinId}→${toBinId} lalu add BidAsk (step ${decision.stepLevel}%, harga ${decision.priceChangePct.toFixed(1)}%)`
      );

      let balanceBeforeRaw = null;
      try {
        balanceBeforeRaw = uiToRaw(await getTokenBalanceFn(baseMint), decimals);
      } catch {}

      const rawRemoveTxs = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId,
        toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: false,
      });
      const removeTxs = Array.isArray(rawRemoveTxs) ? rawRemoveTxs : [rawRemoveTxs];
      for (const tx of removeTxs) {
        const sent = await sendAndConfirmFn({ connection, tx, signers: [wallet], feePlan, wallet });
        if (sent?.signature) removeSignatures.push(sent.signature);
      }

      let balanceAfterRaw = null;
      try {
        balanceAfterRaw = uiToRaw(await getTokenBalanceFn(baseMint), decimals);
      } catch {}
      cappedRaw = capRedepositRaw({
        positionRaw: liqCheck.hasBinData ? liqCheck.totalTokenRaw : null,
        balanceBeforeRaw,
        balanceAfterRaw,
      });

      for (let attempt = 1; attempt <= maxRetry; attempt++) {
        try {
          if (cappedRaw.lte(new BN(0))) {
            if (depositedUi > 0) break;
            throw new Error("jumlah token yang ditarik dari posisi 0");
          }
          const baseAmountRaw = cappedRaw;

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
          depositedUi = Number(cappedRaw.toString()) / Math.pow(10, decimals);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err.message || String(err);
          log.warn(`BidAsk rebalance ${label}: gagal re-deposit (${attempt}/${maxRetry}): ${lastErr}`);
          if (attempt < maxRetry) await sleepFn(2500);
        }
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

    updateBidaskDoubleRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
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
    log.error(`${isSolRebalance ? "BidAsk SOL rebalance" : "BidAsk rebalance"} ${pair} error: ${msg}`);
    recordAction(`${isSolRebalance ? "BIDASK SOL REBALANCE" : "BIDASK REBALANCE"} ${pair} GAGAL — ${msg}`);
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
