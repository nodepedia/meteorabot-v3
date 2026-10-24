import fs from "fs";
import path from "path";
import { RUNTIME_STATE_FILE } from "../core/paths.js";
import { recordImportantFromAction } from "../core/important-log.js";

// Runtime state shared across the 3 independent workers (entry, exit, wallet)
// via an atomic JSON file on disk, while keeping in-memory Set/Map semantics
// for single-process callers and unit tests.

export const LOCK_TTL_MS = 5 * 60 * 1000;

function getLockTtlMs() {
  const envTtl = Number(process.env.RUNTIME_LOCK_TTL_MS);
  return Number.isFinite(envTtl) && envTtl > 0 ? envTtl : LOCK_TTL_MS;
}

function getRuntimeFile() {
  const override = process.env.RUNTIME_STATE_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  const stateOverride = process.env.STATE_FILE;
  if (stateOverride && stateOverride.trim()) {
    return path.join(path.dirname(path.resolve(stateOverride.trim())), "runtime-state.json");
  }
  return RUNTIME_STATE_FILE;
}

function emptyState() {
  return {
    entryInProgressMints: {},
    entryInProgressPools: {},
    closingPools: {},
    closingMints: {},
    dcaCooldownUntil: {},
    entryUsage: {},
    recentActions: [],
    watchSnapshot: [],
    walletStatus: null,
  };
}

function normalizeLockMap(raw, now) {
  const out = {};
  let changed = false;
  if (!raw || typeof raw !== "object") return { map: out, changed: false };
  for (const [key, expiresAt] of Object.entries(raw)) {
    const exp = Number(expiresAt);
    if (key && Number.isFinite(exp) && exp > now) {
      out[key] = exp;
    } else {
      changed = true;
    }
  }
  return { map: out, changed };
}

function readDiskState(now = Date.now()) {
  const file = getRuntimeFile();
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object") return emptyState();

  const mints = normalizeLockMap(parsed.entryInProgressMints, now);
  const pools = normalizeLockMap(parsed.entryInProgressPools, now);
  const closing = normalizeLockMap(parsed.closingPools, now);
  const closingM = normalizeLockMap(parsed.closingMints, now);
  const cooldowns = normalizeLockMap(parsed.dcaCooldownUntil, now);

  const usage = {};
  if (parsed.entryUsage && typeof parsed.entryUsage === "object") {
    for (const [k, v] of Object.entries(parsed.entryUsage)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) usage[k] = n;
    }
  }

  const actions = Array.isArray(parsed.recentActions)
    ? parsed.recentActions.filter((a) => a && typeof a.text === "string" && Number.isFinite(Number(a.at))).slice(-200)
    : [];

  const watchSnapshot = Array.isArray(parsed.watchSnapshot) ? parsed.watchSnapshot : [];
  const walletStatus = parsed.walletStatus && typeof parsed.walletStatus === "object" ? parsed.walletStatus : null;

  return {
    entryInProgressMints: mints.map,
    entryInProgressPools: pools.map,
    closingPools: closing.map,
    closingMints: closingM.map,
    dcaCooldownUntil: cooldowns.map,
    entryUsage: usage,
    recentActions: actions,
    watchSnapshot,
    walletStatus,
  };
}

function writeDiskState(state) {
  const file = getRuntimeFile();
  const payload = JSON.stringify(state, null, 2);
  const tmpFile = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmpFile, payload);
    fs.renameSync(tmpFile, file);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.writeFileSync(file, payload);
    } catch {}
  }
}

class RuntimeLockSet extends Set {
  constructor(field) {
    super();
    this._field = field;
  }

  _replaceFromKeys(keys) {
    super.clear();
    for (const k of keys) super.add(k);
  }

  add(value) {
    if (!value) return this;
    mutateRuntimeState((state, now) => {
      state[this._field][value] = now + getLockTtlMs();
    });
    return this;
  }

  delete(value) {
    if (!value) return false;
    let existed = false;
    mutateRuntimeState((state) => {
      existed = Object.prototype.hasOwnProperty.call(state[this._field], value);
      delete state[this._field][value];
    });
    return existed;
  }

  clear() {
    mutateRuntimeState((state) => {
      state[this._field] = {};
    });
  }

  has(value) {
    syncRuntimeFromDisk();
    return super.has(value);
  }

  get size() {
    syncRuntimeFromDisk();
    return super.size;
  }

  values() {
    syncRuntimeFromDisk();
    return super.values();
  }

  keys() {
    syncRuntimeFromDisk();
    return super.keys();
  }

  entries() {
    syncRuntimeFromDisk();
    return super.entries();
  }

  [Symbol.iterator]() {
    syncRuntimeFromDisk();
    return super[Symbol.iterator]();
  }

  forEach(callbackFn, thisArg) {
    syncRuntimeFromDisk();
    return super.forEach(callbackFn, thisArg);
  }
}

// Base mints currently being acquired by an in-flight entry (swap → position).
// Used by the safety sweep so it never sells tokens mid-entry.
const entryInProgressMints = new RuntimeLockSet("entryInProgressMints");
// Pool yang sedang diproses entry/DCA (cegah entry & DCA bentrok di pool sama).
const entryInProgressPools = new RuntimeLockSet("entryInProgressPools");
// Pool yang sedang ditutup (cegah DCA bertabrakan dengan close/swap).
const closingPools = new RuntimeLockSet("closingPools");
// Mint yang sedang ditutup/di-swap pasca-close (cegah sweep bertabrakan dengan swap close).
const closingMints = new RuntimeLockSet("closingMints");

function applyStateToMemory(state) {
  entryInProgressMints._replaceFromKeys(Object.keys(state.entryInProgressMints));
  entryInProgressPools._replaceFromKeys(Object.keys(state.entryInProgressPools));
  closingPools._replaceFromKeys(Object.keys(state.closingPools));
  closingMints._replaceFromKeys(Object.keys(state.closingMints));
}

function syncRuntimeFromDisk(now = Date.now()) {
  const state = readDiskState(now);
  applyStateToMemory(state);
  return state;
}

function mutateRuntimeState(mutator) {
  const now = Date.now();
  const state = readDiskState(now);
  mutator(state, now);
  writeDiskState(state);
  applyStateToMemory(state);
  return state;
}

export function getEntryInProgressMints() {
  syncRuntimeFromDisk();
  return entryInProgressMints;
}

export function addEntryInProgressMint(mint) {
  if (mint) entryInProgressMints.add(mint);
}

export function removeEntryInProgressMint(mint) {
  if (mint) entryInProgressMints.delete(mint);
}

export function getEntryInProgressPools() {
  syncRuntimeFromDisk();
  return entryInProgressPools;
}

export function isEntryInProgressPool(pool) {
  return entryInProgressPools.has(pool);
}

export function addEntryInProgressPool(pool) {
  if (pool) entryInProgressPools.add(pool);
}

export function removeEntryInProgressPool(pool) {
  if (pool) entryInProgressPools.delete(pool);
}

export function isPoolClosing(pool) {
  return closingPools.has(pool);
}

export function getClosingPools() {
  syncRuntimeFromDisk();
  return closingPools;
}

export function addClosingPool(pool) {
  if (pool) closingPools.add(pool);
}

export function removeClosingPool(pool) {
  if (pool) closingPools.delete(pool);
}

export function getClosingMints() {
  syncRuntimeFromDisk();
  return closingMints;
}

export function isMintClosing(mint) {
  return closingMints.has(mint);
}

export function addClosingMint(mint) {
  if (mint) closingMints.add(mint);
}

export function removeClosingMint(mint) {
  if (mint) closingMints.delete(mint);
}

export function getDcaCooldownUntil(pool) {
  if (!pool) return 0;
  const state = syncRuntimeFromDisk();
  return state.dcaCooldownUntil[pool] || 0;
}

export function setDcaCooldown(pool, ms) {
  if (pool && ms > 0) {
    mutateRuntimeState((state, now) => {
      state.dcaCooldownUntil[pool] = now + ms;
    });
  }
}

export function getEntryUsage(pool) {
  if (!pool) return 0;
  const state = syncRuntimeFromDisk();
  return state.entryUsage[pool] || 0;
}

export function incrementEntryUsage(pool) {
  if (!pool) return 0;
  let uses = 0;
  mutateRuntimeState((state) => {
    uses = (state.entryUsage[pool] || 0) + 1;
    state.entryUsage[pool] = uses;
  });
  return uses;
}

// Buffer aksi terakhir (entry/DCA/close/sweep) untuk baris "AKSI" di ringkasan log
// sekaligus mencatat otomatis ke logs/important.log & logs/important-events.jsonl.
export function recordAction(text) {
  if (!text) return;
  let recordedAt = Date.now();
  mutateRuntimeState((state, now) => {
    recordedAt = now;
    state.recentActions.push({ at: now, text: String(text) });
    if (state.recentActions.length > 200) {
      state.recentActions.splice(0, state.recentActions.length - 200);
    }
  });
  try {
    recordImportantFromAction(String(text), recordedAt);
  } catch {
    // silent
  }
}

export function takeRecentActions(sinceMs) {
  const now = Date.now();
  const state = syncRuntimeFromDisk(now);
  const cutoff = now - Math.max(0, Number(sinceMs) || 0);
  return state.recentActions.filter((a) => a.at >= cutoff).map((a) => a.text);
}

export function setWatchSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return;
  mutateRuntimeState((state) => {
    state.watchSnapshot = snapshot;
  });
}

export function getSharedWatchSnapshot() {
  const state = syncRuntimeFromDisk();
  return Array.isArray(state.watchSnapshot) ? state.watchSnapshot : [];
}

export function setWalletStatus(status) {
  if (!status || typeof status !== "object") return;
  mutateRuntimeState((state, now) => {
    state.walletStatus = { ...status, updatedAt: status.updatedAt || now };
  });
}

export function getWalletStatus() {
  const state = syncRuntimeFromDisk();
  return state.walletStatus || null;
}

export function resetRuntimeState() {
  const file = getRuntimeFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  applyStateToMemory(emptyState());
}
