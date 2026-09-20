import fs from "fs";
import { DECISION_LOG_FILE } from "../core/paths.js";
import { readState, writeState, readJsonArray } from "./store.js";

export function trackPosition(positionAddress, pool, pair, baseMint, collectFeeMode, mode, isDca = false) {
  if (!positionAddress) return;
  const state = readState();
  if (!state.positions[positionAddress]) {
    state.positions[positionAddress] = {
      position: positionAddress,
      pool: pool || "",
      pair: pair || "",
      baseMint: baseMint || "",
      firstSeenAt: Date.now(),
      collectFeeMode: collectFeeMode ?? null,
      mode: mode ?? "spot:double",
      isDca: isDca === true,
      lastPnlPeak: null,
      lastPnlLowest: null,
      closed: false,
      closedAt: null,
      closeReason: null,
      closePnlPct: null,
      oorSejak: null,
      oorArah: null,
      trailingActive: false,
      trailingArmedBy: null,
      trailingAnchor: null,
      pendingTrailingPeak: null,
      pendingTrailingCurrent: null,
      pendingTrailingDrop: null,
      pendingTrailingStartedAt: null,
      confirmedTrailingExit: null,
      confirmedTrailingExitUntil: null,
      bounceRecoveryState: null,
      bounceRecoveryActivePeak: null,
      // --- DCA ---
      dcaArmed: false,
      dcaTrough: null,
      dcaArmedAt: null,
      dcaTriggered: false,
      dcaTriggeredAt: null,
      pendingDcaTrough: null,
      pendingDcaCurrent: null,
      pendingDcaStartedAt: null,
      missedCycles: 0,
    };
    writeState(state);
  }
}

export function getTrackedPosition(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  return state.positions[positionAddress] || null;
}

export function updateTrackedMode(positionAddress, mode) {
  if (!positionAddress || !mode) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.mode !== mode) {
    p.mode = mode;
    writeState(state);
  }
}

export function updateCollectFeeMode(positionAddress, collectFeeMode) {
  if (!positionAddress || collectFeeMode == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.collectFeeMode !== collectFeeMode) {
    p.collectFeeMode = collectFeeMode;
    writeState(state);
  }
}

export function updatePnlPeaks(positionAddress, pnlPct) {
  if (!positionAddress || pnlPct == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  if (p.lastPnlPeak == null || pnlPct > p.lastPnlPeak) p.lastPnlPeak = pnlPct;
  if (p.lastPnlLowest == null || pnlPct < p.lastPnlLowest) p.lastPnlLowest = pnlPct;
  writeState(state);
}

export function recordClose(positionAddress, reason, pnlPct) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;

  p.closed = true;
  p.closedAt = Date.now();
  p.closeReason = reason || "";
  p.closePnlPct = pnlPct ?? null;
  writeState(state);

  const entry = {
    ts: Date.now(),
    position: positionAddress,
    pool: p.pool,
    pair: p.pair,
    baseMint: p.baseMint,
    ageMinutes: p.firstSeenAt ? Math.floor((Date.now() - p.firstSeenAt) / 60000) : null,
    pnlPct,
    closeReason: reason || "",
    lastPnlPeak: p.lastPnlPeak,
    lastPnlLowest: p.lastPnlLowest,
    trailingArmedBy: p.trailingArmedBy,
    trailingAnchor: p.trailingAnchor,
  };

  const decisionLog = readJsonArray(DECISION_LOG_FILE);
  decisionLog.push(entry);
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(decisionLog, null, 2));
}

export function updateOOR(positionAddress, arah) {
  if (!positionAddress || !arah) return;
  const state = readState();
  if (!state.positions[positionAddress]) {
    state.positions[positionAddress] = { position: positionAddress, firstSeenAt: Date.now() };
  }
  const p = state.positions[positionAddress];
  if (!p.oorSejak || p.oorArah !== arah) {
    p.oorSejak = Date.now();
    p.oorArah = arah;
  }
  writeState(state);
}

export function resetOOR(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p) {
    p.oorSejak = null;
    p.oorArah = null;
    writeState(state);
  }
}

export function getOORState(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p?.oorSejak && p?.oorArah) {
    return { sejak: p.oorSejak, arah: p.oorArah };
  }
  return null;
}

// --- Deteksi posisi hilang (ditutup manual) ---

// Semua posisi yang masih dianggap terbuka oleh bot (belum ditutup bot),
// termasuk entri lama yang belum punya field `closed`.
export function getOpenTrackedPositions() {
  const state = readState();
  return Object.values(state.positions).filter((p) => p && p.closed !== true);
}

export function registerMissedCycle(positionAddress) {
  if (!positionAddress) return 0;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return 0;
  p.missedCycles = (p.missedCycles || 0) + 1;
  writeState(state);
  return p.missedCycles;
}

export function resetMissedCycle(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.missedCycles) {
    p.missedCycles = 0;
    writeState(state);
  }
}

// Tandai posisi sebagai closed karena tidak lagi terbaca on-chain
// (kemungkinan besar ditutup manual di luar bot).
export function markClosedNotDetected(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed) return null;
  p.missedCycles = 0;
  writeState(state);
  recordClose(positionAddress, "not_detected", null);
  return getTrackedPosition(positionAddress);
}
