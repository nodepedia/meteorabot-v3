import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance } from "../solana/balances.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "../meteora/sdk.js";
import {
  nonRefundableCost,
  exceedsNonRefundable,
  resolveSpotRangeWithRentCheck,
  openSpotSolPosition,
} from "../meteora/spot-position.js";
import { getPoolInfo } from "../entry/pool-info.js";
import {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  getSpotReentryCount,
  setSpotReentryCount,
  setEntrySizeSol,
} from "../state/positions.js";
import { recordAction } from "../entry/runtime.js";
import { deactivatePool } from "../entry/index.js";

export { nonRefundableCost, exceedsNonRefundable };

// Cooldown per pool antar loop re-entry OOR kanan (default 120s = 2 menit).
const lastReentryAtByPool = new Map();

export function setLastSpotReentryAt(poolAddress, ts = Date.now()) {
  if (!poolAddress) return;
  lastReentryAtByPool.set(poolAddress, Number(ts));
}

export function clearSpotReentryCooldown(poolAddress) {
  if (!poolAddress) {
    lastReentryAtByPool.clear();
    return;
  }
  lastReentryAtByPool.delete(poolAddress);
}

export function getSpotReentryCooldownRemainingMs(
  poolAddress,
  now = Date.now(),
  cooldownSec = config.spotReentry?.cooldownSec ?? 120
) {
  if (!poolAddress) return 0;
  const sec = Number(cooldownSec);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  const lastAt = lastReentryAtByPool.get(poolAddress);
  if (!Number.isFinite(lastAt) || lastAt <= 0) return 0;
  return Math.max(0, lastAt + sec * 1000 - now);
}

/**
 * Pure: hitung range bin untuk posisi re-entry spot SOL-only legacy (tanpa binStep).
 * Posisi spot SOL-only di-anchor dari activeBin ke bawah sepanjang `span` bin
 * (jumlah bin yang sama dengan posisi yang baru ditutup karena OOR kanan).
 */
export function reentryBinRange(activeBinId, span) {
  const safeSpan = Math.max(0, Math.floor(Number(span) || 0));
  return {
    minBinId: activeBinId - safeSpan,
    maxBinId: activeBinId,
  };
}

/**
 * Pure: apakah posisi yang ditutup memenuhi syarat re-entry OOR kanan?
 */
export function shouldReenter({ mode, reason, span, count, cfg }) {
  if (!cfg?.enabled) return false;
  if (!(cfg.sizeSol > 0)) return false;
  if (mode !== "spot") return false;
  if (reason !== "oor_kanan") return false;
  if (!Number.isFinite(span) || span <= 0) return false;
  if (count >= cfg.maxReentries) return false;
  return true;
}

/**
 * Cek cepat sebelum close: apakah posisi ini akan di-re-enter setelah close?
 * Dipakai agar handleClose tidak menandai pool `#` di pool.txt saat kita
 * justru mau langsung membuka posisi baru di pool yang sama.
 */
export function canSpotReenter(pos, reason) {
  const tracked = getTrackedPosition(pos.position);
  const span = tracked?.binSpan || pos.binSpan || 0;
  const count = getSpotReentryCount(pos.position);
  const sizeSol = tracked?.entrySizeSol > 0 ? tracked.entrySizeSol : config.spotReentry.sizeSol;
  const cfg = { ...config.spotReentry, sizeSol };
  return shouldReenter({
    mode: pos.mode,
    reason,
    span,
    count,
    cfg,
  });
}

/**
 * Buka posisi spot SOL-only baru di pool yang sama setelah posisi spot lama
 * ditutup karena OOR kanan.
 * - Menggunakan entrySizeSol dari posisi sebelumnya (mis. 1x / 1.25x / 1.5x dari Runner Spot),
 *   atau fallback ke SPOT_REENTRY_SIZE_SOL.
 * - Bila pool.lbPair.binStep tersedia: buka range -95%..+15% (fallback -90%..+15% bila kena
 *   non-refundable rent; bila -90% masih kena non-refundable -> redflag skip + alert).
 *   Deposit SOL satu sisi hanya di [minBinId .. activeBinId], bin di atas activeBin kosong.
 * - Counter `spotReentryCount` dan `entrySizeSol` diteruskan ke posisi baru (maks SPOT_REENTRY_MAX).
 * - Cooldown antar loop per pool dijaga sesuai SPOT_REENTRY_COOLDOWN_SEC (2 menit).
 */
export async function handleSpotOorKananReentry(pos, opts = {}) {
  const getPoolInfoFn = opts.getPoolInfo || getPoolInfo;
  const getDlmmSdkFn = opts.getDlmmSdk || getDlmmSdk;
  const getConnectionFn = opts.getConnection || getConnection;
  const getWalletFn = opts.getWallet || getWallet;
  const getSolBalanceFn = opts.getSolBalance || (() => getTokenBalance("SOL"));
  const buildFeePlanFn = opts.buildFeePlan || buildFeePlan;
  const checkFeeCapFn = opts.checkFeeCap || checkFeeCap;
  const sendAndConfirmFn = opts.sendAndConfirmRobust || sendAndConfirmRobust;
  const dryRun = opts.dryRun ?? config.dryRun;

  if (!canSpotReenter(pos, "oor_kanan")) return { skipped: true };

  const cfg = config.spotReentry;
  const pair = pos.pair || pos.position?.slice(0, 8) || "?";
  const tracked = getTrackedPosition(pos.position);
  const span = tracked?.binSpan || pos.binSpan || 0;
  const prevCount = getSpotReentryCount(pos.position);
  const nextCount = prevCount + 1;
  const sizeSol = tracked?.entrySizeSol > 0 ? tracked.entrySizeSol : cfg.sizeSol;

  const fail = async (reason) => {
    log.warn(`${pair}: re-entry spot gagal (#${nextCount}/${cfg.maxReentries}) — ${reason}`);
    deactivatePool(pos.pool, `re-entry spot gagal: ${reason}`);
    await tg.notifySpotReentryFailed({
      pair,
      pool: pos.pool,
      oldPosition: pos.position,
      count: nextCount,
      max: cfg.maxReentries,
      reason,
    });
    return { success: false, error: reason };
  };

  const remMs = pos.pool ? getSpotReentryCooldownRemainingMs(pos.pool, Date.now(), cfg.cooldownSec) : 0;
  if (remMs > 0) {
    return fail(`cooldown re-entry masih aktif (${Math.ceil(remMs / 1000)}s tersisa dari ${cfg.cooldownSec}s)`);
  }

  try {
    const { pool, baseMint, baseIsX, unsupported, collectFeeMode } = await getPoolInfoFn(pos.pool);
    if (unsupported || !baseMint) {
      return await fail("pool tidak didukung (bukan pair SOL)");
    }

    const activeBin = await pool.getActiveBin();
    const hasBinStep = Number(pool.lbPair?.binStep) > 0;

    let minBinId;
    let maxBinId;
    let depositMinBinId;
    let depositMaxBinId;
    let lowerPctUsed = null;
    let upperPctUsed = null;
    let usedFallback = false;

    if (hasBinStep) {
      const rangeRes = await resolveSpotRangeWithRentCheck({
        pool,
        activeBinId: Number(activeBin.binId),
        binStep: Number(pool.lbPair.binStep),
        lowerPctPrimary: -95,
        lowerPctFallback: -90,
        upperPct: 15,
        skipNonRefundable: cfg.skipNonRefundable,
        maxNonRefundableSol: cfg.maxNonRefundableSol,
      });

      if (!rangeRes.ok) {
        log.warn(
          `${pair}: REDFLAG non-refundable rent saat re-entry #${nextCount}/${cfg.maxReentries} — skip & nonaktifkan pool`
        );
        await tg.notifySpotNonRefundableSkipped({
          pool: pos.pool,
          pair,
          cost95Sol: rangeRes.costPrimarySol,
          cost90Sol: rangeRes.costFallbackSol,
          context: `Re-entry OOR Kanan #${nextCount}/${cfg.maxReentries}`,
        });
        return await fail(rangeRes.reason);
      }

      minBinId = rangeRes.minBinId;
      maxBinId = rangeRes.maxBinId;
      depositMinBinId = rangeRes.depositMinBinId;
      depositMaxBinId = rangeRes.depositMaxBinId;
      lowerPctUsed = rangeRes.lowerPctUsed;
      upperPctUsed = rangeRes.upperPctUsed;
      usedFallback = rangeRes.usedFallback;

      if (Number(rangeRes.quote?.positionCost) > 0) {
        log.info(
          `${pair}: info sewa akun posisi ~${Number(rangeRes.quote.positionCost).toFixed(4)} SOL (refundable saat close) — lanjut re-entry`
        );
      }
    } else {
      const legacy = reentryBinRange(activeBin.binId, span);
      minBinId = legacy.minBinId;
      maxBinId = legacy.maxBinId;
      depositMinBinId = minBinId;
      depositMaxBinId = maxBinId;

      if (typeof pool.quoteCreatePosition === "function") {
        const quote = await pool.quoteCreatePosition({
          strategy: { minBinId, maxBinId },
        });
        const nonRef = nonRefundableCost(quote);
        if (cfg.skipNonRefundable && exceedsNonRefundable(nonRef, cfg.maxNonRefundableSol)) {
          return await fail(
            `akan kena sewa non-refundable ${nonRef.toFixed(6)} SOL (binArray=${Number(quote?.binArrayCost ?? 0).toFixed(6)}, bitmap=${Number(quote?.bitmapExtensionCost ?? 0).toFixed(6)}) > batas ${cfg.maxNonRefundableSol} SOL — batalkan re-entry`
          );
        }
        if (Number(quote?.positionCost) > 0) {
          log.info(
            `${pair}: info sewa akun posisi ~${Number(quote.positionCost).toFixed(4)} SOL (refundable saat close) — lanjut re-entry`
          );
        }
      }
    }

    const effectiveSpan = maxBinId - minBinId;

    if (dryRun) {
      log.info(
        `[DRY RUN] ${pair}: OOR kanan re-entry #${nextCount}/${cfg.maxReentries} — buka spot ${sizeSol} SOL bins [${minBinId}..${maxBinId}] (deposit [${depositMinBinId}..${depositMaxBinId}], active ${activeBin.binId})`
      );
      setLastSpotReentryAt(pos.pool, Date.now());
      await tg.notifySpotReentry({
        pair,
        pool: pos.pool,
        oldPosition: pos.position,
        newPosition: "dry-run",
        sizeSol,
        minBin: minBinId,
        maxBin: maxBinId,
        span: effectiveSpan,
        count: nextCount,
        max: cfg.maxReentries,
        txSig: null,
        dryRun: true,
      });
      return {
        success: true,
        dryRun: true,
        count: nextCount,
        sizeSol,
        minBinId,
        maxBinId,
        depositMinBinId,
        depositMaxBinId,
        lowerPctUsed,
        upperPctUsed,
        usedFallback,
      };
    }

    const solBalance = await getSolBalanceFn();
    const required = sizeSol + config.entry.gasReserve;
    if (solBalance < required) {
      return await fail(`saldo SOL kurang (punya ${solBalance.toFixed(4)}, butuh ${required.toFixed(4)})`);
    }

    const feePlan = buildFeePlanFn();
    const feeCheck = checkFeeCapFn(feePlan);
    if (!feeCheck.ok) {
      return await fail(`estimasi fee ${feeCheck.estimatedSol.toFixed(6)} SOL > batas ${feeCheck.maxSol} SOL`);
    }

    const { StrategyType } = await getDlmmSdkFn();
    const strategyType = StrategyType?.Spot ?? 0;
    const solLamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const newPosition = Keypair.generate();

    let openRes;
    try {
      openRes = await openSpotSolPosition({
        pool,
        connection,
        wallet,
        feePlan,
        baseIsX,
        solLamports,
        minBinId,
        maxBinId,
        depositMinBinId,
        depositMaxBinId,
        strategyType,
        slippage: config.entry.activeBinSlippagePct,
        sendAndConfirmFn,
        newPositionKeypair: newPosition,
      });
    } catch (txErr) {
      let landed = false;
      try {
        const info = await connection.getAccountInfo(newPosition.publicKey, "confirmed");
        landed = Boolean(info);
      } catch {}
      if (!landed) {
        return await fail(txErr.message);
      }
      log.warn(
        `${pair}: konfirmasi tx timeout tapi akun posisi ${newPosition.publicKey.toString()} sudah aktif on-chain — lanjut catat`
      );
      openRes = {
        positionPubkey: newPosition.publicKey.toString(),
        txSigs: [],
        lastSig: "",
      };
    }

    const newAddr = openRes.positionPubkey;
    const lastSig = openRes.lastSig;
    log.info(
      `${pair}: OOR kanan re-entry #${nextCount}/${cfg.maxReentries} berhasil → ${newAddr.slice(0, 8)} (${sizeSol} SOL, bins [${minBinId}..${maxBinId}], deposit [${depositMinBinId}..${depositMaxBinId}])`
    );

    trackPosition(newAddr, pos.pool, pair, baseMint, collectFeeMode ?? pos.collectFeeMode ?? null, "spot", false);
    recordTrackedRange(newAddr, minBinId, maxBinId);
    setEntrySizeSol(newAddr, sizeSol);
    setSpotReentryCount(newAddr, nextCount);
    setLastSpotReentryAt(pos.pool, Date.now());

    recordAction({
      type: "spot_reentry",
      oldPosition: pos.position,
      position: newAddr,
      pool: pos.pool,
      pair,
      sizeSol,
      minBin: minBinId,
      maxBin: maxBinId,
      depositMinBin: depositMinBinId,
      depositMaxBin: depositMaxBinId,
      span: effectiveSpan,
      count: nextCount,
      max: cfg.maxReentries,
      txSig: lastSig,
      dryRun: false,
    });

    await tg.notifySpotReentry({
      pair,
      pool: pos.pool,
      oldPosition: pos.position,
      newPosition: newAddr,
      sizeSol,
      minBin: minBinId,
      maxBin: maxBinId,
      span: effectiveSpan,
      count: nextCount,
      max: cfg.maxReentries,
      txSig: lastSig,
      dryRun: false,
    });

    return {
      success: true,
      position: newAddr,
      count: nextCount,
      sizeSol,
      minBinId,
      maxBinId,
      depositMinBinId,
      depositMaxBinId,
      lowerPctUsed,
      upperPctUsed,
      usedFallback,
      txSig: lastSig,
    };
  } catch (err) {
    return await fail(err.message);
  }
}
