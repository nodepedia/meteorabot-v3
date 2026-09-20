import { readState, writeState } from "./store.js";

// --- Eligibility ---

export function isDcaEligible(tracked) {
  if (!tracked || tracked.closed) return false;
  if (tracked.dcaTriggered) return false;
  return true;
}

// --- Pure decision (dipakai processDca + test) ---

// evaluateDca memutuskan aksi DCA dari PnL saat ini + state tracking.
// Murni (tanpa I/O) supaya mudah diuji.
export function evaluateDca(position, tracked, cfg) {
  if (!cfg?.enabled) return { action: "noop", reason: "disabled" };
  if (!position || position.pnlPct == null) return { action: "noop", reason: "no_pnl" };
  if (!tracked || tracked.closed) return { action: "noop", reason: "not_tracked" };
  if (tracked.dcaTriggered) return { action: "noop", reason: "already_triggered" };

  const pnl = position.pnlPct;
  const armed = tracked.dcaArmed === true;
  const trough = Number.isFinite(tracked.dcaTrough) ? tracked.dcaTrough : null;

  if (!armed) {
    if (pnl <= cfg.armPct) return { action: "arm", trough: pnl };
    return { action: "noop", reason: "not_armed" };
  }

  if (trough == null) return { action: "arm", trough: pnl };
  if (pnl < trough) return { action: "trail", trough: pnl };

  const rebound = pnl - trough;
  if (rebound >= cfg.reboundPct) {
    return { action: "queue_rebound", trough, current: pnl, rebound };
  }
  return { action: "hold", trough, rebound };
}

// --- State mutations (persisten) ---

export function setDcaArmedAndTrough(positionAddress, trough) {
  if (!positionAddress || !Number.isFinite(trough)) return null;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !isDcaEligible(p)) return null;
  p.dcaArmed = true;
  if (p.dcaArmedAt == null) p.dcaArmedAt = Date.now();
  if (p.dcaTrough == null || trough < p.dcaTrough) p.dcaTrough = trough;
  writeState(state);
  return p.dcaTrough;
}

export function queueDcaRebound(positionAddress, trough, currentPnl) {
  if (!positionAddress || trough == null || currentPnl == null) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || !isDcaEligible(p)) return;
  p.pendingDcaTrough = trough;
  p.pendingDcaCurrent = currentPnl;
  p.pendingDcaStartedAt = Date.now();
  writeState(state);
}

export function clearPendingDca(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
  writeState(state);
}

// Resolusi konfirmasi: rebound sah bila saat dicek ulang PnL masih minimal
// `reboundPct` di atas trough. Jika balik turun, pending dibatalkan dan trough
// diperbarui bila makin dalam (lalu trail lanjut).
export function resolvePendingDca(positionAddress, currentPnl, reboundPct) {
  if (!positionAddress) return { confirmed: false, pending: false };
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p || p.closed || p.pendingDcaTrough == null || p.pendingDcaCurrent == null) {
    return { confirmed: false, pending: false };
  }

  const trough = p.pendingDcaTrough;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;

  const threshold = Number.isFinite(Number(reboundPct)) ? Math.max(0, Number(reboundPct)) : 0;
  const stillRebounded = currentPnl != null && currentPnl - trough >= threshold;

  if (stillRebounded) {
    writeState(state);
    return { confirmed: true, trough, current: currentPnl };
  }

  if (currentPnl != null && (p.dcaTrough == null || currentPnl < p.dcaTrough)) {
    p.dcaTrough = currentPnl;
  }
  writeState(state);
  return { confirmed: false, rejected: true };
}

export function markDcaTriggered(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.dcaTriggered = true;
  p.dcaTriggeredAt = Date.now();
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
  writeState(state);
}

// Batalkan flag trigger (mis. eksekusi gagal) agar posisi bisa memicu lagi
// setelah cooldown pool berakhir.
export function clearDcaTriggered(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.dcaTriggered = false;
  p.dcaTriggeredAt = null;
  writeState(state);
}

export function clearDcaState(positionAddress) {
  if (!positionAddress) return;
  const state = readState();
  const p = state.positions[positionAddress];
  if (!p) return;
  p.dcaArmed = false;
  p.dcaTrough = null;
  p.dcaArmedAt = null;
  p.dcaTriggered = false;
  p.dcaTriggeredAt = null;
  p.pendingDcaTrough = null;
  p.pendingDcaCurrent = null;
  p.pendingDcaStartedAt = null;
  writeState(state);
}

// --- Counter DCA per sesi (persisten di state.dcaUsage) ---
// Sesi = rentang saat pool punya >=1 posisi terbuka. Counter naik saat trigger
// DCA (sebelum eksekusi, jadi aman crash) dan di-reset saat sesi berakhir
// (pool tidak lagi punya posisi terbuka). Inilah yang membatasi DCA_MAX_ADDS
// per sesi sekaligus tahan restart.

export function getPoolDcaCount(pool) {
  if (!pool) return 0;
  const state = readState();
  return state.dcaUsage?.[pool] || 0;
}

export function incrementPoolDca(pool) {
  if (!pool) return 0;
  const state = readState();
  if (!state.dcaUsage) state.dcaUsage = {};
  const n = (state.dcaUsage[pool] || 0) + 1;
  state.dcaUsage[pool] = n;
  writeState(state);
  return n;
}

// Batalkan reservasi (mis. eksekusi DCA gagal) agar bisa dicoba lagi.
export function decrementPoolDca(pool) {
  if (!pool) return 0;
  const state = readState();
  if (!state.dcaUsage || !(pool in state.dcaUsage)) return 0;
  const n = Math.max(0, (state.dcaUsage[pool] || 0) - 1);
  if (n === 0) delete state.dcaUsage[pool];
  else state.dcaUsage[pool] = n;
  writeState(state);
  return n;
}

export function resetPoolDca(pool) {
  if (!pool) return;
  const state = readState();
  if (!state.dcaUsage || !(pool in state.dcaUsage)) return;
  delete state.dcaUsage[pool];
  writeState(state);
}

// Reset counter untuk pool yang tidak ada di `activePools` (sesi berakhir).
// `activePools` = pool dengan posisi terbuka + pool in-flight + pool closing.
export function resetStaleDcaPools(activePools) {
  const active = activePools instanceof Set ? activePools : new Set(activePools || []);
  const state = readState();
  if (!state.dcaUsage) return;
  let changed = false;
  for (const pool of Object.keys(state.dcaUsage)) {
    if (!active.has(pool)) {
      delete state.dcaUsage[pool];
      changed = true;
    }
  }
  if (changed) writeState(state);
}
