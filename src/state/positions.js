import fs from "fs";
import { DECISION_LOG_FILE } from "../core/paths.js";
import { LEGACY_MODE } from "../config/rules.js";
import { readState, writeState, readJsonArray } from "./store.js";

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Waktu mulai warmup exit. Re-entry OOR kanan mengisi exitWarmupStartedAt;
// entry baru (field kosong) tetap memakai firstSeenAt.
export function resolveExitWarmupStartedAt(tracked) {
  return finitePositive(tracked?.exitWarmupStartedAt) ?? finitePositive(tracked?.firstSeenAt);
}

export function trackPosition(
  positionAddress,
  pool,
  pair,
  baseMint,
  collectFeeMode,
  mode,
  isDca = false,
  extra = null
) {
  if (!positionAddress) return;
  const state = readState();
  // Baris yang sudah ada tidak diubah. Deteksi on-chain berikutnya tidak boleh
  // menimpa firstSeenAt atau exitWarmupStartedAt yang sudah diwariskan.
  if (!state.positions[positionAddress]) {
    state.positions[positionAddress] = {
      position: positionAddress,
      pool: pool || "",
      pair: pair || "",
      baseMint: baseMint || "",
      firstSeenAt: Date.now(),
      // Re-entry OOR kanan: waktu mulai warmup posisi yang diganti. Kosong =
      // entry baru, warmup dihitung dari firstSeenAt. Hanya diisi sekali.
      exitWarmupStartedAt: finitePositive(extra?.exitWarmupStartedAt),
      collectFeeMode: collectFeeMode ?? null,
      mode: mode ?? "spot",
      // Range bin posisi (dicatat sekali saat pertama terlihat; tidak pernah
      // ditulis ulang karena posisi tidak di-resize).
      lowerBin: null,
      upperBin: null,
      binSpan: null,
      // Harga pool (SOL per token base) saat posisi dibuka; dipakai untuk
      // cross-check DCA (pastikan penurunan harga nyata, bukan glitch PnL).
      entryPoolPrice: null,
      isDca: isDca === true,
      lastPnlPeak: null,
      lastPnlLowest: null,
      closed: false,
      closedAt: null,
      closeReason: null,
      closePnlPct: null,
      oorSejak: null,
      oorArah: null,
      // Mulai hitung yield rendah (mode spot): sejak kapan kondisi terpenuhi.
      lowYieldSejak: null,
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
      // "price" | "pnl" | null. null pada posisi lama = trough PnL.
      dcaMetric: null,
      pendingDcaTrough: null,
      pendingDcaCurrent: null,
      pendingDcaStartedAt: null,
      // Safeguard: posisi asli ditandai untuk ikut close setelah DCA terakhir
      // exit karena trailing TP.
      dcaCloseSafeguard: false,
      missedCycles: 0,
      // Berapa kali posisi ini adalah hasil re-entry spot OOR kanan (diwariskan
      // ke posisi berikutnya supaya rantai berhenti di SPOT_REENTRY_MAX).
      spotReentryCount: 0,
      // Level persentase bin token terakhir yang sudah di-rebalance ke BidAsk (mis. 15, 30, 45).
      lastSpotTokenBidaskPct: 0,
      lastSpotTokenBidaskAt: null,
      lastSpotTokenBidaskBin: null,
      // Step rebalance bidask:double yang sudah dikerjakan (10, 20, 30, ...).
      // Bin aktif saat step itu dicatat, untuk mengukur harga yang naik lagi.
      lastBidaskDoubleRebalancePct: 0,
      lastBidaskDoubleRebalanceAt: null,
      lastBidaskDoubleRebalanceBin: null,
    };
    writeState(state);
  }
}

// Simpan harga pool saat posisi dibuka (hanya bila belum ada nilainya).
export function setEntryPoolPrice(positionAddress, price) {
  const value = Number(price);
  if (!positionAddress || !Number.isFinite(value) || value <= 0) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.entryPoolPrice != null) return p?.entryPoolPrice ?? null;
  p.entryPoolPrice = value;
  writeState(state);
  return value;
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

// Catat range bin sekali saja (lower/upper/span). Tidak menimpa bila sudah ada.
export function recordTrackedRange(positionAddress, lowerBin, upperBin) {
  if (!positionAddress) return;
  const lower = Number(lowerBin);
  const upper = Number(upperBin);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.binSpan != null) return;
  p.lowerBin = lower;
  p.upperBin = upper;
  p.binSpan = upper - lower;
  writeState(state);
}

// --- Counter re-entry spot (OOR kanan) ---

export function getSpotReentryCount(positionAddress) {
  if (!positionAddress) return 0;
  const state = readState();
  return Number(state.positions[positionAddress]?.spotReentryCount) || 0;
}

export function setSpotReentryCount(positionAddress, count) {
  if (!positionAddress) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.spotReentryCount = n;
  writeState(state);
}

// Isi waktu mulai warmup sekali. Nilai yang sudah ada tidak ditimpa, termasuk
// bila deteksi on-chain sempat membuat baris lebih dulu (field masih kosong).
export function setExitWarmupStartedAt(positionAddress, ts) {
  const value = finitePositive(ts);
  if (!positionAddress || value == null) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return null;
  const existing = finitePositive(p.exitWarmupStartedAt);
  if (existing != null) return existing;
  p.exitWarmupStartedAt = value;
  writeState(state);
  return value;
}

// --- State rebalance token-side spot → BidAsk ---

export function getSpotTokenBidaskState(positionAddress) {
  if (!positionAddress) return { lastPct: 0, lastAt: null, lastBin: null };
  const state = readState();
  const p = state.positions[positionAddress];
  return {
    lastPct: Math.max(0, Number(p?.lastSpotTokenBidaskPct) || 0),
    lastAt: p?.lastSpotTokenBidaskAt ?? null,
    lastBin:
      p?.lastSpotTokenBidaskBin != null && Number.isFinite(Number(p.lastSpotTokenBidaskBin))
        ? Number(p.lastSpotTokenBidaskBin)
        : null,
  };
}

export function updateSpotTokenBidaskState(positionAddress, pct, at = Date.now(), bin = undefined) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  const nextPct = Math.max(0, Number(pct) || 0);
  p.lastSpotTokenBidaskPct = nextPct;
  if (at !== undefined) {
    p.lastSpotTokenBidaskAt = at;
  }
  if (bin !== undefined) {
    p.lastSpotTokenBidaskBin = bin != null && Number.isFinite(Number(bin)) ? Number(bin) : null;
  } else if (nextPct === 0) {
    p.lastSpotTokenBidaskBin = null;
  }
  writeState(state);
}

export function updateBidaskDoubleRebalanceState(positionAddress, pct, at = Date.now(), bin = undefined) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  const nextPct = Math.max(0, Number(pct) || 0);
  p.lastBidaskDoubleRebalancePct = nextPct;
  p.lastBidaskDoubleRebalanceAt = at;
  if (bin !== undefined) {
    p.lastBidaskDoubleRebalanceBin = bin != null && Number.isFinite(Number(bin)) ? Number(bin) : null;
  } else if (nextPct === 0) {
    p.lastBidaskDoubleRebalanceBin = null;
  }
  writeState(state);
}

export function getPoolTrackedPositions(pool) {
  if (!pool) return [];
  const state = readState();
  return Object.values(state.positions).filter((p) => p && p.pool === pool);
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

// --- Timer yield rendah (mode spot) ---

// Set sekali saat kondisi low-yield pertama terpenuhi (tidak me-reset bila ada).
export function setLowYieldSince(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return null;
  if (p.lowYieldSejak == null) {
    p.lowYieldSejak = Date.now();
    writeState(state);
  }
  return p.lowYieldSejak;
}

export function getLowYieldSince(positionAddress) {
  if (!positionAddress) return null;
  const state = readState();
  return state.positions[positionAddress]?.lowYieldSejak ?? null;
}

export function clearLowYieldSince(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p && p.lowYieldSejak != null) {
    p.lowYieldSejak = null;
    writeState(state);
  }
}

// Tulis waktu mulai kondisi yield rendah. `null` menghapus.
export function writeLowYieldSince(positionAddress, ts) {
  if (!positionAddress) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return null;
  const next = Number.isFinite(ts) ? ts : null;
  if (p.lowYieldSejak === next) return next;
  p.lowYieldSejak = next;
  writeState(state);
  return next;
}

// --- Deteksi posisi hilang (ditutup manual) ---

// Semua posisi yang masih dianggap terbuka oleh bot (belum ditutup bot),
// termasuk entri lama yang belum punya field `closed`.
export function getOpenTrackedPositions() {
  const state = readState();
  return Object.values(state.positions).filter((p) => p && p.closed !== true);
}

// Hitung posisi terbuka per pool untuk satu mode (murni, mudah diuji).
// Label mode lama dinormalkan agar `bidask` tetap terhitung sebagai
// `bidask:double`. Mode lain (mis. spot manual) tidak ikut dihitung.
export function countOpenByPoolAndMode(positions, mode) {
  const want = LEGACY_MODE[mode] || mode;
  const counts = new Map();
  for (const p of positions || []) {
    if (!p || p.closed === true || !p.pool) continue;
    if ((LEGACY_MODE[p.mode] || p.mode) !== want) continue;
    counts.set(p.pool, (counts.get(p.pool) || 0) + 1);
  }
  return counts;
}

export function countOpenBotPositionsByPool(mode) {
  return countOpenByPoolAndMode(getOpenTrackedPositions(), mode);
}

export function getOpenPositionsForMint(baseMint, excludePositionAddress = null) {
  if (!baseMint) return [];
  return getOpenTrackedPositions().filter(
    (p) =>
      p && !p.closed && p.baseMint === baseMint && (!excludePositionAddress || p.position !== excludePositionAddress)
  );
}

export function countOpenBotPositionsByMint() {
  const counts = new Map();
  for (const p of getOpenTrackedPositions()) {
    if (!p || p.closed === true || !p.baseMint) continue;
    counts.set(p.baseMint, (counts.get(p.baseMint) || 0) + 1);
  }
  return counts;
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

export function getEntrySizeSol(positionAddress) {
  const s = readState();
  const n = Number(s.positions?.[positionAddress]?.entrySizeSol);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setEntrySizeSol(positionAddress, sizeSol) {
  if (!positionAddress) return;
  const num = Number(sizeSol);
  if (!Number.isFinite(num) || num <= 0) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (p) {
    p.entrySizeSol = num;
    writeState(state);
  }
}
