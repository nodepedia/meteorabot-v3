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
  calcSpotPoolEfficiencyScore,
  fetchTokenSolDlmmPools,
  auditSpotPoolCandidate,
  compareSpotPoolAudits,
  selectMostEfficientSpotPool,
} from "../meteora/spot-position.js";
import { getPoolInfo } from "../entry/pool-info.js";
import { replacePoolInList, commentPoolInList, lookupConfiguredEntrySizeSol } from "../entry/pool-list.js";
import { fetchCandles } from "../market/candles.js";
import { computeRSI } from "../market/indicators.js";
import { closedCandles } from "./rules.js";
import {
  trackPosition,
  getTrackedPosition,
  recordTrackedRange,
  getSpotReentryCount,
  setSpotReentryCount,
  setEntrySizeSol,
  setExitWarmupStartedAt,
  resolveExitWarmupStartedAt,
  getOpenPositionsForMint,
  recordClose,
} from "../state/positions.js";
import { shouldCloseBeforeSpotReentry } from "../entry/candidates.js";
import {
  recordAction,
  transferPoolAlias,
  getPoolAlias,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  addEntryInProgressMint,
  removeEntryInProgressMint,
  protectMint,
  releaseMint,
} from "../entry/runtime.js";
import { deactivatePool } from "../entry/index.js";
import { handleClose } from "./close.js";

export {
  nonRefundableCost,
  exceedsNonRefundable,
  calcSpotPoolEfficiencyScore,
  fetchTokenSolDlmmPools,
  auditSpotPoolCandidate,
  compareSpotPoolAudits,
  selectMostEfficientSpotPool,
};

// Cooldown per pool antar loop re-entry OOR kanan (default 120s = 2 menit, atau 60s saat vol 5m > $100k).
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

export function getEffectiveSpotReentryCooldownSec(
  pos,
  cfg = config.spotReentry,
  spotRules = config.spot
) {
  const vol5m = Number(pos?.volume5m);
  const highVolUsd = Number(spotRules?.oorKananHighVol5mUsd ?? cfg?.highVol5mUsd ?? 100000);
  const isHighVol5m = highVolUsd > 0 && Number.isFinite(vol5m) && vol5m > highVolUsd;
  if (isHighVol5m) {
    const fastMin = Number(spotRules?.oorKananFastMinutes);
    return Number(cfg?.fastCooldownSec ?? (fastMin > 0 ? fastMin * 60 : 60));
  }
  const normalMin = Number(spotRules?.oorKananMinutes);
  return Number(cfg?.cooldownSec ?? (normalMin > 0 ? normalMin * 60 : 120));
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
 * Size re-entry: warisi entrySizeSol posisi lama; bila hilang, pakai size
 * terkonfigurasi di pool.txt (multiplier × ENTRY_DEFAULT_SIZE_SOL), lalu
 * default entry. Bukan SPOT_REENTRY_SIZE_SOL.
 */
export function resolveSpotReentrySizeSol(tracked, poolAddress) {
  const fromTracked = Number(tracked?.entrySizeSol);
  if (Number.isFinite(fromTracked) && fromTracked > 0) return fromTracked;
  const fromPool = lookupConfiguredEntrySizeSol(poolAddress || tracked?.pool);
  if (Number.isFinite(fromPool) && fromPool > 0) return fromPool;
  const fallback = Number(config.entry?.defaultSizeSol);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
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
  const sizeSol = resolveSpotReentrySizeSol(tracked, pos.pool);
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
 * Alasan singkat bila posisi spot OOR kanan tidak di-re-entry.
 * Null bila syarat terpenuhi, atau ini bukan spot + oor_kanan.
 * Urutan cek sama dengan shouldReenter. Hanya untuk teks alert.
 */
export function spotReentrySkipReason(pos, reason) {
  if (pos?.mode !== "spot" || reason !== "oor_kanan") return null;
  const tracked = getTrackedPosition(pos.position);
  const span = tracked?.binSpan || pos.binSpan || 0;
  const count = getSpotReentryCount(pos.position);
  const sizeSol = resolveSpotReentrySizeSol(tracked, pos.pool);
  const cfg = { ...config.spotReentry, sizeSol };
  if (!cfg?.enabled) return "re-entry nonaktif";
  if (!(cfg.sizeSol > 0)) return "ukuran re-entry kosong";
  if (!Number.isFinite(span) || span <= 0) return "span bin kosong";
  if (count >= cfg.maxReentries) return "max re-entry tercapai";
  return null;
}

function formatRsiValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  return String(Math.round(n * 100) / 100);
}

// Pure: RSI terakhir dari candle yang sudah tutup, periode sama dengan exit.
export function latestClosedRsi(candles, rsiPeriod) {
  const closed = closedCandles(candles);
  const closes = closed.map((c) => c.close);
  const values = computeRSI(closes, rsiPeriod);
  const latest = values[values.length - 1];
  return Number.isFinite(latest) ? latest : null;
}

// Pure: alasan skip bila RSI mentok. Null bila di bawah ambang, RSI tidak
// valid, atau ambang 0 (fitur mati).
export function spotReentryRsiSkipReason(rsiLatest, { maxRsi = 90, rsiPeriod = 2 } = {}) {
  const max = Number(maxRsi);
  if (!Number.isFinite(max) || max <= 0) return null;
  const rsi = Number(rsiLatest);
  if (!Number.isFinite(rsi) || rsi < max) return null;
  const period = Number.isFinite(Number(rsiPeriod)) ? Number(rsiPeriod) : 2;
  return `re-entry dilewati karena RSI(${period}) ${formatRsiValue(rsi)} >= ${formatRsiValue(max)}`;
}

// Ambil RSI exit sebelum close. Candle kosong/gagal → null (tetap re-entry) + log.
export async function spotReentryOverextendedSkipReason(pos, opts = {}) {
  const cfg = opts.cfg || config.spotReentry;
  const maxRsi = Number(cfg?.maxRsi ?? 0);
  if (!Number.isFinite(maxRsi) || maxRsi <= 0) return null;

  const rules = opts.rules || config.rulesFor("spot");
  const fetchCandlesFn = opts.fetchCandles || fetchCandles;
  const logWarn = opts.log?.warn || ((msg) => log.warn(msg));
  const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";
  const timeframe = opts.timeframe || config.timeframe || "15m";

  let candles = null;
  try {
    candles = await fetchCandlesFn(pos?.baseMint, pos?.pool, {
      resolution: timeframe,
      priority: "exit",
    });
  } catch (err) {
    logWarn(`${pair}: candle RSI re-entry gagal diambil (${err?.message || err}) — tetap re-entry`);
    return null;
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    logWarn(`${pair}: candle RSI re-entry tidak tersedia — tetap re-entry`);
    return null;
  }

  const rsiLatest = latestClosedRsi(candles, rules?.rsiPeriod);
  if (rsiLatest == null) {
    logWarn(`${pair}: RSI re-entry tidak cukup data — tetap re-entry`);
    return null;
  }

  return spotReentryRsiSkipReason(rsiLatest, { maxRsi, rsiPeriod: rules?.rsiPeriod });
}

// Keputusan re-entry OOR kanan sebelum close. willReenter false = tutup biasa.
export async function planSpotOorKananReentry(pos, reason, opts = {}) {
  if (!canSpotReenter(pos, reason)) {
    return {
      willReenter: false,
      reentrySkipReason: spotReentrySkipReason(pos, reason),
    };
  }
  const rsiSkip = await spotReentryOverextendedSkipReason(pos, opts);
  if (rsiSkip) {
    const pair = pos?.pair || pos?.position?.slice(0, 8) || "?";
    const logInfo = opts.log?.info || ((msg) => log.info(msg));
    logInfo(`${pair}: ${rsiSkip}`);
    return { willReenter: false, reentrySkipReason: rsiSkip };
  }
  return { willReenter: true, reentrySkipReason: null };
}

/**
 * Buka posisi spot SOL-only baru setelah posisi spot lama ditutup karena OOR kanan / bin kosong atas.
 * - Mengevaluasi ulang seluruh pool DLMM TOKEN/SOL untuk baseMint dan memilih pool paling efisien
 *   (skor efisiensi TVL + 24h fees * 5 + cumFees, kepadatan 31/31 bin SOL >= 1 SOL, LP >= 20, bebas non-refundable rent).
 * - Menggunakan entrySizeSol dari posisi sebelumnya (mis. 1x / 1.25x / 1.5x dari Runner Spot),
 *   atau fallback ke size entry di pool.txt (multiplier × ENTRY_DEFAULT_SIZE_SOL).
 * - Bila pool.lbPair.binStep tersedia: buka range tangga -95/-90/-85/-80%..+15% bila kena
 *   non-refundable rent; bila seluruh tangga masih kena -> redflag skip + alert).
 *   Deposit SOL satu sisi hanya di [minBinId .. activeBinId], bin di atas activeBin kosong.
 * - Counter `spotReentryCount` dan `entrySizeSol` diteruskan ke posisi baru (maks SPOT_REENTRY_MAX).
 * - Waktu mulai warmup exit diwariskan dari posisi yang diganti (rantai dari entry pertama).
 * - Cooldown antar loop per pool dijaga sesuai SPOT_REENTRY_COOLDOWN_SEC (120s normal / 60s saat vol 5m > $100k).
 * - Gerbang RSI (SPOT_REENTRY_MAX_RSI) diputuskan di planSpotOorKananReentry, sebelum close.
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
  const selectBestSpotPoolFn = opts.selectBestSpotPool || selectMostEfficientSpotPool;
  const dryRun = opts.dryRun ?? config.dryRun;

  if (!canSpotReenter(pos, "oor_kanan")) return { skipped: true };

  const notifySpotReentry = opts.notifySpotReentry || tg.notifySpotReentry;
  const notifySpotReentryFailed = opts.notifySpotReentryFailed || tg.notifySpotReentryFailed;
  const cfg = config.spotReentry;
  const pair = pos.pair || pos.position?.slice(0, 8) || "?";
  const tracked = getTrackedPosition(pos.position);
  const span = tracked?.binSpan || pos.binSpan || 0;
  const warmupStart = resolveExitWarmupStartedAt(tracked);
  const prevCount = getSpotReentryCount(pos.position);
  const nextCount = prevCount + 1;
  const sizeSol = resolveSpotReentrySizeSol(tracked, pos.pool);

  let targetPoolAddress = pos.pool;
  let switchedPool = false;
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
      protectMint(m, "oor_kanan_reentry_open");
      lockedMints.add(m);
    }
  };

  const fail = async (reason) => {
    log.warn(`${pair}: re-entry spot gagal (#${nextCount}/${cfg.maxReentries}) — ${reason}`);
    recordAction(`RE-ENTRY ${pair} GAGAL (${nextCount}/${cfg.maxReentries}) — ${reason}`);
    deactivatePool(targetPoolAddress || pos.pool, `re-entry spot gagal: ${reason}`);
    try {
      await notifySpotReentryFailed({
        pair,
        pool: targetPoolAddress || pos.pool,
        oldPosition: pos.position,
        count: nextCount,
        max: cfg.maxReentries,
        reason,
      });
    } catch (err) {
      log.warn(`${pair}: alert re-entry gagal tidak terkirim — ${err?.message || err}`);
    }
    return { success: false, error: reason };
  };

  const effectiveCooldownSec = getEffectiveSpotReentryCooldownSec(pos, cfg, config.spot);
  const remMs = pos.pool ? getSpotReentryCooldownRemainingMs(pos.pool, Date.now(), effectiveCooldownSec) : 0;
  if (remMs > 0) {
    return fail(`cooldown re-entry masih aktif (${Math.ceil(remMs / 1000)}s tersisa dari ${effectiveCooldownSec}s)`);
  }

  try {
    lockPool(pos.pool);
    lockMint(pos.baseMint || tracked?.baseMint || null);

    const connection = getConnectionFn();
    let initialPoolInfo = null;
    let baseMint = pos.baseMint || tracked?.baseMint || null;

    if (!baseMint) {
      initialPoolInfo = await getPoolInfoFn(pos.pool);
      if (initialPoolInfo?.unsupported || !initialPoolInfo?.baseMint) {
        return await fail("pool tidak didukung (bukan pair SOL)");
      }
      baseMint = initialPoolInfo.baseMint;
    }
    lockMint(baseMint);

    // Evaluasi kandidat pool paling efisien bila di produksi (!opts.getPoolInfo)
    // atau bila pemanggil menyediakan hook discovery/seleksi pool.
    const shouldEvaluatePools = Boolean(
      baseMint &&
        (opts.selectBestSpotPool ||
          opts.discoverCandidatePools ||
          opts.fetchFn ||
          !opts.getPoolInfo)
    );

    let chosenAudit = null;
    if (shouldEvaluatePools) {
      try {
        const selection = await selectBestSpotPoolFn({
          currentPool: pos.pool,
          baseMint,
          getPoolInfoFn,
          connection,
          skipNonRefundable: cfg.skipNonRefundable,
          maxNonRefundableSol: cfg.maxNonRefundableSol,
          fetchFn: opts.fetchFn || fetch,
          discoverPoolsFn: opts.discoverCandidatePools || null,
        });

        if (selection?.chosenPoolAddress) {
          targetPoolAddress = selection.chosenPoolAddress;
          switchedPool = Boolean(selection.switched && targetPoolAddress !== pos.pool);
          chosenAudit = selection.chosenAudit || null;

          if (switchedPool) {
            log.info(
              `${pair}: reposisi pindah ke pool paling efisien ${pos.pool.slice(0, 8)} -> ${targetPoolAddress.slice(0, 8)} (skor efisiensi ${Math.round(selection.chosenAudit?.efficiencyScore || 0)} vs ${Math.round(selection.currentAudit?.efficiencyScore || 0)}, bin SOL >=1: ${selection.chosenAudit?.bins31RequiredGe1SolCount ?? "?"}/31)`
            );
          } else if ((selection.candidatesAudited?.length || 0) > 1) {
            log.info(
              `${pair}: pool ${pos.pool.slice(0, 8)} tetap paling efisien dari ${selection.candidatesAudited.length} pool kandidat (skor ${Math.round(selection.chosenAudit?.efficiencyScore || 0)})`
            );
          }
        }
      } catch (selErr) {
        log.warn(`${pair}: evaluasi efisiensi pool kandidat gagal (${selErr.message}) — tetap pakai pool ${pos.pool.slice(0, 8)}`);
      }
    }

    const resolvedPoolInfo =
      chosenAudit?.poolInfo ||
      (targetPoolAddress === pos.pool && initialPoolInfo ? initialPoolInfo : await getPoolInfoFn(targetPoolAddress));

    const { pool, baseIsX, unsupported, collectFeeMode } = resolvedPoolInfo || {};
    const finalBaseMint = resolvedPoolInfo?.baseMint || baseMint;
    if (unsupported || !finalBaseMint || !pool) {
      return await fail("pool tidak didukung (bukan pair SOL)");
    }
    lockPool(targetPoolAddress);
    lockMint(finalBaseMint);

    // Tutup posisi spot lain (dan posisi di pool lain) pada mint yang sama sebelum
    // membuka spot baru. Bidask di pool tujuan — termasuk fallback token dan DCA —
    // tidak ditutup, karena kuota entry mengizinkan satu spot + satu bidask.
    const closeOldPositionFn =
      opts.closeOldPositionFn ||
      (pos.mustCloseFirst
        ? (p) => handleClose(p, switchedPool ? "reposition_switch_pool_close" : "oor_kanan", { skipDeactivate: true })
        : null);
    if (closeOldPositionFn && pos.position && !getTrackedPosition(pos.position)?.closed) {
      const oldCloseRes = await closeOldPositionFn(pos);
      if (!oldCloseRes?.success) {
        return await fail("gagal menutup posisi sebelumnya sebelum reposisi");
      }
    }

    const closeDuplicatePositionFn =
      opts.closeDuplicatePosition ||
      ((dupPos) => handleClose(dupPos, "reposition_dedup_close", { skipDeactivate: false }));
    const otherOpenPositions = getOpenPositionsForMint(finalBaseMint, pos.position);
    for (const dupPos of otherOpenPositions) {
      // Bidask (fallback OOR kiri, posisi sinyal, DCA) di pool yang sama tidak ditutup.
      if (!shouldCloseBeforeSpotReentry(dupPos, targetPoolAddress)) continue;
      log.warn(
        `${pair}: ditemukan posisi aktif lain ${dupPos.position.slice(0, 8)} di pool ${dupPos.pool?.slice(0, 8) || "?"} pada token yang sama (${finalBaseMint.slice(0, 8)}) — tutup dulu sebelum buka posisi reposisi`
      );
      const dupCloseRes = await closeDuplicatePositionFn(dupPos);
      if (!dupCloseRes?.success) {
        return await fail(
          `gagal menutup posisi aktif lain (${dupPos.position.slice(0, 8)}) pada token yang sama sebelum reposisi`
        );
      }
      const dupAlias = dupPos.pool ? getPoolAlias(dupPos.pool) : null;
      // Pool lain dari baris CA yang sama: jangan '#' baris CA.
      if (dupPos.pool && dupPos.pool !== targetPoolAddress && !(dupAlias && dupAlias === getPoolAlias(pos.pool))) {
        commentPoolInList(dupPos.pool);
      }
    }

    const activeBin = chosenAudit?.activeBin || (await pool.getActiveBin());
    const hasBinStep = Number(pool.lbPair?.binStep) > 0;

    let minBinId;
    let maxBinId;
    let depositMinBinId;
    let depositMaxBinId;
    let lowerPctUsed = null;
    let upperPctUsed = null;
    let usedFallback = false;

    if (hasBinStep) {
      const rangeRes =
        chosenAudit?.rangeRes && chosenAudit.rangeRes.minBinId != null
          ? chosenAudit.rangeRes
          : await resolveSpotRangeWithRentCheck({
              pool,
              activeBinId: Number(activeBin.binId),
              binStep: Number(pool.lbPair.binStep),
              skipNonRefundable: cfg.skipNonRefundable,
              maxNonRefundableSol: cfg.maxNonRefundableSol,
            });

      if (!rangeRes.ok) {
        log.warn(
          `${pair}: REDFLAG non-refundable rent saat re-entry #${nextCount}/${cfg.maxReentries} — skip & nonaktifkan pool`
        );
        await tg.notifySpotNonRefundableSkipped({
          pool: targetPoolAddress,
          pair,
          cost95Sol: rangeRes.costPrimarySol,
          cost90Sol: rangeRes.costFallbackSol,
          costsByPct: rangeRes.costsByPct,
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
        `[DRY RUN] ${pair}: OOR kanan re-entry #${nextCount}/${cfg.maxReentries} — buka spot ${sizeSol} SOL di pool ${targetPoolAddress.slice(0, 8)} bins [${minBinId}..${maxBinId}] (deposit [${depositMinBinId}..${depositMaxBinId}], active ${activeBin.binId})`
      );
      const nowTs = Date.now();
      setLastSpotReentryAt(pos.pool, nowTs);
      if (targetPoolAddress !== pos.pool) setLastSpotReentryAt(targetPoolAddress, nowTs);
      await notifySpotReentry({
        pair,
        pool: targetPoolAddress,
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
        success: true,
        switchedPool,
        previousPool: pos.pool,
      });
      return {
        success: true,
        dryRun: true,
        pool: targetPoolAddress,
        previousPool: pos.pool,
        switchedPool,
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
      `${pair}: OOR kanan re-entry #${nextCount}/${cfg.maxReentries} berhasil → ${newAddr.slice(0, 8)} di pool ${targetPoolAddress.slice(0, 8)} (${sizeSol} SOL, bins [${minBinId}..${maxBinId}], deposit [${depositMinBinId}..${depositMaxBinId}])`
    );

    if (pos.position && !getTrackedPosition(pos.position)?.closed) {
      recordClose(pos.position, switchedPool ? "oor_kanan_switch_pool" : "oor_kanan", null);
    }

    if (switchedPool) {
      // Baris CA: alias pindah ke pool baru dulu, supaya '#' pool lama tidak kena baris CA.
      transferPoolAlias(pos.pool, targetPoolAddress);
      replacePoolInList(pos.pool, targetPoolAddress);
      commentPoolInList(pos.pool);
    }

    const nowTs = Date.now();
    trackPosition(
      newAddr,
      targetPoolAddress,
      pair,
      finalBaseMint,
      collectFeeMode ?? pos.collectFeeMode ?? null,
      "spot",
      false,
      { exitWarmupStartedAt: warmupStart }
    );
    // Bila deteksi on-chain sudah membuat baris lebih dulu, isi field yang masih kosong.
    // Nilai yang sudah ada tidak ditimpa.
    setExitWarmupStartedAt(newAddr, warmupStart);
    recordTrackedRange(newAddr, minBinId, maxBinId);
    setEntrySizeSol(newAddr, sizeSol);
    setSpotReentryCount(newAddr, nextCount);
    setLastSpotReentryAt(pos.pool, nowTs);
    if (targetPoolAddress !== pos.pool) setLastSpotReentryAt(targetPoolAddress, nowTs);

    const switchNote = switchedPool
      ? ` [pindah pool ${pos.pool.slice(0, 8)}→${targetPoolAddress.slice(0, 8)}]`
      : "";
    recordAction(
      `RE-ENTRY ${pair} — ${sizeSol} SOL (${nextCount}/${cfg.maxReentries}, bin ${minBinId}..${maxBinId})${switchNote}`
    );

    await notifySpotReentry({
      pair,
      pool: targetPoolAddress,
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
      success: true,
      switchedPool,
      previousPool: pos.pool,
    });

    return {
      success: true,
      position: newAddr,
      pool: targetPoolAddress,
      previousPool: pos.pool,
      switchedPool,
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
  } finally {
    for (const p of lockedPools) removeEntryInProgressPool(p);
    for (const m of lockedMints) {
      removeEntryInProgressMint(m);
      releaseMint(m, "oor_kanan_reentry_open");
    }
  }
}
