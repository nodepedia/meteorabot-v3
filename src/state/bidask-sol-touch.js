// Arah sentuh entry manual bidask:sol.
// Kunci = mint + target + satuan, jadi mengubah harga membuat arah baru.
// Disimpan di state.json supaya tahan restart.
import { readState, writeState } from "./store.js";

const FIELD = "bidaskSolTouch";

function canonicalTarget(target) {
  const n = Number(target);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 8 : Math.min(16, Math.max(8, Math.ceil(-Math.log10(abs)) + 6));
  let text = n.toFixed(digits);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  if (text === "-0") return "0";
  return text;
}

export function bidaskSolTouchKey(mint, target, unit = "usd") {
  if (!mint) return null;
  const price = canonicalTarget(target);
  if (!price) return null;
  const u = unit === "sol" ? "sol" : "usd";
  return `${mint}|${price}|${u}`;
}

function readMap(state = readState()) {
  const raw = state?.[FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "up" || value === "down") out[key] = value;
  }
  return out;
}

function writeMap(state, map) {
  state[FIELD] = map;
  writeState(state);
}

export function getBidaskSolTouchDirection(key) {
  if (!key) return null;
  return readMap()[key] || null;
}

export function setBidaskSolTouchDirection(key, direction) {
  if (!key || (direction !== "up" && direction !== "down")) return;
  const state = readState();
  const map = readMap(state);
  if (map[key] === direction) return;
  map[key] = direction;
  writeMap(state, map);
}

export function clearBidaskSolTouch(key) {
  if (!key) return;
  const state = readState();
  const map = readMap(state);
  if (!map[key]) return;
  delete map[key];
  writeMap(state, map);
}

// Semua arah milik mint ini (setelah entry, atau saat barisnya di-#).
export function clearBidaskSolTouchForMint(mint) {
  if (!mint) return;
  const state = readState();
  const map = readMap(state);
  const prefix = `${mint}|`;
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeMap(state, map);
}

// Buang arah yang barisnya sudah tidak ada di pool.txt (dihapus, di-#, atau harga diubah).
export function pruneBidaskSolTouch(activeKeys) {
  const keep = new Set((activeKeys || []).filter(Boolean));
  const state = readState();
  const map = readMap(state);
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!keep.has(key)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeMap(state, map);
}
