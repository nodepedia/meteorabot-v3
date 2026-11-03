// Client add-once ke VPS MAIN. Ledger otoritatif (runner-added.json) + pool.txt ada di MAIN;
// semua add lewat SATU perintah di MAIN di bawah flock (scripts/remote-add-pool.js di repo
// meteorabot-v3). MAIN_VPS_HOST kosong = app berjalan di MAIN → perintah dijalankan lokal.
// Ledger lokal hanya CACHE (hemat ssh), bukan sumber kebenaran.
// File ini identik dengan meteora-pool-monitor/src/main-ledger.js — ubah keduanya bersamaan.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export function mainConfig(env = process.env, { cachePath = "" } = {}) {
  const host = (env.MAIN_VPS_HOST || "").trim();
  const poolPath = (env.MAIN_POOL_PATH || "~/meteorabot-v3/pool.txt").trim();
  const dir = path.posix.dirname(poolPath);
  const ledgerPath = (env.MAIN_ADDED_PATH || "").trim() || `${dir}/runner-added.json`;
  return {
    host: host || null,
    key: expandHome((env.MAIN_VPS_SSH_KEY || "~/.ssh/id_ed25519").trim()),
    poolPath,
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
    repoDir: (env.MAIN_REPO_DIR || "").trim() || dir,
    statePath: (env.MAIN_STATE_PATH || "").trim(),
    nodeBin: (env.MAIN_NODE_BIN || "node").trim(),
    lockWaitSec: Number(env.MAIN_LOCK_WAIT_SEC) > 0 ? Number(env.MAIN_LOCK_WAIT_SEC) : 60,
    cachePath: (env.ADDED_CACHE_PATH || "").trim() || cachePath,
  };
}

function expandHome(p) {
  return p.replace(/^~(?=\/)/, os.homedir());
}

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Path '~/x' diekspansi oleh shell di host target (bukan host pemanggil).
export const rp = (p) => (String(p).startsWith("~/") ? `"$HOME"/${q(String(p).slice(2))}` : q(p));

export function buildAddCommand(cfg, { mint, pool, pools = [], line, by }) {
  const args = [
    "--pool-file", rp(cfg.poolPath),
    "--ledger", rp(cfg.ledgerPath),
    ...(cfg.statePath ? ["--state", rp(cfg.statePath)] : []),
    "--mint", q(mint),
    "--pool", q(pool),
    "--pools", q([...new Set([pool, ...pools].filter(Boolean))].join(",")),
    "--line", q(line),
    "--by", q(by || ""),
  ];
  return `cd ${rp(cfg.repoDir)} && flock -w ${cfg.lockWaitSec} ${rp(cfg.lockPath)} ${q(cfg.nodeBin)} scripts/remote-add-pool.js ${args.join(" ")}`;
}

export function runOnMain(cfg, cmd, exec = execFileSync) {
  const opts = { encoding: "utf8", timeout: (cfg.lockWaitSec + 30) * 1000 };
  if (cfg.host) {
    return String(exec("ssh", ["-i", cfg.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", cfg.host, cmd], opts));
  }
  return String(exec("sh", ["-c", cmd], opts));
}

export function parseResult(out) {
  const line = String(out).split("\n").reverse().find((l) => l.startsWith("RESULT "));
  if (!line) return { status: "error", error: `output tidak dikenali: ${String(out).trim().slice(0, 160)}` };
  try {
    return JSON.parse(line.slice(7));
  } catch {
    return { status: "error", error: "RESULT bukan JSON" };
  }
}

// --- cache lokal (opsional) ---
export function readCache(file) {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(file, mint, entry) {
  if (!file || !mint) return;
  try {
    const c = readCache(file);
    c[mint] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

export const isCached = (cfg, mint) => Boolean(mint && readCache(cfg.cachePath)[mint]);

// status: added | already_added | already_in_pool | already_open | error
export function addViaMain(cfg, { mint, pool, pools = [], line, by }, exec = execFileSync) {
  if (isCached(cfg, mint)) return { status: "already_added", cached: true };
  let res;
  try {
    res = parseResult(runOnMain(cfg, buildAddCommand(cfg, { mint, pool, pools, line, by }), exec));
  } catch (err) {
    const out = err?.stdout ? parseResult(err.stdout) : null;
    res = out && out.status !== "error" ? out : { status: "error", error: String(out?.error || err.message || err).split("\n")[0].slice(0, 200) };
  }
  if (["added", "already_added", "already_in_pool"].includes(res.status)) {
    writeCache(cfg.cachePath, mint, { status: res.status, at: new Date().toISOString() });
  }
  return res;
}
