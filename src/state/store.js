import fs from "fs";
import { STATE_FILE } from "../core/paths.js";

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: {} };
  }
}

export function writeState(data) {
  const payload = JSON.stringify(data, null, 2);
  const tmpFile = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, payload);
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    fs.writeFileSync(STATE_FILE, payload);
  }
}

export function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
