import fs from "fs";
import path from "path";
import { ROOT } from "../core/paths.js";
import { emptySession } from "./logic.js";

export function entrybotStatePath() {
  const override = process.env.ENTRYBOT_STATE_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(ROOT, "state", "entrybot.json");
}

export function emptyEntrybotState() {
  return { offset: null, session: emptySession(), items: [], logCursors: {}, actionCursor: null };
}

export function loadEntrybotState(file = entrybotStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyEntrybotState();
    return {
      ...emptyEntrybotState(),
      ...parsed,
      session: { ...emptySession(), ...(parsed.session || {}) },
      items: Array.isArray(parsed.items) ? parsed.items : [],
      logCursors: parsed.logCursors && typeof parsed.logCursors === "object" ? parsed.logCursors : {},
    };
  } catch {
    return emptyEntrybotState();
  }
}

export function saveEntrybotState(state, file = entrybotStatePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
