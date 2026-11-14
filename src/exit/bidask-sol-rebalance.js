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
  protectMint,
  releaseMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  recordAction,
} from "../entry/runtime.js";
import { getTrackedPosition, updateBidaskSolRebalanceState } from "../state/positions.js";
import { calcSpotTokenBinMetrics, depositContinuousBidAsk, extractTokenSideLiquidity } from "./spot-token-bidask.js";
import { tokenSideBinsForBidaskRebalance } from "./bidask-double-rebalance.js";
import {
  capRedepositRaw,
  rebalanceBuildersFromSdk,
  resolveRebalanceMode,
  tryInPlaceRebalance,
  uiToRaw,
} from "./rebalance-shape.js";

const rebalanceInProgress = new Set();

// Porsi bin yang sudah jadi token, sama seperti spot (bin di atas active / span).
// Step 10, 20, 30, ... Hanya naik. Tidak ada rebalance sisi SOL saat harga pulih.
export function evaluateBidaskSolRebalance({ pos, tracked, cfg }) {
  if (!pos || pos.mode !== "bidask:sol") {
    return { action: "none", reason: "not_bidask_sol" };
  }
  if (!cfg?.enabled) return { action: "none", reason: "disabled" };

  const lowerBin = Number.isFinite(Number(pos.lowerBin)) ? Number(pos.lowerBin) : Number(tracked?.lowerBin);
  const upperBin = Number.isFinite(Number(pos.upperBin)) ? Number(pos.upperBin) : Number(tracked?.upperBin);
  const step = Math.max(1, Number(cfg.stepPct) || 10);
  const metrics = calcSpotTokenBinMetrics({
    activeBin: pos.activeBin,
    lowerBin,
    upperBin,
    stepPct: step,
  });
  const lastPct = Math.max(0, Number(tracked?.lastBidaskSolRebalancePct) || 0);

  if (!metrics.inRange) {
    return { action: "none", reason: "out_of_range", lastPct, ...metrics };
  }

  // Step yang sama atau lebih rendah tidak diulang. Tidak ada jalur pulih sisi SOL.
  if (metrics.stepLevel >= lastPct + step && metrics.stepLevel >= step) {
    return {
      action: "rebalance",
      reason: `step_${metrics.stepLevel}pct`,
      lastPct,
      ...metrics,
    };
  }

  return { action: "none", reason: "below_next_step", lastPct, ...metrics };
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

// Bentuk ulang HANYA bin token (di atas active) jadi satu kurva BidAsk.
// Bin yang masih SOL (active dan di bawahnya) tidak ikut. Range tidak berubah.
export async function handleBidaskSolRebalance(pos, deps = {}) {
  const cfg = deps.cfg || config.bidaskSolRebalance;
  const now = deps.now ? deps.now() : Date.now();
  const tracked = deps.tracked !== undefined ? deps.tracked : getTrackedPosition(pos?.position);

  const decision = evaluateBidaskSolRebalance({ pos, tracked, cfg });
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

  const isDryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  if (isDryRun) {
    const recordedBin = Number.isFinite(Number(pos.activeBin)) ? Number(pos.activeBin) : null;
    updateBidaskSolRebalanceState(pos.position, decision.stepLevel, now, recordedBin);
    log.info(
      `[DRY RUN] Would rebalance bidask:sol token→BidAsk ${pair} (step ${decision.stepLevel}%, ${Number(decision.tokenBinPct).toFixed(1)}% bin token, bin ${decision.fromBinId}→${decision.toBinId})`
    );
    return {
      triggered: true,
      success: true,
      dryRun: true,
      rebalanceType: "token_bidask",
      stepLevel: decision.stepLevel,
      fromBinId: decision.fromBinId,
      toBinId: decision.toBinId,
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
  const notifyFn = deps.notifyBidaskSolTokenRebalance || tg.notifyBidaskSolTokenRebalance;
  const depositFn = deps.depositContinuousBidAsk || depositContinuousBidAsk;
  const tryInPlaceFn = deps.tryInPlaceRebalance || tryInPlaceRebalance;

  const baseMint = pos.baseMint;
  const poolAddress = pos.pool;
  const positionAddress = pos.position;

  rebalanceInProgress.add(positionAddress);
  addEntryInProgressMint(baseMint);
  protectMint(baseMint, "bidask_sol_rebalance");
  addEntryInProgressPool(poolAddress);

  try {
    const { pool, baseIsX, unsupported, pairName } = await getPoolInfoFn(poolAddress);
    if (unsupported) return { triggered: false, success: false, error: "unsupported_pool" };

    const sdkMod = await getDlmmSdkFn();
    const { StrategyType } = sdkMod;
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const positionPubKey = new PublicKey(positionAddress);
    const onChainPos = await fetchPositionOnChain(pool, positionPubKey, wallet.publicKey);
    if (!onChainPos) {
      log.warn(`BidAsk SOL token rebalance ${pair}: posisi tidak ditemukan on-chain`);
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
      log.info(`BidAsk SOL token rebalance ${pair}: tidak ada bin token di atas active ${activeBinId} — step dicatat`);
      updateBidaskSolRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
      return { triggered: false, skipped: true, reason: "no_token_bins", decision };
    }

    const { fromBinId, toBinId } = span;
    const liqCheck = extractTokenSideLiquidity(onChainPos.positionData, fromBinId, toBinId, baseIsX);
    if (liqCheck.hasBinData && !liqCheck.hasTokenLiquidity) {
      log.info(
        `BidAsk SOL token rebalance ${pair}: tidak ada likuiditas token di bin ${fromBinId}→${toBinId} — step dicatat`
      );
      updateBidaskSolRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
      return { triggered: false, skipped: true, reason: "no_token_liquidity", decision };
    }

    const feePlan = buildFeePlanFn();
    const feeCap = checkFeeCapFn(feePlan);
    if (!feeCap.ok) {
      const errMsg = `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`;
      log.warn(`BidAsk SOL token rebalance ${pair} ditunda: ${errMsg}`);
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
    const tokenSide = baseIsX ? "x" : "y";

    if (mode === "inplace") {
      const inplace = await tryInPlaceFn({
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
        token: tokenSide,
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
          `📐 BIDASK SOL TOKEN REBALANCE ${label} — bentuk ulang di tempat bin ${fromBinId}→${toBinId} jadi BidAsk (step ${decision.stepLevel}%, ${Number(decision.tokenBinPct).toFixed(1)}% bin token)`
        );
      } else if (inplace.partial) {
        const partialErr = inplace.error || inplace.reason;
        log.error(`BidAsk SOL token rebalance ${label}: rebalance di tempat terputus (${partialErr})`);
        recordAction(`BIDASK SOL TOKEN REBALANCE ${label} GAGAL (step ${decision.stepLevel}%) — ${partialErr}`);
        notifyFn({
          pair: label,
          pool: poolAddress,
          position: positionAddress,
          stepPct: decision.stepLevel,
          tokenBinPct: decision.tokenBinPct,
          fromBinId,
          toBinId,
          success: false,
          error: partialErr,
        });
        return {
          triggered: true,
          success: false,
          rebalanceType: "token_bidask",
          error: partialErr,
          stepLevel: decision.stepLevel,
          fromBinId,
          toBinId,
          addSignatures: inplace.signatures,
        };
      } else {
        log.info(
          `BidAsk SOL token rebalance ${label}: rebalance di tempat tidak dipakai (${inplace.reason}${inplace.error ? `: ${inplace.error}` : ""}) — tarik lalu setor hanya jumlah yang keluar`
        );
      }
    }

    const maxRetry = Math.max(1, Math.floor(Number(cfg.retry) || 3));
    let lastErr = null;

    if (!usedInPlace) {
      log.info(
        `📐 BIDASK SOL TOKEN REBALANCE ${label} — tarik token bin ${fromBinId}→${toBinId} lalu add BidAsk (step ${decision.stepLevel}%, ${Number(decision.tokenBinPct).toFixed(1)}% bin token)`
      );

      let balanceBeforeRaw = null;
      try {
        balanceBeforeRaw = uiToRaw(await getTokenBalanceFn(baseMint), decimals);
      } catch {
        // saldo tidak terbaca: setor jumlah yang keluar dari posisi
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

      let balanceAfterRaw = null;
      try {
        balanceAfterRaw = uiToRaw(await getTokenBalanceFn(baseMint), decimals);
      } catch {
        // lihat catatan balanceBeforeRaw
      }
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
          let depositToBinId = toBinId;
          if (typeof pool.getActiveBin === "function") {
            try {
              const refreshed = await pool.getActiveBin();
              if (Number.isFinite(Number(refreshed?.binId))) {
                const next = tokenSideBinsForBidaskRebalance(Number(refreshed.binId), lowerBinId, upperBinId);
                if (next) {
                  depositFromBinId = next.fromBinId;
                  depositToBinId = next.toBinId;
                }
              }
            } catch {
              // tetap pakai rentang token awal
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
            maxBinId: depositToBinId,
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
          log.warn(`BidAsk SOL token rebalance ${label}: gagal re-deposit (${attempt}/${maxRetry}): ${lastErr}`);
          if (attempt < maxRetry) await sleepFn(2500);
        }
      }
    }

    if (lastErr) {
      log.error(`BidAsk SOL token rebalance ${label}: gagal re-deposit setelah ${maxRetry}x (${lastErr})`);
      recordAction(`BIDASK SOL TOKEN REBALANCE ${label} GAGAL (step ${decision.stepLevel}%) — ${lastErr}`);
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
        rebalanceType: "token_bidask",
        error: lastErr,
        stepLevel: decision.stepLevel,
        fromBinId,
        toBinId,
        removeSignatures,
      };
    }

    updateBidaskSolRebalanceState(positionAddress, decision.stepLevel, Date.now(), activeBinId);
    log.info(
      `✅ BIDASK SOL TOKEN REBALANCE ${label} — step ${decision.stepLevel}% (${Number(decision.tokenBinPct).toFixed(1)}% bin token, bin ${fromBinId}→${toBinId})`
    );
    recordAction(`BIDASK SOL TOKEN REBALANCE ${label} — step ${decision.stepLevel}% (bin ${fromBinId}→${toBinId})`);
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
    log.error(`BidAsk SOL token rebalance ${pair} error: ${msg}`);
    recordAction(`BIDASK SOL TOKEN REBALANCE ${pair} GAGAL — ${msg}`);
    notifyFn({
      pair,
      pool: poolAddress,
      position: positionAddress,
      stepPct: decision.stepLevel,
      tokenBinPct: decision.tokenBinPct,
      success: false,
      error: msg,
    });
    return {
      triggered: true,
      success: false,
      rebalanceType: "token_bidask",
      error: msg,
      stepLevel: decision.stepLevel,
    };
  } finally {
    removeEntryInProgressMint(baseMint);
    releaseMint(baseMint, "bidask_sol_rebalance");
    removeEntryInProgressPool(poolAddress);
    rebalanceInProgress.delete(positionAddress);
  }
}
