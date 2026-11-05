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
    protectedMints: {},
    pendingSwaps: {},
    dcaCooldownUntil: {},
    entryUsage: {},
    poolAliases: {},
    recentActions: [],
    spotEntryAttempts: [],
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

// Versi ketat untuk pengecekan proteksi swap: file tidak ada = state kosong,
// tetapi file rusak/tidak terbaca = error (fail closed, jangan swap).
export function readRuntimeStateStrict(now = Date.now()) {
  const file = getRuntimeFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return emptyState();
    throw new Error(`runtime state tidak terbaca: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`runtime state rusak: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("runtime state bukan object");
  return normalizeParsed(parsed, now);
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
  return normalizeParsed(parsed, now);
}

function normalizeParsed(parsed, now) {

  const mints = normalizeLockMap(parsed.entryInProgressMints, now);
  const pools = normalizeLockMap(parsed.entryInProgressPools, now);
  const closing = normalizeLockMap(parsed.closingPools, now);
  const closingM = normalizeLockMap(parsed.closingMints, now);
  const cooldowns = normalizeLockMap(parsed.dcaCooldownUntil, now);
  const protectedM = normalizeLockMap(parsed.protectedMints, now);
  const pendingSwaps = {};
  if (parsed.pendingSwaps && typeof parsed.pendingSwaps === "object") {
    for (const [k, v] of Object.entries(parsed.pendingSwaps)) {
      if (k && v && typeof v === "object") pendingSwaps[k] = v;
    }
  }

  const usage = {};
  if (parsed.entryUsage && typeof parsed.entryUsage === "object") {
    for (const [k, v] of Object.entries(parsed.entryUsage)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) usage[k] = n;
    }
  }

  // pool hasil resolve baris CA -> CA (kunci baris pool.txt). Lihat entry/ca-resolve.js.
  const aliases = {};
  if (parsed.poolAliases && typeof parsed.poolAliases === "object") {
    for (const [k, v] of Object.entries(parsed.poolAliases)) {
      if (k && typeof v === "string" && v) aliases[k] = v;
    }
  }

  const actions = Array.isArray(parsed.recentActions)
    ? parsed.recentActions.filter((a) => a && typeof a.text === "string" && Number.isFinite(Number(a.at))).slice(-200)
    : [];

  const spotEntryAttempts = normalizeSpotEntryAttempts(parsed.spotEntryAttempts, now);

  const watchSnapshot = Array.isArray(parsed.watchSnapshot) ? parsed.watchSnapshot : [];
  const walletStatus = parsed.walletStatus && typeof parsed.walletStatus === "object" ? parsed.walletStatus : null;

  return {
    entryInProgressMints: mints.map,
    entryInProgressPools: pools.map,
    closingPools: closing.map,
    closingMints: closingM.map,
    protectedMints: protectedM.map,
    pendingSwaps,
    dcaCooldownUntil: cooldowns.map,
    entryUsage: usage,
    poolAliases: aliases,
    recentActions: actions,
    spotEntryAttempts,
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
  constructor(field, ttlFn = getLockTtlMs) {
    super();
    this._field = field;
    this._ttlFn = ttlFn;
  }

  _replaceFromKeys(keys) {
    super.clear();
    for (const k of keys) super.add(k);
  }

  add(value) {
    if (!value) return this;
    mutateRuntimeState((state, now) => {
      state[this._field][value] = now + this._ttlFn();
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

// Proteksi swap eksplisit (key `mint::tag`) untuk alur panjang yang menahan
// token di wallet (rebalance/reentry OOR kanan, fallback OOR kiri). TTL lebih
// panjang dari lock entry agar tidak kedaluwarsa di tengah proses.
export const PROTECT_TTL_MS = 30 * 60 * 1000;
const protectedMints = new RuntimeLockSet("protectedMints", () => {
  const v = Number(process.env.SWAP_PROTECT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : PROTECT_TTL_MS;
});

function applyStateToMemory(state) {
  entryInProgressMints._replaceFromKeys(Object.keys(state.entryInProgressMints));
  entryInProgressPools._replaceFromKeys(Object.keys(state.entryInProgressPools));
  closingPools._replaceFromKeys(Object.keys(state.closingPools));
  closingMints._replaceFromKeys(Object.keys(state.closingMints));
  protectedMints._replaceFromKeys(Object.keys(state.protectedMints || {}));
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

export function isEntryInProgressMint(mint) {
  return entryInProgressMints.has(mint);
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

// Baris CA di pool.txt: posisi dibuka di pool hasil resolve, tapi kuota/usage & '#'
// mengikuti baris CA. poolAliases[pool] = CA.
export function getPoolAlias(pool) {
  if (!pool) return null;
  return syncRuntimeFromDisk().poolAliases?.[pool] || null;
}

export function setPoolAlias(pool, ca) {
  if (!pool || !ca || pool === ca) return;
  mutateRuntimeState((state) => {
    state.poolAliases = state.poolAliases || {};
    state.poolAliases[pool] = ca;
  });
}

export function clearPoolAliasesFor(key) {
  if (!key) return;
  mutateRuntimeState((state) => {
    for (const [p, ca] of Object.entries(state.poolAliases || {})) {
      if (p === key || ca === key) delete state.poolAliases[p];
    }
  });
}

// Reposisi pindah pool: alias ikut pindah supaya baris CA tetap terhubung.
export function transferPoolAlias(oldPool, newPool) {
  if (!oldPool || !newPool || oldPool === newPool) return;
  mutateRuntimeState((state) => {
    const ca = state.poolAliases?.[oldPool];
    if (!ca) return;
    delete state.poolAliases[oldPool];
    if (newPool !== ca) state.poolAliases[newPool] = ca;
  });
}

const usageKey = (state, pool) => state.poolAliases?.[pool] || pool;

export function getEntryUsage(pool) {
  if (!pool) return 0;
  const state = syncRuntimeFromDisk();
  return state.entryUsage[usageKey(state, pool)] || 0;
}

export function incrementEntryUsage(pool) {
  if (!pool) return 0;
  let uses = 0;
  mutateRuntimeState((state) => {
    const k = usageKey(state, pool);
    uses = (state.entryUsage[k] || 0) + 1;
    state.entryUsage[k] = uses;
  });
  return uses;
}

export function resetEntryUsage(pool) {
  if (!pool) return;
  mutateRuntimeState((state) => {
    delete state.entryUsage[usageKey(state, pool)];
    delete state.entryUsage[pool];
  });
}

export function transferPoolEntryUsage(oldPool, newPool) {
  if (!oldPool || !newPool || oldPool === newPool) return 0;
  let uses = 0;
  mutateRuntimeState((state) => {
    const ko = usageKey(state, oldPool);
    const kn = usageKey(state, newPool);
    if (ko === kn) { uses = state.entryUsage[ko] || 0; return; }
    const prev = state.entryUsage[ko] || 0;
    uses = Math.max(state.entryUsage[kn] || 0, prev, 1);
    state.entryUsage[kn] = uses;
  });
  return uses;
}

// Buffer aksi terakhir (entry/DCA/close/sweep) untuk baris "AKSI" di ringkasan log
// sekaligus mencatat otomatis ke logs/important.log & logs/important-events.jsonl.
function formatActionText(text) {
  if (typeof text === "string") return text;
  if (text && typeof text === "object") {
    if (text.type === "spot_reentry") {
      const switchSuffix = text.switchedPool && text.previousPool && text.pool
        ? ` [pindah pool ${String(text.previousPool).slice(0, 8)}→${String(text.pool).slice(0, 8)}]`
        : "";
      return `RE-ENTRY ${text.pair || "?"} — ${text.sizeSol ?? "?"} SOL (${text.count ?? "?"}/${text.max ?? "?"})${switchSuffix}`;
    }
    if (text.type === "entry") {
      return `ENTRY ${text.pair || "?"} — ${text.sizeSol ?? "?"} SOL (${text.mode || "spot"})`;
    }
    if (typeof text.message === "string") return text.message;
    try {
      return JSON.stringify(text);
    } catch {
      return String(text);
    }
  }
  return String(text);
}

export function recordAction(text) {
  if (!text) return;
  const formatted = formatActionText(text);
  let recordedAt = Date.now();
  mutateRuntimeState((state, now) => {
    recordedAt = now;
    state.recentActions.push({ at: now, text: formatted });
    if (state.recentActions.length > 200) {
      state.recentActions.splice(0, state.recentActions.length - 200);
    }
  });
  try {
    recordImportantFromAction(formatted, recordedAt);
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

export function protectMint(mint, tag = "protected") {
  if (mint) protectedMints.add(`${mint}::${tag}`);
}

export function releaseMint(mint, tag = "protected") {
  if (mint) protectedMints.delete(`${mint}::${tag}`);
}

// --- Swap tertunda pasca-close (lihat exit/pending-swaps.js) ---

export function getPendingSwaps() {
  return { ...(syncRuntimeFromDisk().pendingSwaps || {}) };
}

export function upsertPendingSwap(mint, patch) {
  if (!mint) return;
  mutateRuntimeState((state) => {
    state.pendingSwaps[mint] = { ...(state.pendingSwaps[mint] || {}), ...patch, mint };
  });
}

export function removePendingSwap(mint) {
  if (!mint) return;
  mutateRuntimeState((state) => {
    delete state.pendingSwaps[mint];
  });
}

export function isPoolSwapPending(pool) {
  if (!pool) return false;
  return Object.values(getPendingSwaps()).some((p) => Array.isArray(p.pools) && p.pools.includes(pool));
}

export function isMintSwapPending(mint) {
  return Boolean(mint) && Object.prototype.hasOwnProperty.call(getPendingSwaps(), mint);
}


// --- Percobaan entry spot terbaru (shared entry↔exit) ---
// Dipakai untuk memulihkan entrySizeSol bila tx entry error di log tapi posisi
// sudah mendarat on-chain dan diadopsi exit worker.
export const SPOT_ENTRY_ATTEMPT_TTL_MS = 30 * 60 * 1000;
const SPOT_ENTRY_ATTEMPT_MAX = 50;

function normalizeSpotEntryAttempts(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const ttl = SPOT_ENTRY_ATTEMPT_TTL_MS;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const at = Number(a.at);
    const sizeSol = Number(a.sizeSol);
    if (!Number.isFinite(at) || now - at > ttl) continue;
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) continue;
    if (!a.pool) continue;
    out.push({
      pool: String(a.pool),
      mint: a.mint ? String(a.mint) : null,
      sizeSol,
      minBinId: Number.isFinite(Number(a.minBinId)) ? Number(a.minBinId) : null,
      maxBinId: Number.isFinite(Number(a.maxBinId)) ? Number(a.maxBinId) : null,
      positionPubkey: a.positionPubkey ? String(a.positionPubkey) : null,
      at,
    });
  }
  return out.slice(-SPOT_ENTRY_ATTEMPT_MAX);
}

function pruneSpotEntryAttempts(list, now = Date.now()) {
  return normalizeSpotEntryAttempts(list, now);
}

export function recordSpotEntryAttempt({ pool, mint, sizeSol, minBinId, maxBinId, positionPubkey } = {}) {
  const size = Number(sizeSol);
  if (!pool || !Number.isFinite(size) || size <= 0) return;
  mutateRuntimeState((state, now) => {
    const attempts = pruneSpotEntryAttempts(state.spotEntryAttempts, now);
    attempts.push({
      pool: String(pool),
      mint: mint ? String(mint) : null,
      sizeSol: size,
      minBinId: Number.isFinite(Number(minBinId)) ? Number(minBinId) : null,
      maxBinId: Number.isFinite(Number(maxBinId)) ? Number(maxBinId) : null,
      positionPubkey: positionPubkey ? String(positionPubkey) : null,
      at: now,
    });
    state.spotEntryAttempts = attempts.slice(-SPOT_ENTRY_ATTEMPT_MAX);
  });
}

function attemptMatches(a, { pool, mint, lowerBin, upperBin, positionPubkey } = {}) {
  if (!a) return false;
  if (positionPubkey && a.positionPubkey && a.positionPubkey === positionPubkey) return true;
  if (pool && a.pool !== pool) return false;
  if (mint && a.mint && a.mint !== mint) return false;
  const lower = Number(lowerBin);
  const upper = Number(upperBin);
  if (Number.isFinite(lower) && Number.isFinite(upper) && a.minBinId != null && a.maxBinId != null) {
    return a.minBinId === lower && a.maxBinId === upper;
  }
  // Tanpa span: cocokkan pool (+ mint bila ada).
  return Boolean(pool) && a.pool === pool;
}

export function findSpotEntryAttempt(query = {}, maxAgeMs = SPOT_ENTRY_ATTEMPT_TTL_MS) {
  const now = Date.now();
  const state = syncRuntimeFromDisk(now);
  const attempts = pruneSpotEntryAttempts(state.spotEntryAttempts, now);
  const age = Math.max(0, Number(maxAgeMs) || SPOT_ENTRY_ATTEMPT_TTL_MS);
  // Prioritas: positionPubkey → pool+span → pool(+mint). Ambil yang terbaru.
  let best = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (now - a.at > age) continue;
    if (!attemptMatches(a, query)) continue;
    // exact pubkey match wins immediately
    if (query.positionPubkey && a.positionPubkey === query.positionPubkey) return a;
    if (!best) best = a;
    // prefer span match over pool-only
    if (
      Number.isFinite(Number(query.lowerBin)) &&
      Number.isFinite(Number(query.upperBin)) &&
      a.minBinId === Number(query.lowerBin) &&
      a.maxBinId === Number(query.upperBin)
    ) {
      return a;
    }
  }
  return best;
}

export function consumeSpotEntryAttempt(query = {}, maxAgeMs = SPOT_ENTRY_ATTEMPT_TTL_MS) {
  let found = null;
  mutateRuntimeState((state, now) => {
    const attempts = pruneSpotEntryAttempts(state.spotEntryAttempts, now);
    const age = Math.max(0, Number(maxAgeMs) || SPOT_ENTRY_ATTEMPT_TTL_MS);
    let idx = -1;
    for (let i = attempts.length - 1; i >= 0; i--) {
      const a = attempts[i];
      if (now - a.at > age) continue;
      if (!attemptMatches(a, query)) continue;
      if (query.positionPubkey && a.positionPubkey === query.positionPubkey) {
        idx = i;
        break;
      }
      if (
        Number.isFinite(Number(query.lowerBin)) &&
        Number.isFinite(Number(query.upperBin)) &&
        a.minBinId === Number(query.lowerBin) &&
        a.maxBinId === Number(query.upperBin)
      ) {
        idx = i;
        break;
      }
      if (idx < 0) idx = i;
    }
    if (idx >= 0) {
      found = attempts[idx];
      attempts.splice(idx, 1);
    }
    state.spotEntryAttempts = attempts;
  });
  return found;
}

export function clearSpotEntryAttempts() {
  mutateRuntimeState((state) => {
    state.spotEntryAttempts = [];
  });
}

export function resetRuntimeState() {
  const file = getRuntimeFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  applyStateToMemory(emptyState());
}
