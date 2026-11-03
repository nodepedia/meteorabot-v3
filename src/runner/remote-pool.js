// Tambah baris CA ke pool.txt (lokal atau di VPS main lewat ssh) — sekali per token.
// File ini identik dengan meteora-pool-monitor/src/remote-pool.js — ubah keduanya bersamaan.
//
// Satu perintah POSIX sh di bawah `flock` pada pool.txt:
//   - kalau CA, atau salah satu pool address milik token itu, sudah ada di baris mana pun
//     (termasuk yang di-'#') → skip "already_in_pool"
//   - kalau belum → append `<CA>,<mult>,1,spot,ca`
// Tidak ada ledger: kalau baris CA dihapus total, token boleh ditambahkan lagi.
import { execFileSync } from "child_process";
import os from "os";

export function remoteConfig(env = process.env) {
  const host = (env.MAIN_VPS_HOST || "").trim();
  if (!host) return null;
  const home = os.homedir();
  const exp = (p) => p.replace(/^~(?=\/)/, home);
  return {
    host,
    key: exp((env.MAIN_VPS_SSH_KEY || "~/.ssh/id_ed25519").trim()),
    poolPath: (env.MAIN_POOL_PATH || "~/meteorabot-v3/pool.txt").trim(),
  };
}

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const rp = (p) => (p.startsWith("~/") ? `"$HOME"/${q(p.slice(2))}` : q(p));
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function caLine(mint, multiplierStr) {
  return `${mint},${multiplierStr || "1x"},1,spot,ca`;
}

// Script sh: cek + append di bawah flock pada pool.txt. Output baris pertama: added | already_in_pool <addr> | lock_timeout.
export function buildAddCaScript(poolPath, { mint, multiplierStr, knownPools = [] }) {
  if (!ADDR.test(String(mint || ""))) throw new Error(`CA invalid: ${mint}`);
  const keys = [...new Set([mint, ...knownPools.filter((p) => ADDR.test(String(p || "")))])];
  return [
    `f=${rp(poolPath)}`,
    `mkdir -p "$(dirname "$f")" && touch "$f" || exit 2`,
    `exec 9>>"$f"`,
    `flock -w 30 9 || { echo lock_timeout; exit 3; }`,
    `for a in ${keys.map(q).join(" ")}; do`,
    `  if grep -qF -- "$a" "$f"; then echo "already_in_pool $a"; exit 0; fi`,
    `done`,
    `if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then printf '\\n' >> "$f"; fi`,
    `printf '%s\\n' ${q(caLine(mint, multiplierStr))} >> "$f"`,
    `echo added`,
  ].join("\n");
}

export function parseAddCaOutput(out, targetLine) {
  const first = String(out || "").trim().split("\n")[0] || "";
  if (first === "added") return { changed: true, action: "added", targetLine };
  if (first.startsWith("already_in_pool")) return { changed: false, action: "already_in_pool", match: first.split(" ")[1] || "", targetLine };
  return { changed: false, action: "failed", error: first || "no output", targetLine };
}

// cfg = remoteConfig(...) untuk ssh ke VPS main, atau { localPath } untuk pool.txt lokal.
export function addCaLine(cfg, { mint, multiplierStr, knownPools = [] }, exec = execFileSync) {
  const targetLine = caLine(mint, multiplierStr);
  try {
    const script = buildAddCaScript(cfg.localPath || cfg.poolPath, { mint, multiplierStr, knownPools });
    const out = cfg.localPath
      ? exec("sh", ["-c", script], { encoding: "utf8" })
      : exec("ssh", ["-i", cfg.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", cfg.host, script], { encoding: "utf8" });
    return parseAddCaOutput(out, targetLine);
  } catch (err) {
    return { changed: false, action: "failed", error: err.message, targetLine };
  }
}
