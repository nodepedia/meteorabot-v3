import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TELEGRAM_COMMANDS_FILE, TELEGRAM_OFFSET_FILE } from "../core/paths.js";

// Perintah yang belum diambil exit worker lebih dari ini dianggap kedaluwarsa.
export const TELEGRAM_COMMAND_TTL_MS = 10 * 60 * 1000;

const ACTIONS = new Set(["zap_out", "rebalance"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(file = TELEGRAM_COMMANDS_FILE) {
  return `${file}.lock`;
}

function acquireLock(file, timeoutMs = 5000) {
  const target = lockPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(target, "wx");
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(target);
        if (Date.now() - st.mtimeMs > 15000) fs.unlinkSync(target);
      } catch {
        // kunci sudah hilang
      }
      sleepSync(20);
    }
  }
  throw new Error("telegram queue lock timeout");
}

function releaseLock(file, fd) {
  try {
    fs.closeSync(fd);
  } catch {
    // sudah tertutup
  }
  try {
    fs.unlinkSync(lockPath(file));
  } catch {
    // sudah dilepas
  }
}

function withLock(file, fn) {
  const fd = acquireLock(file);
  try {
    return fn();
  } finally {
    releaseLock(file, fd);
  }
}

function emptyQueue() {
  return { commands: [] };
}

export function readTelegramCommands(file = TELEGRAM_COMMANDS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.commands)) return emptyQueue();
    return parsed;
  } catch {
    return emptyQueue();
  }
}

function writeQueue(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const commands = (data.commands || []).filter((cmd) => {
    if (cmd.status === "pending") return true;
    const finished = Number(cmd.finishedAt) || Number(cmd.requestedAt) || 0;
    return finished >= cutoff;
  });
  fs.writeFileSync(tmp, JSON.stringify({ commands }, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return `tg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

// Idempoten: klik kedua untuk posisi + aksi yang masih pending tidak menambah baris.
export function enqueueTelegramCommand({ id, action, position, requestedAt } = {}, file = TELEGRAM_COMMANDS_FILE) {
  if (!ACTIONS.has(action) || !position) {
    return { enqueued: false, duplicate: false, command: null, error: "invalid_command" };
  }
  return withLock(file, () => {
    const data = readTelegramCommands(file);
    if (id) {
      const sameId = data.commands.find((cmd) => cmd.id === id);
      if (sameId) return { enqueued: false, duplicate: true, command: sameId };
    }
    const pending = data.commands.find(
      (cmd) => cmd.status === "pending" && cmd.action === action && cmd.position === position
    );
    if (pending) return { enqueued: false, duplicate: true, command: pending };
    const command = {
      id: id || newId(),
      action,
      position: String(position),
      requestedAt: Number.isFinite(Number(requestedAt)) ? Number(requestedAt) : Date.now(),
      status: "pending",
      error: null,
      finishedAt: null,
    };
    data.commands.push(command);
    writeQueue(file, data);
    return { enqueued: true, duplicate: false, command };
  });
}

export function listPendingCommands(file = TELEGRAM_COMMANDS_FILE) {
  return withLock(file, () => readTelegramCommands(file).commands.filter((cmd) => cmd.status === "pending"));
}

// Menandai yang kedaluwarsa, lalu mengembalikan yang masih boleh dijalankan.
export function takePendingCommands(now = Date.now(), ttlMs = TELEGRAM_COMMAND_TTL_MS, file = TELEGRAM_COMMANDS_FILE) {
  return withLock(file, () => {
    const data = readTelegramCommands(file);
    const pending = [];
    let changed = false;
    for (const cmd of data.commands) {
      if (cmd.status !== "pending") continue;
      const age = now - Number(cmd.requestedAt);
      if (!Number.isFinite(age) || age > ttlMs) {
        cmd.status = "failed";
        cmd.error = "expired";
        cmd.finishedAt = now;
        changed = true;
        continue;
      }
      pending.push({ ...cmd });
    }
    if (changed) writeQueue(file, data);
    pending.sort((a, b) => {
      const rank = (cmd) => (cmd.action === "zap_out" ? 0 : 1);
      return rank(a) - rank(b) || Number(a.requestedAt) - Number(b.requestedAt);
    });
    return pending;
  });
}

export function markTelegramCommand(id, status, error = null, now = Date.now(), file = TELEGRAM_COMMANDS_FILE) {
  if (!id) return null;
  return withLock(file, () => {
    const data = readTelegramCommands(file);
    const cmd = data.commands.find((item) => item.id === id);
    if (!cmd) return null;
    cmd.status = status;
    cmd.error = error || null;
    cmd.finishedAt = now;
    writeQueue(file, data);
    return { ...cmd };
  });
}

export function readTelegramOffset(file = TELEGRAM_OFFSET_FILE) {
  try {
    const n = Number(JSON.parse(fs.readFileSync(file, "utf8"))?.offset);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeTelegramOffset(offset, file = TELEGRAM_OFFSET_FILE) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ offset: n }));
  fs.renameSync(tmp, file);
}
