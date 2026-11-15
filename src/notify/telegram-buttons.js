import fs from "fs";
import path from "path";
import { TELEGRAM_BUTTONS_FILE } from "../core/paths.js";

// callback_data Telegram maksimal 64 byte. Kode aksi + kunci pendek posisi.
const CALLBACK_CODE = {
  r: { kind: "ask", action: "rebalance" },
  z: { kind: "ask", action: "zap_out" },
  R: { kind: "confirm", action: "rebalance" },
  Z: { kind: "confirm", action: "zap_out" },
  x: { kind: "cancel", action: null },
};

const REBALANCE_MODES = new Set(["spot", "bidask:double", "bidask:sol"]);

export function modeSupportsRebalance(mode) {
  return REBALANCE_MODES.has(mode);
}

export function positionLabel(p) {
  const raw = p?.pair || p?.label || (p?.position ? String(p.position).slice(0, 8) : "?");
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.slice(0, 40) || "?";
}

// Awalan unik di antara alamat yang sedang tampil. 8 karakter biasanya cukup;
// diperpanjang hanya bila dua posisi berbagi awalan yang sama.
export function uniquePrefix(address, addresses) {
  const addr = String(address || "");
  const all = (addresses || []).map((item) => String(item));
  if (!addr) return "";
  for (let len = Math.min(8, addr.length); len <= addr.length; len++) {
    const key = addr.slice(0, len);
    if (all.filter((item) => item.startsWith(key)).length <= 1) return key;
  }
  return addr;
}

export function keyForPosition(address, catalog, addresses) {
  const addr = String(address || "");
  if (catalog && typeof catalog === "object") {
    for (const [key, row] of Object.entries(catalog)) {
      if (row && row.position === addr) return key;
    }
  }
  return uniquePrefix(addr, addresses);
}

export function encodeCallbackData(code, key) {
  if (!CALLBACK_CODE[code]) throw new Error(`kode callback tidak dikenal: ${code}`);
  const data = `${code}:${key}`;
  if (Buffer.byteLength(data) > 64) throw new Error("callback_data melewati 64 byte");
  return data;
}

export function decodeCallbackData(data) {
  const text = String(data ?? "");
  if (!text || Buffer.byteLength(text) > 64) return null;
  const idx = text.indexOf(":");
  if (idx <= 0) return null;
  const code = text.slice(0, idx);
  const key = text.slice(idx + 1);
  const spec = CALLBACK_CODE[code];
  if (!spec || !key) return null;
  return { code, kind: spec.kind, action: spec.action, key };
}

export function isAllowedTelegramChat(chatId, allowedChatId) {
  if (allowedChatId == null || allowedChatId === "") return false;
  if (chatId == null || chatId === "") return false;
  return String(chatId) === String(allowedChatId);
}

function fitButton(prefix, label) {
  const room = 64 - prefix.length;
  const cut = room > 0 ? String(label).slice(0, room) : "";
  return `${prefix}${cut}`.slice(0, 64);
}

function normalRow(key, label, allowRebalance) {
  const row = [];
  if (allowRebalance) {
    row.push({ text: fitButton("♻️ Rebalance ", label), callback_data: encodeCallbackData("r", key) });
  }
  row.push({ text: fitButton("⚡ Zap Out ", label), callback_data: encodeCallbackData("z", key) });
  return row;
}

function confirmRow(key, label, action) {
  const prefix = action === "rebalance" ? "✅ Ya, rebalance " : "✅ Ya, zap out ";
  const code = action === "rebalance" ? "R" : "Z";
  return [
    { text: fitButton(prefix, label), callback_data: encodeCallbackData(code, key) },
    { text: "✖️ Batal", callback_data: encodeCallbackData("x", key) },
  ];
}

// Satu baris per posisi. `pendingKey` mengganti baris itu jadi konfirmasi.
export function buildStatusKeyboard(positions, { pendingKey = null, pendingAction = null, catalog = null } = {}) {
  const list = (positions || []).filter((p) => p?.position && p.closed !== true);
  const addresses = list.map((p) => String(p.position));
  const inline_keyboard = [];
  for (const p of list) {
    const key = keyForPosition(p.position, catalog, addresses);
    const label = positionLabel(p);
    const allowRebalance = modeSupportsRebalance(p.mode);
    if (pendingKey && key === pendingKey && (pendingAction === "zap_out" || pendingAction === "rebalance")) {
      if (pendingAction === "rebalance" && !allowRebalance) {
        inline_keyboard.push(normalRow(key, label, false));
      } else {
        inline_keyboard.push(confirmRow(key, label, pendingAction));
      }
      continue;
    }
    inline_keyboard.push(normalRow(key, label, allowRebalance));
  }
  return { inline_keyboard };
}

export function scheduledToast(action, label) {
  if (action === "rebalance") return `Rebalance ${label} dijadwalkan`;
  return `Zap Out ${label} dijadwalkan`;
}

export function catalogFromPositions(positions) {
  const list = (positions || []).filter((p) => p?.position);
  const addresses = list.map((p) => String(p.position));
  const byKey = {};
  for (const p of list) {
    const key = uniquePrefix(String(p.position), addresses);
    byKey[key] = {
      position: String(p.position),
      label: positionLabel(p),
      mode: p.mode || "",
      rebalance: modeSupportsRebalance(p.mode),
    };
  }
  return byKey;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function publishButtonCatalog(positions, file = TELEGRAM_BUTTONS_FILE) {
  const byKey = catalogFromPositions(positions);
  writeJsonAtomic(file, { updatedAt: Date.now(), byKey });
  return byKey;
}

export function readButtonCatalog(file = TELEGRAM_BUTTONS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.byKey || typeof parsed.byKey !== "object") return {};
    return parsed.byKey;
  } catch {
    return {};
  }
}

export function resolvePositionKey(key, catalog, openPositions) {
  if (!key) return null;
  const row = catalog && catalog[key];
  if (row?.position) return row;
  const list = openPositions || [];
  const addresses = list.map((p) => String(p.position || ""));
  for (const p of list) {
    if (!p?.position) continue;
    if (keyForPosition(p.position, null, addresses) === key) {
      return {
        position: String(p.position),
        label: positionLabel(p),
        mode: p.mode || "",
        rebalance: modeSupportsRebalance(p.mode),
      };
    }
  }
  return null;
}
