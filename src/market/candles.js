import fs from "fs";
import path from "path";
import log from "../core/logger.js";
import config from "../config/index.js";
import { ROOT } from "../core/paths.js";
import { makeLimiter } from "../core/rate-limiter.js";
import { clamp } from "../core/utils.js";
import { fetchGmgnKline } from "./gmgn-client.js";

const METEORA_BASE = "https://dlmm.datapi.meteora.ag";

// Meteora menolak rentang < ~6900 dtk (balas kosong) dan rentang yang
// menghasilkan > ~96 candle ("time range too large"). Jaga di antara keduanya.
const METEORA_MIN_RANGE_SEC = 6900;
const METEORA_MAX_CANDLES_PER_REQ = 90;
const METEORA_MAX_RANGE_SEC = 2_000_000;

const METEORA_MAP = {
  "1m": { res: "5m", mul: null },
  "5m": { res: "5m", mul: 1 },
  "15m": { res: "5m", mul: 3 },
  "1h": { res: "1h", mul: 1 },
  "4h": { res: "4h", mul: 1 },
  "1d": { res: "24h", mul: 1 },
};

const CANDLE_15M_SEC = 900;
const DISK_CACHE_SCHEMA = 1;
const DISK_CACHE_MAX_AGE_MS = 2 * 3600 * 1000;

const candleCache = new Map(); // key -> { at, candles } (TF native)
const gmgn15mCache = new Map(); // mint -> { at, barStart, candles }
const gmgn15mInflight = new Map(); // mint -> Promise

function klineCacheFile() {
  if (process.env.GMGN_KLINE_CACHE_FILE && process.env.GMGN_KLINE_CACHE_FILE.trim()) {
    return path.resolve(process.env.GMGN_KLINE_CACHE_FILE.trim());
  }
  return path.resolve(ROOT, config.gmgnKlineCacheFile || "gmgn-kline-cache.json");
}

function readDiskKlineAll() {
  if (!config.gmgnCentralCollector) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(klineCacheFile(), "utf8"));
    if (raw?.schema !== DISK_CACHE_SCHEMA || !raw?.mints || typeof raw.mints !== "object") return {};
    return raw.mints;
  } catch {
    return {};
  }
}

function readDiskKlineEntry(mint) {
  if (!mint || !config.gmgnCentralCollector) return null;
  const mints = readDiskKlineAll();
  const entry = mints[mint];
  if (!entry || !Array.isArray(entry.candles) || !Number.isFinite(entry.barStart)) return null;
  return entry;
}

function writeDiskKlineEntry(mint, entry) {
  if (!mint || !entry || !config.gmgnCentralCollector) return;
  const file = klineCacheFile();
  const now = Date.now();
  const current = readDiskKlineAll();
  const nextMints = {};
  for (const [k, v] of Object.entries(current)) {
    if (v && Array.isArray(v.candles) && now - (Number(v.at) || 0) <= DISK_CACHE_MAX_AGE_MS) {
      nextMints[k] = v;
    }
  }
  nextMints[mint] = entry;
  const payload = JSON.stringify({
    schema: DISK_CACHE_SCHEMA,
    updatedAt: now,
    mints: nextMints,
  });
  const tmpFile = `${file}.${process.pid}.${now}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmpFile, payload);
    fs.renameSync(tmpFile, file);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.writeFileSync(file, payload);
    } catch {}
  }
}

export function clearGmgn15mCache({ includeDisk = true } = {}) {
  gmgn15mCache.clear();
  gmgn15mInflight.clear();
  if (includeDisk) {
    try {
      const file = klineCacheFile();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

function cacheKey(mint, pool, resolution) {
  return `${pool || mint || "?"}:${resolution}`;
}

function getCached(key, ttlSec) {
  const hit = candleCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlSec * 1000) {
    candleCache.delete(key);
    return null;
  }
  return hit.candles;
}

function setCached(key, candles) {
  candleCache.set(key, { at: Date.now(), candles });
}

const meteoraLimiter = makeLimiter(Math.max(1, Number(config.meteoraMaxPerMin) || 0));

function current15mBarStart(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / CANDLE_15M_SEC) * CANDLE_15M_SEC;
}

function dedupeSort(candles) {
  const seen = new Set();
  const unique = [];
  for (const c of candles.slice().sort((a, b) => a.time - b.time)) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    unique.push(c);
  }
  return unique;
}

// Bar tertutup terakhir yang seharusnya sudah tersedia pada data 15m.
function latestClosed15mBarStart(nowMs = Date.now()) {
  return current15mBarStart(nowMs) - CANDLE_15M_SEC;
}

function isFresh15mHit(hit, nowMs = Date.now()) {
  if (!hit || !Array.isArray(hit.candles) || hit.candles.length === 0) return false;
  if (hit.barStart !== current15mBarStart(nowMs)) return false;
  const last = hit.candles[hit.candles.length - 1];
  if (!last) return false;
  const lastBar = Math.floor(last.time / CANDLE_15M_SEC) * CANDLE_15M_SEC;
  if (lastBar < latestClosed15mBarStart(nowMs)) return false;
  return true;
}

// Cache 15m GMGN valid untuk seluruh bar berjalan; ganti saat bar berikutnya.
// Cache juga harus benar-benar memuat bar yang baru tutup, supaya data yang
// belum lengkap (mis. GMGN telat) tidak dianggap final.
// Jika Central Data Collector aktif, cek memori dulu lalu shared disk cache
// agar worker entry & exit berbagi hasil fetch yang sama (0 duplikat request).
export function getFreshGmgn15m(mint, nowMs = Date.now()) {
  const memHit = gmgn15mCache.get(mint);
  if (isFresh15mHit(memHit, nowMs)) return memHit;

  const diskHit = readDiskKlineEntry(mint);
  if (diskHit) {
    if (!memHit || (Number(diskHit.at) || 0) >= (Number(memHit.at) || 0)) {
      gmgn15mCache.set(mint, diskHit);
    }
    if (isFresh15mHit(diskHit, nowMs)) return diskHit;
  }

  return null;
}

function getStaleGmgn15m(mint) {
  const memHit = gmgn15mCache.get(mint);
  const diskHit = readDiskKlineEntry(mint);
  if (diskHit && (!memHit || (Number(diskHit.at) || 0) > (Number(memHit.at) || 0))) {
    gmgn15mCache.set(mint, diskHit);
    return diskHit;
  }
  return memHit || null;
}

// Ambil ulang kline 15m dari GMGN (native), lalu simpan ke cache bar-aligned (memori + disk).
async function refreshGmgn15m(mint, { limit = 90, priority = "normal", nowMs, deps = {} } = {}) {
  if (gmgn15mInflight.has(mint)) return gmgn15mInflight.get(mint);
  const fetchKlineFn = deps.fetchGmgnKline || fetchGmgnKline;
  const p = (async () => {
    try {
      const precheck = getFreshGmgn15m(mint, nowMs);
      if (precheck) return precheck.candles;

      const list = await fetchKlineFn(mint, { resolution: "15m", limit, priority });
      if (!list || list.length < 2) return null;
      const candles = dedupeSort(list);
      const now = nowMs ?? Date.now();
      const barStart = current15mBarStart(now);
      const entry = { at: now, barStart, candles };
      gmgn15mCache.set(mint, entry);
      writeDiskKlineEntry(mint, entry);
      log.debug(
        `[detail] GMGN 15m ${mint.slice(0, 8)}: ${candles.length} candle (bar ${new Date(barStart * 1000)
          .toISOString()
          .slice(11, 16)}, prio=${priority})`
      );
      return candles;
    } finally {
      gmgn15mInflight.delete(mint);
    }
  })();
  gmgn15mInflight.set(mint, p);
  return p;
}

export async function fetchVolume(mint, pool, { resolution, limit = 5 } = {}) {
  const res = resolution || config.volumeTimeframe || "5m";
  const candles = await fetchCandles(mint, pool, { resolution: res, limit });
  if (!candles || candles.length < 1) return { vol: 0, volPrev: 0, vol5mEffective: 0, volAvg5: 0 };

  const volumes = candles.map((c) => Number(c.volume) || 0);
  const vol = volumes[volumes.length - 1] ?? 0;
  const volPrev = volumes.length >= 2 ? volumes[volumes.length - 2] ?? 0 : 0;
  const vol5mEffective = Math.max(vol, volPrev);
  const volAvg5 =
    volumes.length >= 5
      ? volumes.slice(-5).reduce((a, b) => a + b, 0) / 5
      : volumes.reduce((a, b) => a + b, 0) / volumes.length;

  return { vol, volPrev, vol5mEffective, volAvg5 };
}

// Routing sumber data:
// - 15m (tidak native di Meteora) -> GMGN native, cache bar-aligned per mint (shared lintas worker).
// - TF native (5m/1h/4h/24h)      -> Meteora (fallback GMGN bila kurang).
export async function fetchCandles(
  mint,
  pool,
  { resolution, limit = 100, allowStale = true, priority = "normal", nowMs, deps = {} } = {}
) {
  const res = resolution || config.timeframe || "15m";
  if (!mint && !pool) {
    log.warn("fetchCandles: no mint/pool");
    return null;
  }

  if (res === "15m" && config.candle15mSource === "gmgn" && mint) {
    return fetchCandlesGmgn15m(mint, pool, { limit, allowStale, priority, nowMs, deps });
  }

  const key = cacheKey(mint, pool, res);
  const cached = getCached(key, config.candleCacheTtlSec);
  if (cached && cached.length >= Math.min(limit, 3)) {
    return cached.slice(-limit);
  }

  let candles = null;

  if (pool) {
    candles = await fetchCandlesMeteora(pool, { resolution: res, limit });
  }

  // GMGN hanya dipanggil kalau Meteora tidak memberi cukup data.
  const minNeeded = Math.min(15, Math.max(2, limit));
  if ((!candles || candles.length < minNeeded) && mint) {
    const gmgn = await fetchCandlesGMGN(mint, { resolution: res, limit, priority, deps });
    if (gmgn && (!candles || gmgn.length > candles.length)) candles = gmgn;
  }

  if (candles && candles.length) {
    setCached(key, candles);
    return candles.slice(-limit);
  }
  return candles;
}

// Khusus 15m GMGN: pakai cache bar berjalan (memori / shared disk); saat bar
// berganti, tahan request sampai candleCloseDelaySec lalu refresh (blocking) agar
// candle yang baru tutup langsung final. Cache benar-benar kosong juga blocking.
export async function fetchCandlesGmgn15m(
  mint,
  pool,
  { limit = 100, allowStale = true, priority = "normal", nowMs, deps = {} } = {}
) {
  const now = nowMs ?? Date.now();
  const fresh = getFreshGmgn15m(mint, now);
  if (fresh) return fresh.candles.slice(-limit);

  const stale = getStaleGmgn15m(mint);

  // Bar sudah berganti tetapi bar baru belum tentu terbentuk/final. Selama
  // candleCloseDelaySec setelah pergantian bar, tahan request dan sajikan
  // cache lama.
  // - allowStale=true  : sajikan cache lama (perilaku lama).
  // - allowStale=false : kembalikan null agar pemanggil (mis. Supertrend)
  //   mencoba lagi pada tick berikutnya, bukan menghitung dari data stale.
  const sinceBarStart = now / 1000 - current15mBarStart(now);
  if (sinceBarStart < config.candleCloseDelaySec) {
    return allowStale && stale ? stale.candles.slice(-limit) : null;
  }

  try {
    const candles = await refreshGmgn15m(mint, {
      limit: Math.max(limit, 90),
      priority,
      nowMs: now,
      deps,
    });
    if (candles) return candles.slice(-limit);
    return allowStale && stale ? stale.candles.slice(-limit) : null;
  } catch (err) {
    log.warn(`GMGN 15m ${mint.slice(0, 8)}: ${err.message}`);
    if (config.gmgnFallbackToMeteora && pool) {
      log.warn(`GMGN 15m gagal — fallback Meteora (degradasi) untuk ${pool.slice(0, 8)}`);
      return fetchCandlesMeteora(pool, { resolution: "15m", limit });
    }
    return allowStale && stale ? stale.candles.slice(-limit) : null;
  }
}

async function fetchCandlesMeteora(pool, { resolution, limit = 100 } = {}) {
  const res = resolution || config.timeframe || "15m";
  const meta = METEORA_MAP[res];

  if (!meta || !meta.mul) {
    log.warn(`Meteora: resolusi ${res} tidak didukung`);
    return null;
  }

  const baseSecs = parseResolutionSeconds(meta.res);
  const groupSize = meta.mul;
  const wantRaw = Math.max(limit * groupSize, groupSize * 2);
  const maxPages = Math.min(4, Math.max(1, Math.ceil(wantRaw / METEORA_MAX_CANDLES_PER_REQ)));

  const collected = [];
  let cursor = Math.floor(Date.now() / 1000);

  for (let page = 0; page < maxPages; page++) {
    if (!meteoraLimiter.tryAcquire()) {
      log.warn("Meteora: batas lokal per menit tercapai — skip");
      break;
    }

    const range = clamp(METEORA_MAX_CANDLES_PER_REQ * baseSecs, METEORA_MIN_RANGE_SEC, METEORA_MAX_RANGE_SEC);
    const start = cursor - range;
    const url = `${METEORA_BASE}/pools/${pool}/ohlcv?timeframe=${meta.res}&start_time=${start}&end_time=${cursor}`;

    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) {
        log.warn(`Meteora OHLCV ${pool.slice(0, 8)}: ${r.status}`);
        break;
      }
      const json = await r.json();
      const raw = Array.isArray(json?.data) ? json.data : [];
      if (raw.length === 0) break;

      const mapped = raw.map((c) => ({
        time: Number(c.timestamp),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      }));
      collected.unshift(...mapped);

      const earliest = mapped[0]?.time;
      if (!Number.isFinite(earliest)) break;
      cursor = earliest - 1;
      if (collected.length >= wantRaw) break;
    } catch (err) {
      log.warn(`Meteora OHLCV gagal untuk ${pool.slice(0, 8)}: ${err.message}`);
      break;
    }
  }

  if (collected.length === 0) {
    log.warn(`Meteora: data kosong untuk pool ${pool.slice(0, 8)}`);
    return null;
  }

  const unique = dedupeSort(collected);
  const candles = groupSize > 1 ? aggregateCandles(unique, groupSize, baseSecs) : unique;

  log.debug(`[detail] Meteora: ${candles.length} candle untuk pool ${pool.slice(0, 8)}`);
  return candles;
}

async function fetchCandlesGMGN(mint, { resolution, limit = 100, priority = "normal", deps = {} } = {}) {
  const res = resolution || config.timeframe || "15m";
  const minNeeded = Math.min(30, Math.max(2, limit));
  const fetchKlineFn = deps.fetchGmgnKline || fetchGmgnKline;

  try {
    const candles = await fetchKlineFn(mint, { resolution: res, limit, priority });
    if (!candles || candles.length === 0) {
      log.warn(`GMGN: data kosong untuk ${mint.slice(0, 8)}`);
      return null;
    }
    if (candles.length < minNeeded) {
      log.warn(`GMGN: ${candles.length} candle (<${minNeeded}) untuk ${mint.slice(0, 8)} — ditolak`);
      return null;
    }
    return candles;
  } catch (err) {
    log.warn(`GMGN gagal untuk ${mint.slice(0, 8)}: ${String(err?.message || err).split("\n")[0]}`);
    return null;
  }
}

function aggregateCandles(candles, groupSize, candleSecs) {
  if (groupSize <= 1) return candles;

  const bucketSecs = groupSize * candleSecs;
  const buckets = new Map();

  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketSecs) * bucketSecs;
    const b = buckets.get(bucket);
    if (!b) {
      buckets.set(bucket, {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }

  return [...buckets.keys()].sort((a, b) => a - b).map((t) => buckets.get(t));
}

function parseResolutionSeconds(res) {
  const map = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "24h": 86400,
  };
  return map[res] || 900;
}
