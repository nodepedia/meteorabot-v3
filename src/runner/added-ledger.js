// Ledger token yang pernah ditambahkan Runner Alert ke pool.txt (sekali seumur hidup).
// Disimpan di mesin runner: RUNNER_ADDED_PATH atau ROOT/runner-added.json.
import fs from "fs";

export function readAdded(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

export function isAlreadyAdded(ledger, mint, pools) {
  if (mint && ledger[mint]) return true;
  const set = new Set(pools.filter(Boolean));
  return Object.values(ledger).some((e) => (e?.pools || []).some((p) => set.has(p)));
}

export function recordAdded(file, mint, pools) {
  const ledger = readAdded(file);
  const key = mint || pools[0];
  if (!key) return;
  ledger[key] = { pools: [...new Set(pools.filter(Boolean))], addedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}
