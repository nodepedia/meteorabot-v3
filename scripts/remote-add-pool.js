#!/usr/bin/env node
// Add-once pool.txt + ledger, dijalankan DI VPS MAIN (lokal atau via ssh) di bawah flock:
//   cd <repo> && flock -w 60 <ledger>.lock node scripts/remote-add-pool.js \
//     --pool-file <pool.txt> --ledger <runner-added.json> [--state <state.json>] \
//     --mint <MINT> --pool <POOL> --pools <POOL,POOL2,...> --line '<POOL>,1x,1,spot' --by runner-alert
// Satu token (mint) hanya boleh di-add SEKALI seumur hidup. Urutan cek:
//   1. ledger sudah punya mint / salah satu pool token        → already_added
//   2. salah satu pool token ada di pool.txt (aktif atau '#')  → already_in_pool (ledger di-backfill)
//   3. state.json punya posisi terbuka di token/pool itu       → already_open
//   4. append baris ke pool.txt, lalu tulis ledger (tmp+rename) → added
// Output: satu baris `RESULT {json}` di stdout. Exit 0 untuk semua status di atas, 2 untuk error.
// TIDAK ada dependency selain Node bawaan.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function readLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw); // ledger rusak → error (jangan menimpa ledger)
  return parsed && typeof parsed === "object" ? parsed : {};
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function entryPools(e) {
  return [e?.pool, ...(Array.isArray(e?.pools) ? e.pools : [])].filter(Boolean);
}

// Alamat pool di tiap baris pool.txt (baris '#' ikut dihitung).
export function poolTxtAddresses(raw) {
  const out = new Set();
  for (const l of String(raw).split("\n")) {
    const a = l.trim().replace(/^#+\s*/, "").split(",")[0]?.trim();
    if (a) out.add(a);
  }
  return out;
}

export function addPoolOnce({ poolFile, ledgerFile, stateFile = "", mint, pool, pools = [], line, by = "", now = new Date() }) {
  if (!mint || !pool || !line) return { status: "error", error: "mint, pool, line wajib" };
  if (/[\r\n]/.test(line)) return { status: "error", error: "line tidak boleh multi-baris" };
  const tokenPools = [...new Set([pool, ...pools].filter(Boolean))];
  const set = new Set(tokenPools);

  const ledger = readLedger(ledgerFile);
  if (ledger[mint]) return { status: "already_added", mint, by: ledger[mint].by || "", addedAt: ledger[mint].addedAt || "" };
  for (const [k, e] of Object.entries(ledger)) {
    const hit = entryPools(e).find((p) => set.has(p));
    if (hit) return { status: "already_added", mint, matchedMint: k, matchedPool: hit, by: e?.by || "" };
  }

  const raw = fs.existsSync(poolFile) ? fs.readFileSync(poolFile, "utf8") : "";
  const inPool = poolTxtAddresses(raw);
  const hit = tokenPools.find((p) => inPool.has(p));
  const record = (status, extra = {}) => {
    ledger[mint] = { mint, pool, pools: tokenPools, addedAt: now.toISOString(), by, ...extra };
    writeAtomic(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
    return { status, mint, pool, ...extra };
  };
  if (hit) return record("already_in_pool", { matchedPool: hit, backfill: true });

  if (stateFile && fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8") || "{}");
    for (const p of Object.values(st.positions || {})) {
      if (p && p.closed !== true && (p.baseMint === mint || set.has(p.pool))) {
        return { status: "already_open", mint, matchedPool: p.pool || "" };
      }
    }
  }

  const prefix = raw && !raw.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(poolFile, `${prefix}${line}\n`);
  return record("added", { line });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) out[k.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let res;
  try {
    const a = parseArgs(process.argv.slice(2));
    res = addPoolOnce({
      poolFile: a["pool-file"],
      ledgerFile: a.ledger,
      stateFile: a.state || "",
      mint: a.mint,
      pool: a.pool,
      pools: (a.pools || "").split(",").map((s) => s.trim()).filter(Boolean),
      line: a.line,
      by: a.by || "",
    });
  } catch (err) {
    res = { status: "error", error: String(err.message || err).split("\n")[0] };
  }
  process.stdout.write(`RESULT ${JSON.stringify(res)}\n`);
  process.exit(res.status === "error" ? 2 : 0);
}
