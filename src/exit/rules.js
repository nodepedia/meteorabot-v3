import config from "../config/index.js";
import { LEGACY_MODE } from "../config/rules.js";
import { computeRSI, computeMACD, computeBB } from "../market/indicators.js";
import {
  updateOOR,
  resetOOR,
  getOORState,
  setLowYieldSince,
  getLowYieldSince,
  clearLowYieldSince,
} from "../state/positions.js";
import { isTrailingConfirmed } from "../state/trailing.js";
import { getBounceRecoveryState } from "../state/bounce.js";
import { getSpotReentryCooldownRemainingMs } from "./spot-reentry.js";

// Jendela data 24h Fee/TVL masih boleh dipakai untuk tutup.
// Mengikuti irama loop exit yang sudah ada (tanpa poll baru): 10× POLL_INTERVAL_HOLD,
// minimal 60 detik. Cache PnL yang lebih tua dari ini tidak memicu tutup.
export function highYieldMaxAgeMs(pollIntervalHoldMin = config.pollIntervalHold) {
  const holdMin = Number(pollIntervalHoldMin);
  const holdMs = Number.isFinite(holdMin) && holdMin > 0 ? holdMin * 60 * 1000 : 12_000;
  return Math.max(60_000, holdMs * 10);
}

// Pure: tutup spot bila angka feePerTvl24h yang sudah di-parse > ambang.
// Bukan >=. String mentah API tidak diterima di sini (parser yang mengubahnya).
// Butuh waktu fetch dan updatedAt data, keduanya segar. Hilang/basi → null.
export function evaluateHighYieldClose(position, rules, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : highYieldMaxAgeMs();
  const threshold = Number(rules?.highYieldClosePct);
  if (!(threshold > 0) || !(maxAgeMs > 0)) return null;
  const mode = LEGACY_MODE[position?.mode] || position?.mode;
  if (mode !== "spot") return null;
  const fee = position?.feePct24h;
  if (typeof fee !== "number" || !Number.isFinite(fee) || !(fee > threshold)) return null;
  const at = position?.feePct24hAt;
  const updated = position?.feePct24hUpdatedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof updated !== "number" || !Number.isFinite(updated)) return null;
  const age = now - at;
  const dataAge = now - updated;
  if (!(age >= 0) || age > maxAgeMs) return null;
  if (!(dataAge >= 0) || dataAge > maxAgeMs) return null;
  return { action: "close", reason: "high_yield" };
}

// Pure: masih dalam masa warmup exit? (trailing & arm indikator ditahan)
export function isExitWarmup(firstSeenAt, warmupMinutes, now = Date.now()) {
  const min = Number(warmupMinutes);
  if (!Number.isFinite(min) || min <= 0) return false;
  if (!Number.isFinite(Number(firstSeenAt))) return false;
  return now - Number(firstSeenAt) < min * 60000;
}

export function evaluateExit(position, candles, { warmup = false } = {}) {
  const rules = config.rulesFor(position.mode);
  const { activeBin, lowerBin, upperBin, pnlPct } = position;

  const baseIsX = !position.xIsSol;
  const hasBase = baseIsX ? position.hasX : position.hasY;
  const effectiveUpperBin =
    position.mode === "spot" &&
    position.maxFilledBin != null &&
    Number.isFinite(Number(position.maxFilledBin)) &&
    Number(position.maxFilledBin) < upperBin
      ? Number(position.maxFilledBin)
      : upperBin;
  const inRange =
    activeBin != null &&
    lowerBin != null &&
    effectiveUpperBin != null &&
    activeBin >= lowerBin &&
    activeBin <= effectiveUpperBin;
  // Timer yield rendah hanya relevan saat in-range; keluar range = reset.
  if (!inRange) clearLowYieldSince(position.position);

  // 1. Stop loss
  if (rules.enableStopLoss && pnlPct != null && pnlPct <= rules.stopLossPct) {
    resetOOR(position.position);
    return { action: "close", reason: "stop_loss" };
  }

  // 2. OOR kanan — mode dengan masa tunggu (mis. spot) pakai timer; batal bila
  // harga kembali masuk range. Untuk posisi spot, bin kosong di atas maxFilledBin
  // (mis. area 0%..+15% sebelum kena rebalance token) juga dihitung OOR kanan.
  // Mode lain (oorKananMinutes = 0) tutup langsung.
  if (activeBin != null && effectiveUpperBin != null && activeBin > effectiveUpperBin) {
    const vol5m = Number(position.volume5m);
    const isHighVol5m =
      rules.oorKananHighVol5mUsd > 0 &&
      Number.isFinite(vol5m) &&
      vol5m > rules.oorKananHighVol5mUsd;
    const effectiveOorKananMinutes =
      isHighVol5m && rules.oorKananFastMinutes > 0
        ? rules.oorKananFastMinutes
        : rules.oorKananMinutes;
    const effectiveCooldownSec = isHighVol5m
      ? (config.spotReentry?.fastCooldownSec ?? effectiveOorKananMinutes * 60)
      : (config.spotReentry?.cooldownSec ?? effectiveOorKananMinutes * 60);

    if (position.mode === "spot" && position.pool) {
      const cooldownRemMs = getSpotReentryCooldownRemainingMs(
        position.pool,
        Date.now(),
        effectiveCooldownSec
      );
      if (cooldownRemMs > 0) {
        updateOOR(position.position, "kanan");
        return { action: "hold", reason: `oor_kanan_cooldown_${Math.ceil(cooldownRemMs / 1000)}s` };
      }
    }
    if (effectiveOorKananMinutes > 0) {
      updateOOR(position.position, "kanan");
      const oorState = getOORState(position.position);
      const menit = oorState ? (Date.now() - oorState.sejak) / 60000 : 0;
      if (menit >= effectiveOorKananMinutes) {
        resetOOR(position.position);
        return { action: "close", reason: "oor_kanan" };
      }
      return { action: "hold", reason: `oor_kanan_${Math.floor(menit)}m` };
    }
    resetOOR(position.position);
    return { action: "close", reason: "oor_kanan" };
  }

  // 3. Trailing TP terkonfirmasi (peak-based atau indicator-armed)
  const trailingReason = isTrailingConfirmed(position.position);
  if (trailingReason) {
    resetOOR(position.position);
    return { action: "close", reason: trailingReason };
  }

  // 4. OOR kiri (opsional, timer)
  if (rules.enableOOR && activeBin != null && lowerBin != null && activeBin < lowerBin) {
    updateOOR(position.position, "kiri");
    const oorState = getOORState(position.position);
    const menit = oorState ? (Date.now() - oorState.sejak) / 60000 : 0;

    if (menit >= rules.oorKiriMinutes) {
      resetOOR(position.position);
      return { action: "close", reason: "oor_kiri" };
    }

    return { action: "hold", reason: `oor_kiri_${Math.floor(menit)}m` };
  }

  // In-range: reset tracker
  resetOOR(position.position);

  // 5. Yield tinggi (hanya spot): 24h Fee/TVL posisi > ambang, data segar.
  // Close biasa (klaim + swap) lewat pemanggil. Bukan alasan re-entry OOR.
  // Data kosong/basi tidak menutup. Stop loss / OOR / trailing di atas tetap lebih dulu.
  const highYield = evaluateHighYieldClose(position, rules);
  if (highYield) {
    clearLowYieldSince(position.position);
    return highYield;
  }

  // 6. Yield rendah (mode spot): in-range + sudah pegang token, yield <= ambang,
  // dan PnL >= 0. Setelah `lowYieldDelayMinutes` kondisi bertahan → close + swap.
  if (rules.lowYieldClosePct > 0 && inRange && hasBase === true) {
    const hasYieldData = Number.isFinite(position.feePct24h);
    const low = hasYieldData && position.feePct24h <= rules.lowYieldClosePct;
    if (low && pnlPct != null && pnlPct >= 0) {
      setLowYieldSince(position.position);
      const sejak = getLowYieldSince(position.position);
      const menit = sejak ? (Date.now() - sejak) / 60000 : 0;
      if (menit >= rules.lowYieldDelayMinutes) {
        clearLowYieldSince(position.position);
        return { action: "close", reason: "low_yield" };
      }
      return { action: "hold", reason: `low_yield_${Math.floor(menit)}m` };
    }
    clearLowYieldSince(position.position);
  } else {
    clearLowYieldSince(position.position);
  }

  // 7. Bounce recovery trail stop (opsional)
  if (rules.enableBounceRecovery && pnlPct != null) {
    const brState = getBounceRecoveryState(position.position);
    if (brState?.state === "active" && brState.activePeak != null) {
      const trigger = brState.activePeak - rules.bounceRecoveryTrailingPct;
      if (pnlPct <= trigger) {
        return {
          action: "close",
          reason: `bounce_recovery: peak ${brState.activePeak.toFixed(2)}% -> ${pnlPct.toFixed(2)}%`,
        };
      }
    }
  }

  // 8. Indikator — arm trailing saat RSI+MACD atau RSI+BB (exit via trailing drop).
  // Selama warmup, sinyal indikator diabaikan agar posisi yang baru dibuka
  // (mis. di puncak) tidak langsung ter-arm.
  if (!rules.enableIndicators || warmup) {
    return { action: "hold", reason: warmup ? "warmup" : "indicators_disabled" };
  }

  // Selalu pakai candle yang sudah tutup. GMGN/Meteora menyertakan bar
  // berjalan sebagai candle terakhir; buang agar indikator tidak dihitung
  // dari data yang belum final.
  const closed = closedCandles(candles);
  if (closed.length < 5) {
    return { action: "hold", reason: "insufficient_data" };
  }

  const closes = closed.map((c) => c.close);
  const rsiValues = computeRSI(closes, rules.rsiPeriod);
  const macd = computeMACD(closes, rules.macdFast, rules.macdSlow, rules.macdSignal);
  const bb = computeBB(closes, rules.bbPeriod, rules.bbStddev);

  const rsiLatest = rsiValues[rsiValues.length - 1];
  const highLatest = closed[closed.length - 1]?.high;

  const reason = detectIndicatorSignal({
    rsiLatest,
    macdGreen: macd.macdGreen,
    bbUpper: bb.upper,
    highLatest,
  });

  if (reason) {
    return indicatorAction(position.mode, reason, rules);
  }

  return { action: "hold", reason: "no_signal" };
}

// Pure: aksi saat sinyal indikator muncul. Spot + SPOT_INDICATOR_EXIT=immediate
// → close langsung (tanpa arm trailing / konfirmasi 10s). Selain itu → arm trailing.
export function indicatorAction(mode, reason, rules) {
  if (mode === "spot" && rules?.indicatorExit !== "trailing") {
    return { action: "close", reason: `indicator_${reason}` };
  }
  return { action: "arm_indicator_trailing", reason };
}

// Pure: buang candle berjalan (terakhir) sehingga hanya candle yang sudah
// tutup yang dipakai. Data candle dari sumber selalu menyertakan bar aktif.
export function closedCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  return candles.slice(0, -1);
}

// Pure: pilih reason sinyal indikator dari nilai yang sudah dihitung.
// Urutan dipertahankan: rsi_macd -> rsi_bb. Sinyal RSI+MACD = RSI(2) >= 90 dan
// bar MACD hijau (hist > 0), tanpa peduli warna bar sebelumnya, keduanya pada
// candle t yang sama.
// Sinyal RSI+BB = RSI(2) >= 90 dan high candle (yang sudah tutup) menembus BB upper.
export function detectIndicatorSignal({ rsiLatest, macdGreen, bbUpper, highLatest }) {
  if (!(rsiLatest >= 90)) return null;
  if (macdGreen) return "rsi_macd";
  if (bbUpper == null) return null;
  if (highLatest != null && highLatest >= bbUpper) return "rsi_bb";
  return null;
}
