import fs from "fs";
import path from "path";
import config from "../config/index.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";

export function loadPoolList() {
  const file = path.resolve(ROOT, config.entry.poolListFile);
  if (!fs.existsSync(file)) {
    log.warn(`Pool list not found: ${file}`);
    return [];
  }
  const raw = fs.readFileSync(file, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [address, sizeRaw, maxRaw] = trimmed.split(",").map((s) => s.trim());
    if (!address) continue;
    const sizeSol = Number(sizeRaw);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      log.warn(`Pool ${address.slice(0, 8)} skipped: invalid entry_size "${sizeRaw ?? ""}"`);
      continue;
    }
    const maxNum = Number(maxRaw);
    const maxPositions = Number.isFinite(maxNum) && maxNum > 0 ? Math.floor(maxNum) : 1;
    entries.push({ pool: address, sizeSol, maxPositions });
  }
  return entries;
}
