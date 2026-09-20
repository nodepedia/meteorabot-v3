import fs from "fs";
import { ENV_FILE } from "../core/paths.js";

export function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export const bool = (val, def = true) => (val == null ? def : val !== "false");

export const num = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) && val !== "" && val != null ? n : def;
};
