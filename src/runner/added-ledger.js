// Ledger token yang pernah ditambahkan ke pool.txt (sekali seumur hidup), DIPAKAI BERSAMA
// oleh Runner Alert dan meteora-pool-monitor. Set RUNNER_ADDED_PATH ke file yang SAMA di
// kedua app (default Runner Alert: ROOT/runner-added.json). Format: { [mint]: {pools, addedAt, by} }.
// File ini identik dengan meteora-pool-monitor/src/added-ledger.js — ubah keduanya bersamaan.
import fs from "fs";
import path from "path";

const STALE_LOCK_MS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readAdded(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

export function isAlreadyAdded(ledger, mint, pools) {
  if (mint && ledger[mint]) return true;
  const set = new Set(pools.filter(Boolean));
  return Object.values(ledger).some((e) => (e?.pools || []).some((p) => set.has(p)));
}

export function recordAdded(file, mint, pools, by = "") {
  const ledger = readAdded(file);
  const key = mint || pools[0];
  if (!key) return;
  ledger[key] = { pools: [...new Set(pools.filter(Boolean))], addedAt: new Date().toISOString(), ...(by ? { by } : {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

// Kunci eksklusif lintas proses (O_EXCL lockfile) selama cek → add ke pool.txt → record,
// supaya dua app tidak bisa sama-sama add token yang sama. Lock basi (>120s) dibersihkan.
export async function withLedgerLock(file, fn, { timeoutMs = 180000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, "wx"); fs.writeSync(fd, String(process.pid)); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() - t0 > timeoutMs) throw new Error(`ledger lock timeout ${lock}`);
      await sleep(200);
    }
  }
  try { return await fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

// Satu langkah atomik: kalau token/pool belum ada di ledger, jalankan add(); record hanya
// kalau add() melapor sukses (action "added" / "added_remote").
export async function addOnce(file, { mint, pools, by = "" }, add) {
  return withLedgerLock(file, async () => {
    if (isAlreadyAdded(readAdded(file), mint, pools)) return { changed: false, action: "skipped_already_added" };
    const upd = await add();
    if (upd?.action === "added" || upd?.action === "added_remote") recordAdded(file, mint, pools, by);
    return upd;
  });
}
