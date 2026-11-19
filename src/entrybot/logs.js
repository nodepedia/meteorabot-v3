import fs from "fs";
import path from "path";
import { LOG_DIR } from "../core/paths.js";

export function entryLogFiles(now = new Date(), dir = LOG_DIR) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return [path.join(dir, `meteorabot-${y}-${m}-${d}.log`), path.join(dir, "entry-out.log")];
}

// Baca potongan baru. File yang baru pertama kali dilihat mulai dari akhir,
// supaya log lama tidak membangunkan ulang peringatan.
export function takeNewLogLines(files, cursors = {}, fsImpl = fs, maxBytes = 256 * 1024) {
  const next = { ...cursors };
  const lines = [];
  for (const file of files || []) {
    let size = 0;
    try {
      size = fsImpl.statSync(file).size;
    } catch {
      continue;
    }
    const prev = next[file];
    let offset = prev?.offset;
    let remainder = prev?.remainder || "";
    if (offset == null) {
      next[file] = { offset: size, remainder: "" };
      continue;
    }
    if (offset > size) {
      offset = 0;
      remainder = "";
    }
    if (offset === size) {
      next[file] = { offset, remainder };
      continue;
    }
    const len = Math.min(size - offset, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fsImpl.openSync(file, "r");
    try {
      fsImpl.readSync(fd, buf, 0, len, offset);
    } finally {
      fsImpl.closeSync(fd);
    }
    const parts = `${remainder}${buf.toString("utf8")}`.split(/\r?\n/);
    const incomplete = parts.pop() ?? "";
    for (const line of parts) if (line) lines.push(line);
    next[file] = { offset: offset + len, remainder: incomplete };
  }
  return { lines, cursors: next };
}

export function takeNewActions(actions, cursor, now = Date.now()) {
  const list = (actions || []).filter(
    (action) => action && typeof action.text === "string" && Number.isFinite(Number(action.at))
  );
  if (cursor == null) {
    const max = list.reduce((peak, action) => Math.max(peak, Number(action.at)), 0);
    return { lines: [], cursor: max || now };
  }
  const fresh = list.filter((action) => Number(action.at) > cursor);
  const next = fresh.reduce((peak, action) => Math.max(peak, Number(action.at)), cursor);
  return { lines: fresh.map((action) => action.text), cursor: next };
}
