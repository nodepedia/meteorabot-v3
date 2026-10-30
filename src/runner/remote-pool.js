// Remote mode: tulis baris pool ke pool.txt di VPS main lewat ssh.
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
    poolPath: (env.MAIN_POOL_PATH || "~/grokbot/meteorabot-v3/pool.txt").trim(),
    statePath: (env.MAIN_STATE_PATH || "").trim(),
  };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const rp = (p) => (p.startsWith("~/") ? `"$HOME"/${q(p.slice(2))}` : q(p));

export function sshRun(cfg, cmd, exec = execFileSync) {
  return String(exec("ssh", ["-i", cfg.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", cfg.host, cmd], { encoding: "utf8" }));
}

export function remoteUpdatePool(cfg, { poolAddress, multiplierStr, allTokenPoolAddresses = [], mint = "" }, exec = execFileSync) {
  const pools = new Set([poolAddress, ...allTokenPoolAddresses.filter(Boolean)]);
  const targetLine = `${poolAddress},${multiplierStr},1,spot`;
  const raw = sshRun(cfg, `cat ${rp(cfg.poolPath)} 2>/dev/null || true`, exec);
  for (const l of raw.split("\n")) {
    const a = l.trim().split(",")[0]?.trim();
    if (a && !l.trim().startsWith("#") && pools.has(a)) return { changed: false, action: "unchanged_remote", targetLine };
  }
  if (cfg.statePath) {
    try {
      const st = JSON.parse(sshRun(cfg, `cat ${rp(cfg.statePath)}`, exec) || "{}");
      for (const p of Object.values(st.positions || {})) {
        if (p && !p.closed && ((mint && p.baseMint === mint) || pools.has(p.pool)))
          return { changed: false, action: "skipped_token_already_open", targetLine };
      }
    } catch {}
  }
  sshRun(cfg, `printf '%s\\n' ${q(targetLine)} >> ${rp(cfg.poolPath)}`, exec);
  return { changed: true, action: "added_remote", targetLine };
}
