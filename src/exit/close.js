import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { closePosition } from "../meteora/close.js";
import { getTokenBalance } from "../solana/balances.js";
import { swapToSol } from "../solana/swap.js";
import { recordClose, getTrackedPosition } from "../state/positions.js";
import { clearTrailingState } from "../state/trailing.js";
import { clearBounceRecovery } from "../state/bounce.js";
import { clearDcaState } from "../state/dca.js";
import { clearTrailingTimer } from "./trailing.js";
import { addClosingPool, removeClosingPool, recordAction } from "../entry/runtime.js";
import { humanReason, fmtPct } from "../core/report.js";

// Guard per-posisi: cegah beberapa close paralel untuk posisi yang sama
// (timer konfirmasi trailing + safety-net siklus bisa memicu bersamaan).
const closingPositions = new Set();

export async function handleClose(pos, reason) {
  const pairLabel = pos.pair || pos.position?.slice(0, 8) || "?";
  const positionAddress = pos.position;

  if (!positionAddress) return;

  if (closingPositions.has(positionAddress)) {
    log.info(`${pairLabel}: close already in progress — skip duplicate (${reason})`);
    return;
  }
  closingPositions.add(positionAddress);
  addClosingPool(pos.pool);

  try {
    const result = await closePosition(positionAddress);

    if (result?.success) {
      recordClose(pos.position, reason, pos.pnlPct);
      // Ambil tracked sebelum clearTrailingState agar referensi trailing masih tersedia.
      const trackedClose = getTrackedPosition(pos.position);
      const refPnl = trackedClose?.trailingArmedBy ? trackedClose?.trailingAnchor : trackedClose?.lastPnlPeak;
      const peakPnl = reason?.includes("trailing") ? (refPnl ?? null) : null;
      clearTrailingTimer(pos.position);
      clearTrailingState(pos.position);
      clearBounceRecovery(pos.position);
      clearDcaState(pos.position);

      // Auto-swap base token to SOL (Jupiter V2, with retries)
      let swapInfo = null;
      if (config.swap.autoSwapAfterClose && result.baseMint) {
        const balance = await getTokenBalance(result.baseMint);
        if (balance > 0) {
          const swapResult = await swapToSol(result.baseMint, balance);
          swapInfo = {
            mint: result.baseMint.slice(0, 8),
            success: swapResult?.success === true,
          };
          if (swapResult?.success) {
            log.debug(`[detail] swap ${pairLabel} proceeds → SOL`);
          } else {
            log.warn(`Swap failed for ${pairLabel}: ${swapResult?.error}`);
          }
        }
      }

      const swapTxt = swapInfo ? (swapInfo.success ? "token di-swap ke SOL" : "token GAGAL di-swap") : "tanpa swap";
      log.info(`🔒 CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(pos.pnlPct)} | ${swapTxt}`);
      log.debug(`[detail] reason=${reason} | position ${positionAddress} | peakRef=${peakPnl ?? "-"}`);
      recordAction(`CLOSE ${pairLabel} — ${humanReason(reason)} | PnL ${fmtPct(pos.pnlPct)}`);

      tg.notifyClose(pairLabel, reason, pos.pnlPct, swapInfo, peakPnl);
    } else {
      const brief = String(result?.error || "unknown").split("\n")[0];
      log.error(`Close failed for ${pairLabel}: ${brief}`);
      tg.notifyError(`Close failed ${pairLabel}: ${brief}`);
    }
  } catch (err) {
    const brief = String(err.message || err).split("\n")[0];
    log.error(`Close error for ${pairLabel}: ${brief}`);
    tg.notifyError(`Close error ${pairLabel}: ${brief}`);
  } finally {
    closingPositions.delete(positionAddress);
    removeClosingPool(pos.pool);
  }
}
