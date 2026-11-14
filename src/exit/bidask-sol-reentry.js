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
import { bidaskSolReentryBinRange, openBidaskSolPosition } from "../meteora/open-sol-position.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { getEffectiveSpotReentryCooldownSec, spotReentryOverextendedSkipReason } from "./spot-reentry.js";
import {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  getSpotReentryCount,
  setSpotReentryCount,
  setEntrySizeSol,
  setExitWarmupStartedAt,
  resolveExitWarmupStartedAt,
  setBidaskSolOpenOffset,
  recordClose,
} from "../state/positions.js";
import {
  recordAction,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  addEntryInProgressMint,
  removeEntryInProgressMint,
  protectMint,
  releaseMint,
} from "../entry/runtime.js";

export { bidaskSolReentryBinRange };

// Cooldown per pool, terpisah dari spot, dengan detik yang sama (SPOT_REENTRY_*).
const lastReentryAtByPool = new Map();

export function setLastBidaskSolReentryAt(poolAddress, ts = Date.now()) {
  if (!poolAddress) return;
  lastReentryAtByPool.set(poolAddress, Number(ts));
}

export function clearBidaskSolReentryCooldown(poolAddress) {
  if (!poolAddress) {
    lastReentryAtByPool.clear();
    return;
  }
  lastReentryAtByPool.delete(poolAddress);
}

export function getBidaskSolReentryCooldownRemainingMs(
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

// SOL yang akan kembali saat posisi ditutup (sisi SOL di posisi, sebelum close).
export function resolveBidaskSolReentrySizeSol(pos) {
  const n = Number(pos?.solAmountUi);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function readBidaskSolOpenOffset(tracked) {
  if (!tracked || tracked.openBinOffsetNoted !== true) return { binsBelow: null, binsAbove: null };
  if (tracked.openBinsBelow == null || tracked.openBinsAbove == null) {
    return { binsBelow: null, binsAbove: null };
  }
  const below = Number(tracked.openBinsBelow);
  const above = Number(tracked.openBinsAbove);
  if (!Number.isFinite(below) || !Number.isFinite(above) || below < 0 || above < 0) {
    return { binsBelow: null, binsAbove: null };
  }
  return { binsBelow: Math.floor(below), binsAbove: Math.floor(above) };
}

/**
 * Pure: re-entry OOR kanan hanya untuk mode bidask:sol.
 * Spot dan mode lain tidak lolos di sini. Ukuran = SOL di posisi, bukan size entry.
 * Span harus > 0 dan tetap di bawah SPOT_MIN_BINS.
 */
export function shouldBidaskSolReenter({ mode, reason, span, count, sizeSol, cfg, maxSpan }) {
  if (mode !== "bidask:sol") return false;
  if (reason !== "oor_kanan") return false;
  if (!cfg?.enabled) return false;
  if (!(Number(sizeSol) > 0)) return false;
  const width = Number(span);
  const cap = Number(maxSpan);
  if (!Number.isFinite(width) || width <= 0) return false;
  if (Number.isFinite(cap) && width >= cap) return false;
  if (count >= cfg.maxReentries) return false;
  return true;
}

export function canBidaskSolReenter(pos, reason) {
  const tracked = getTrackedPosition(pos?.position);
  const span = Number(tracked?.binSpan ?? pos?.binSpan ?? 0);
  const count = getSpotReentryCount(pos?.position);
  const sizeSol = resolveBidaskSolReentrySizeSol(pos);
  return shouldBidaskSolReenter({
    mode: pos?.mode,
    reason,
    span,
    count,
    sizeSol,
    cfg: config.spotReentry,
    maxSpan: config.spotMinBins,
  });
}

export function bidaskSolReentrySkipReason(pos, reason) {
  if (pos?.mode !== "bidask:sol" || reason !== "oor_kanan") return null;
  const tracked = getTrackedPosition(pos.position);
  const span = Number(tracked?.binSpan ?? pos?.binSpan ?? 0);
  const count = getSpotReentryCount(pos.position);
  const sizeSol = resolveBidaskSolReentrySizeSol(pos);
  const cfg = config.spotReentry;
  const cap = config.spotMinBins;
  if (!cfg?.enabled) return "re-entry nonaktif";
  if (!(sizeSol > 0)) return "ukuran re-entry kosong";
  if (!Number.isFinite(span) || span <= 0) return "span bin kosong";
  if (span >= cap) return "span bin mencapai batas spot";
  if (count >= cfg.maxReentries) return "max re-entry tercapai";
  return null;
}

// Keputusan sebelum close. RSI memakai gerbang yang sama dengan spot
// (SPOT_REENTRY_MAX_RSI, candle 15m yang sudah tutup). Candle gagal = tetap re-entry.
export async function planBidaskSolOorKananReentry(pos, reason, opts = {}) {
  if (!canBidaskSolReenter(pos, reason)) {
    return {
      willReenter: false,
      reentrySkipReason: bidaskSolReentrySkipReason(pos, reason),
    };
  }
  const rsiSkip = await spotReentryOverextendedSkipReason(pos, opts);
  if (rsiSkip) {
    const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";
    const logInfo = opts.log?.info || ((msg) => log.info(msg));
    logInfo(`${pair}: bidask:sol SOL-only ${rsiSkip}`);
    return { willReenter: false, reentrySkipReason: rsiSkip };
  }
  return { willReenter: true, reentrySkipReason: null };
}

/**
 * Setelah close OOR kanan: buka posisi BidAsk SOL-only baru di pool yang sama.
 * Lebar bin sama, bentuk BidAsk, dilacak sebagai bidask:sol. Tidak pindah pool
 * dan tidak menulis pool.txt. Warmup dan penghitung re-entry diwariskan.
 */
export async function handleBidaskSolOorKananReentry(pos, opts = {}) {
  const getPoolInfoFn = opts.getPoolInfo || getPoolInfo;
  const getDlmmSdkFn = opts.getDlmmSdk || getDlmmSdk;
  const getConnectionFn = opts.getConnection || getConnection;
  const getWalletFn = opts.getWallet || getWallet;
  const getSolBalanceFn = opts.getSolBalance || (() => getTokenBalance("SOL"));
  const buildFeePlanFn = opts.buildFeePlan || buildFeePlan;
  const checkFeeCapFn = opts.checkFeeCap || checkFeeCap;
  const sendAndConfirmFn = opts.sendAndConfirmRobust || sendAndConfirmRobust;
  const dryRun = opts.dryRun ?? config.dryRun;
  const notifyOk = opts.notifyBidaskSolReentry || tg.notifyBidaskSolReentry;
  const notifyFail = opts.notifyBidaskSolReentryFailed || tg.notifyBidaskSolReentryFailed;

  if (!canBidaskSolReenter(pos, "oor_kanan")) return { skipped: true };

  const cfg = config.spotReentry;
  const pair = pos.pair || pos.position?.slice(0, 8) || "?";
  const tracked = getTrackedPosition(pos.position);
  const span = Number(tracked?.binSpan ?? pos.binSpan ?? 0);
  const offset = readBidaskSolOpenOffset(tracked);
  const warmupStart = resolveExitWarmupStartedAt(tracked);
  const prevCount = getSpotReentryCount(pos.position);
  const nextCount = prevCount + 1;
  const sizeSol = resolveBidaskSolReentrySizeSol(pos);
  const targetPool = pos.pool;

  const lockedPools = new Set();
  const lockedMints = new Set();
  const lockPool = (p) => {
    if (p) {
      addEntryInProgressPool(p);
      lockedPools.add(p);
    }
  };
  const lockMint = (m) => {
    if (m) {
      addEntryInProgressMint(m);
      protectMint(m, "bidask_sol_reentry_open");
      lockedMints.add(m);
    }
  };

  const fail = async (reason) => {
    log.warn(`${pair}: re-entry bidask:sol SOL-only gagal (#${nextCount}/${cfg.maxReentries}) — ${reason}`);
    recordAction(`RE-ENTRY bidask:sol ${pair} GAGAL (${nextCount}/${cfg.maxReentries}) — ${reason}`);
    try {
      await notifyFail({
        pair,
        pool: targetPool,
        oldPosition: pos.position,
        count: nextCount,
        max: cfg.maxReentries,
        reason,
      });
    } catch (err) {
      log.warn(`${pair}: alert re-entry bidask:sol gagal tidak terkirim — ${err?.message || err}`);
    }
    return { success: false, error: reason };
  };

  const effectiveCooldownSec = getEffectiveSpotReentryCooldownSec(pos, cfg, config.bidaskSol);
  const remMs = targetPool ? getBidaskSolReentryCooldownRemainingMs(targetPool, Date.now(), effectiveCooldownSec) : 0;
  if (remMs > 0) {
    return fail(`cooldown re-entry masih aktif (${Math.ceil(remMs / 1000)}s tersisa dari ${effectiveCooldownSec}s)`);
  }

  try {
    lockPool(targetPool);
    lockMint(pos.baseMint || tracked?.baseMint || null);

    const poolInfo = await getPoolInfoFn(targetPool);
    const { pool, baseIsX, unsupported, collectFeeMode } = poolInfo || {};
    const baseMint = poolInfo?.baseMint || pos.baseMint || tracked?.baseMint || null;
    if (unsupported || !baseMint || !pool) {
      return await fail("pool tidak didukung (bukan pair SOL)");
    }
    lockMint(baseMint);

    const activeBin = await pool.getActiveBin();
    const activeBinId = Number(activeBin?.binId);
    const range = bidaskSolReentryBinRange({
      activeBinId,
      binSpan: span,
      binsBelow: offset.binsBelow,
      binsAbove: offset.binsAbove,
      maxSpan: config.spotMinBins,
    });
    if (!range) {
      return await fail("span bin tidak valid untuk bidask:sol");
    }

    const { minBinId, maxBinId } = range;

    if (dryRun) {
      log.info(
        `[DRY RUN] ${pair}: OOR kanan re-entry bidask:sol SOL-only #${nextCount}/${cfg.maxReentries} — buka ${sizeSol} SOL bins [${minBinId}..${maxBinId}] (active ${activeBinId})`
      );
      setLastBidaskSolReentryAt(targetPool, Date.now());
      await notifyOk({
        pair,
        pool: targetPool,
        oldPosition: pos.position,
        newPosition: "dry-run",
        sizeSol,
        minBin: minBinId,
        maxBin: maxBinId,
        span: range.binSpan,
        count: nextCount,
        max: cfg.maxReentries,
        txSig: null,
        dryRun: true,
        success: true,
      });
      return {
        success: true,
        dryRun: true,
        mode: "bidask:sol",
        pool: targetPool,
        count: nextCount,
        sizeSol,
        minBinId,
        maxBinId,
        binSpan: range.binSpan,
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
      const estimated = Number(feeCheck.estimatedSol ?? feeCheck.totalSol ?? 0);
      const maxSol = Number(feeCheck.maxSol ?? feeCheck.cap ?? 0);
      return await fail(`estimasi fee ${estimated.toFixed(6)} SOL > batas ${maxSol} SOL`);
    }

    const { StrategyType } = await getDlmmSdkFn();
    const strategyType = StrategyType?.BidAsk;
    if (strategyType === undefined) {
      return await fail("strategi BidAsk tidak tersedia");
    }

    const solLamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    if (solLamports.lte(new BN(0))) {
      return await fail("ukuran re-entry kosong");
    }

    const wallet = getWalletFn();
    const connection = getConnectionFn();
    const newPosition = Keypair.generate();

    let openRes;
    try {
      openRes = await openBidaskSolPosition({
        pool,
        connection,
        wallet,
        feePlan,
        baseIsX,
        solLamports,
        minBinId,
        maxBinId,
        strategyType,
        slippage: config.entry.activeBinSlippagePct,
        sendAndConfirmFn,
        newPositionKeypair: newPosition,
        skipNonRefundable: cfg.skipNonRefundable,
        maxNonRefundableSol: cfg.maxNonRefundableSol,
      });
    } catch (txErr) {
      let landed = false;
      try {
        const info = await connection.getAccountInfo(newPosition.publicKey, "confirmed");
        landed = Boolean(info);
      } catch {
        landed = false;
      }
      if (!landed) return await fail(txErr.message);
      log.warn(
        `${pair}: konfirmasi tx timeout tapi akun posisi ${newPosition.publicKey.toString()} sudah aktif on-chain — lanjut catat sebagai bidask:sol`
      );
      openRes = { ok: true, positionPubkey: newPosition.publicKey.toString(), txSigs: [], lastSig: "" };
    }

    if (!openRes?.ok) {
      return await fail(openRes?.error || "gagal membuka posisi bidask:sol");
    }

    const newAddr = openRes.positionPubkey;
    const lastSig = openRes.lastSig;
    log.info(
      `${pair}: OOR kanan re-entry bidask:sol SOL-only #${nextCount}/${cfg.maxReentries} berhasil → ${newAddr.slice(0, 8)} (${sizeSol} SOL, bins [${minBinId}..${maxBinId}], BidAsk)`
    );

    if (pos.position && !getTrackedPosition(pos.position)?.closed) {
      recordClose(pos.position, "oor_kanan", null);
    }

    trackPosition(
      newAddr,
      targetPool,
      pair,
      baseMint,
      collectFeeMode ?? pos.collectFeeMode ?? null,
      "bidask:sol",
      false,
      {
        exitWarmupStartedAt: warmupStart,
        openBinsBelow: range.binsBelow,
        openBinsAbove: range.binsAbove,
      }
    );
    setExitWarmupStartedAt(newAddr, warmupStart);
    setBidaskSolOpenOffset(newAddr, range.binsBelow, range.binsAbove);
    recordTrackedRange(newAddr, minBinId, maxBinId);
    setEntrySizeSol(newAddr, sizeSol);
    setSpotReentryCount(newAddr, nextCount);
    setLastBidaskSolReentryAt(targetPool, Date.now());

    recordAction(
      `RE-ENTRY bidask:sol SOL-only ${pair} — ${sizeSol} SOL (${nextCount}/${cfg.maxReentries}, bin ${minBinId}..${maxBinId})`
    );

    await notifyOk({
      pair,
      pool: targetPool,
      oldPosition: pos.position,
      newPosition: newAddr,
      sizeSol,
      minBin: minBinId,
      maxBin: maxBinId,
      span: range.binSpan,
      count: nextCount,
      max: cfg.maxReentries,
      txSig: lastSig,
      dryRun: false,
      success: true,
    });

    return {
      success: true,
      mode: "bidask:sol",
      position: newAddr,
      pool: targetPool,
      count: nextCount,
      sizeSol,
      minBinId,
      maxBinId,
      binSpan: range.binSpan,
      binsBelow: range.binsBelow,
      binsAbove: range.binsAbove,
      txSig: lastSig,
    };
  } catch (err) {
    return await fail(err.message);
  } finally {
    for (const p of lockedPools) removeEntryInProgressPool(p);
    for (const m of lockedMints) {
      removeEntryInProgressMint(m);
      releaseMint(m, "bidask_sol_reentry_open");
    }
  }
}
