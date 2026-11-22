// Arah dan kunci sentuh (armed) untuk target opsional entry bidask:double.
// Kunci = identitas baris pool.txt (kolom pertama) + target + satuan,
// sama seperti bidask:sol, jadi mengubah harga membuat kunci baru.
// armed tetap true walau harga menjauh. Disimpan di state.json, tahan restart.
import { readState, writeState } from "./store.js";

const FIELD = "bidaskDoubleTouch";

function normalize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const direction = value.direction === "up" || value.direction === "down" ? value.direction : null;
  const armed = value.armed === true;
  if (!direction && !armed) return null;
  return { direction, armed };
}

function readMap(state = readState()) {
  const raw = state?.[FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const row = normalize(value);
    if (row) out[key] = row;
  }
  return out;
}

function writeMap(state, map) {
  state[FIELD] = map;
  writeState(state);
}

function same(a, b) {
  return !!a && !!b && a.direction === b.direction && a.armed === b.armed;
}

export function getBidaskDoubleTouch(key) {
  if (!key) return null;
  return readMap()[key] || null;
}

export function setBidaskDoubleTouch(key, next) {
  const row = normalize(next);
  if (!key || !row) return;
  const state = readState();
  const map = readMap(state);
  if (same(map[key], row)) return;
  map[key] = row;
  writeMap(state, map);
}

export function clearBidaskDoubleTouch(key) {
  if (!key) return;
  const state = readState();
  const map = readMap(state);
  if (!map[key]) return;
  delete map[key];
  writeMap(state, map);
}

// Semua kunci milik baris ini (kolom pertama: mint CA atau alamat pool).
export function clearBidaskDoubleTouchForId(id) {
  if (!id) return;
  const state = readState();
  const map = readMap(state);
  const prefix = `${id}|`;
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeMap(state, map);
}

// Buang kunci yang barisnya sudah tidak ada, di-#, atau harganya diubah.
export function pruneBidaskDoubleTouch(activeKeys) {
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
