import config from "../config/index.js";
import { computeRSI, computeMACD, computeBB } from "../market/indicators.js";
import { updateOOR, resetOOR, getOORState } from "../state/positions.js";
import { isTrailingConfirmed } from "../state/trailing.js";
import { getBounceRecoveryState } from "../state/bounce.js";

export function evaluateExit(position, candles) {
  const rules = config.rulesFor(position.mode);
  const { activeBin, lowerBin, upperBin, pnlPct } = position;

  // 1. Stop loss
  if (rules.enableStopLoss && pnlPct != null && pnlPct <= rules.stopLossPct) {
    resetOOR(position.position);
    return { action: "close", reason: "stop_loss" };
  }

  // 2. OOR kanan — semua mode close langsung
  if (activeBin != null && upperBin != null && activeBin > upperBin) {
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

  // 5. Bounce recovery trail stop (opsional)
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

  // 6. Indikator — arm trailing saat RSI+MACD atau RSI+BB (exit via trailing drop)
  if (!rules.enableIndicators) {
    return { action: "hold", reason: "indicators_disabled" };
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
    macdGreenAfterDarkRed: macd.greenAfterDarkRed,
    bbUpper: bb.upper,
    highLatest,
  });

  if (reason) {
    return { action: "arm_indicator_trailing", reason };
  }

  return { action: "hold", reason: "no_signal" };
}

// Pure: buang candle berjalan (terakhir) sehingga hanya candle yang sudah
// tutup yang dipakai. Data candle dari sumber selalu menyertakan bar aktif.
export function closedCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  return candles.slice(0, -1);
}

// Pure: pilih reason sinyal indikator dari nilai yang sudah dihitung.
// Urutan dipertahankan: rsi_macd -> rsi_bb. Sinyal RSI+MACD = RSI(2) >= 90 dan
// bar MACD hijau (hist > 0 dan naik) tepat setelah bar merah gelap (hist < 0
// dan makin negatif), keduanya pada candle t yang sama.
// Sinyal RSI+BB = RSI(2) >= 90 dan high candle (yang sudah tutup) menembus BB upper.
export function detectIndicatorSignal({ rsiLatest, macdGreenAfterDarkRed, bbUpper, highLatest }) {
  if (!(rsiLatest >= 90)) return null;
  if (macdGreenAfterDarkRed) return "rsi_macd";
  if (bbUpper == null) return null;
  if (highLatest != null && highLatest >= bbUpper) return "rsi_bb";
  return null;
}
