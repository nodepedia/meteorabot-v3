import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Agent, buildConnector } from "undici";
import config from "../config/index.js";
import { ROOT } from "../core/paths.js";
import gmgnLimiter from "./gmgn-limiter.js";

const execFileAsync = promisify(execFile);

const LOCAL_CLI = path.join(ROOT, "node_modules", "gmgn-cli", "dist", "index.js");
const GMGN_HOST = (process.env.GMGN_HOST || "https://openapi.gmgn.ai").replace(/\/$/, "");
const USER_AGENT = "gmgn-cli/1.1.7";

let ipv4Dispatcher = null;
function getIpv4Dispatcher() {
  if (!ipv4Dispatcher) {
    try {
      const connector = buildConnector({ family: 4 });
      ipv4Dispatcher = new Agent({ connect: connector });
    } catch {
      ipv4Dispatcher = null;
    }
  }
  return ipv4Dispatcher;
}

function parseResetAt(text) {
  const m = /resets at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(1000, t - Date.now() + 2000);
}

function parseHeaderResetMs(headerVal) {
  if (headerVal == null || String(headerVal).trim() === "") return null;
  const resetUnix = Number.parseInt(String(headerVal).trim(), 10);
  if (!Number.isFinite(resetUnix) || resetUnix <= 0) return null;
  // Jika nilai berupa timestamp Unix detik (> 1e9), hitung selisih ke Date.now()
  if (resetUnix > 1_000_000_000) {
    return Math.max(1000, resetUnix * 1000 - Date.now() + 2000);
  }
  // Jika nilai berupa durasi detik relatif
  return Math.max(1000, resetUnix * 1000 + 2000);
}

function firstLine(text) {
  return (
    String(text || "")
      .split("\n")
      .find((l) => l.trim()) || ""
  );
}

function invocation(args) {
  if (fs.existsSync(LOCAL_CLI)) return { cmd: process.execPath, argv: [LOCAL_CLI, ...args] };
  return { cmd: "npx", argv: ["-y", "gmgn-cli@latest", ...args] };
}

async function runGmgnCli(args, { timeoutMs = 30000 } = {}) {
  const { cmd, argv } = invocation(args);
  try {
    const { stdout } = await execFileAsync(cmd, argv, {
      env: { ...process.env, GMGN_API_KEY: config.gmgnApiKey },
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const text = `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || ""}`;
    const wrapped = new Error(firstLine(text) || err.message);
    wrapped.rateLimited = /RATE_LIMIT|HTTP 429|\b429\b|too many requests/i.test(text);
    wrapped.resetAtMs = wrapped.rateLimited ? parseResetAt(text) : null;
    wrapped.raw = text;
    throw wrapped;
  }
}

// Panggil endpoint /v1/market/token_kline secara langsung melalui HTTP (Central Collector)
// tanpa spawn sub-proses gmgn-cli dan tanpa auto-retry liar yang memicu penalti ban.
export async function fetchGmgnKlineDirect(
  mint,
  { resolution = "15m", from, to, timeoutMs = 20000, fetchFn = globalThis.fetch, apiKey } = {}
) {
  const key = apiKey != null ? apiKey : config.gmgnApiKey;
  if (!key) {
    throw new Error("GMGN_API_KEY kosong — tidak dapat memanggil /v1/market/token_kline");
  }

  const params = new URLSearchParams({
    chain: "sol",
    address: String(mint),
    resolution: String(resolution),
  });
  if (from != null) {
    const fromMs = Number(from) < 1e11 ? Number(from) * 1000 : Number(from);
    params.set("from", String(Math.floor(fromMs)));
  }
  if (to != null) {
    const toMs = Number(to) < 1e11 ? Number(to) * 1000 : Number(to);
    params.set("to", String(Math.floor(toMs)));
  }
  params.set("timestamp", String(Math.floor(Date.now() / 1000)));
  params.set("client_id", crypto.randomUUID());

  const url = `${GMGN_HOST}/v1/market/token_kline?${params.toString()}`;
  const headers = {
    "X-APIKEY": key,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const fetchOpts = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  const dispatcher = fetchFn === globalThis.fetch ? getIpv4Dispatcher() : null;
  if (dispatcher) fetchOpts.dispatcher = dispatcher;

  const res = await fetchFn(url, fetchOpts);
  const headerResetMs = parseHeaderResetMs(res.headers?.get?.("x-ratelimit-reset"));
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`GET /v1/market/token_kline failed: HTTP ${res.status} (non-JSON response)`);
    err.rateLimited = res.status === 429;
    err.resetAtMs = err.rateLimited ? headerResetMs ?? 30000 : null;
    throw err;
  }

  if (!res.ok || json?.code !== 0) {
    const errText = `${json?.error || ""} ${json?.message || ""}`.trim();
    const isRateLimited =
      res.status === 429 || /RATE_LIMIT|too many requests|rate limit/i.test(errText);
    const msg = `GET /v1/market/token_kline failed: HTTP ${res.status}${
      json?.error ? ` error=${json.error}` : ""
    }${json?.message ? ` message=${json.message}` : ""}`;
    const err = new Error(msg);
    err.rateLimited = isRateLimited;
    err.resetAtMs = isRateLimited ? headerResetMs ?? parseResetAt(errText) ?? 30000 : null;
    throw err;
  }

  return json?.data || { list: [] };
}

function parseResolutionSeconds(res) {
  const map = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  return map[res] || 900;
}

// Panggil GMGN lewat limiter bersama (semua jalur GMGN wajib lewat sini).
export async function gmgnRequest(
  key,
  args,
  { timeoutMs = 20000, priority = "normal", limiter = gmgnLimiter, runCli = runGmgnCli } = {}
) {
  try {
    return await limiter.schedule(key, () => runCli(args, { timeoutMs }), { priority });
  } catch (err) {
    if (err.rateLimited) {
      const waitMs = err.resetAtMs ?? 30000;
      limiter.blockFor(waitMs);
    }
    throw err;
  }
}

function normalizeKlineList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => ({
      time: Math.floor(Number(c.time) / 1000),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
}

// Ambil kline GMGN untuk satu mint (native 15m). Rate-limit aware.
// Jika GMGN_CENTRAL_COLLECTOR=true (default), gunakan HTTP langsung berprioritas.
// Jika GMGN_CENTRAL_COLLECTOR=false (rollback), gunakan gmgn-cli seperti versi lama.
export async function fetchGmgnKline(
  mint,
  { resolution = "15m", limit = 90, priority = "normal", deps = {} } = {}
) {
  if (!mint) throw new Error("fetchGmgnKline: mint kosong");
  const resSec = parseResolutionSeconds(resolution);
  const now = Math.floor(Date.now() / 1000);
  const from = now - limit * resSec;
  const useCentral =
    deps.centralCollector != null ? Boolean(deps.centralCollector) : Boolean(config.gmgnCentralCollector);
  const limiter = deps.limiter || gmgnLimiter;

  if (useCentral) {
    let data;
    try {
      data = await limiter.schedule(
        `kline:${mint}:${resolution}`,
        () =>
          fetchGmgnKlineDirect(mint, {
            resolution,
            from,
            to: now,
            timeoutMs: 25000,
            fetchFn: deps.fetchFn,
            apiKey: deps.apiKey,
          }),
        { priority }
      );
    } catch (err) {
      if (err.rateLimited) {
        const waitMs = err.resetAtMs ?? 30000;
        limiter.blockFor(waitMs);
      }
      throw err;
    }
    const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
    return normalizeKlineList(list);
  }

  const args = [
    "market",
    "kline",
    "--chain",
    "sol",
    "--address",
    mint,
    "--resolution",
    resolution,
    "--from",
    String(from),
    "--to",
    String(now),
    "--raw",
  ];

  const stdout = await gmgnRequest(`kline:${mint}:${resolution}`, args, {
    timeoutMs: 30000,
    priority,
    limiter,
    runCli: deps.runCli,
  });
  const parsed = JSON.parse(stdout);
  return normalizeKlineList(parsed?.list || []);
}

export { runGmgnCli };
