import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import config from "../src/config/index.js";
import { createGmgnLimiter } from "../src/market/gmgn-limiter.js";
import { fetchGmgnKline, fetchGmgnKlineDirect } from "../src/market/gmgn-client.js";
import { fetchCandlesGmgn15m, clearGmgn15mCache, getFreshGmgn15m } from "../src/market/candles.js";

const BAR_SEC = 900;

function sampleCandles(barStart, count = 30) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = barStart - (count - 1 - i) * BAR_SEC;
    out.push({
      time: t,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 100 + i,
    });
  }
  return out;
}

test("fetchGmgnKlineDirect calls /v1/market/token_kline with X-APIKEY and parses candles", async () => {
  let capturedUrl = null;
  let capturedOpts = null;
  const mockFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return {
      ok: true,
      status: 200,
      headers: new Map([["x-ratelimit-remaining", "2"]]),
      text: async () =>
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            list: [
              { time: 1700000000000, open: "1.1", high: "1.5", low: "1.0", close: "1.3", volume: "500" },
              { time: 1700000900000, open: "1.3", high: "1.6", low: "1.2", close: "1.4", volume: "600" },
            ],
          },
        }),
    };
  };

  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 0 });
  const list = await fetchGmgnKline("So11111111111111111111111111111111111111112", {
    resolution: "15m",
    limit: 10,
    priority: "exit",
    deps: {
      centralCollector: true,
      limiter,
      fetchFn: mockFetch,
      apiKey: "test-gmgn-key",
    },
  });

  assert.ok(capturedUrl.includes("/v1/market/token_kline?"));
  assert.ok(capturedUrl.includes("chain=sol"));
  assert.ok(capturedUrl.includes("resolution=15m"));
  assert.ok(capturedUrl.includes("timestamp="));
  const parsedUrl = new URL(capturedUrl);
  assert.ok(Number(parsedUrl.searchParams.get("from")) >= 1e12, "from must be in ms");
  assert.ok(Number(parsedUrl.searchParams.get("to")) >= 1e12, "to must be in ms");
  assert.ok(capturedUrl.includes("client_id="));
  assert.equal(capturedOpts.headers["X-APIKEY"], "test-gmgn-key");
  assert.equal(list.length, 2);
  assert.equal(list[0].time, 1700000000);
  assert.equal(list[1].close, 1.4);
});

test("fetchGmgnKlineDirect parses x-ratelimit-reset header on HTTP 429 and blocks limiter", async () => {
  const resetUnix = Math.floor(Date.now() / 1000) + 25;
  const mockFetch = async () => ({
    ok: false,
    status: 429,
    headers: {
      get: (k) => (k.toLowerCase() === "x-ratelimit-reset" ? String(resetUnix) : null),
    },
    text: async () =>
      JSON.stringify({
        code: 429,
        error: "RATE_LIMIT_EXCEEDED",
        message: "IP rate limit exceeded",
      }),
  });

  const limiter = createGmgnLimiter({ maxPerMin: 40, minGapMs: 0 });
  await assert.rejects(
    () =>
      fetchGmgnKline("Mint429111111111111111111111111111111111111", {
        resolution: "15m",
        limit: 10,
        deps: {
          centralCollector: true,
          limiter,
          fetchFn: mockFetch,
          apiKey: "test-key",
        },
      }),
    (err) => {
      assert.equal(err.rateLimited, true);
      assert.ok(err.resetAtMs >= 20000 && err.resetAtMs <= 30000, `resetAtMs=${err.resetAtMs}`);
      return true;
    }
  );
  assert.equal(limiter.isBlocked(), true);
  assert.equal(limiter.stats().cap, 20);
});

test("rollback switch GMGN_CENTRAL_COLLECTOR=false falls back to runGmgnCli", async () => {
  let cliCalled = false;
  let capturedArgs = null;
  const mockRunCli = async (args) => {
    cliCalled = true;
    capturedArgs = args;
    return JSON.stringify({
      list: [{ time: 1700000000000, open: 2, high: 3, low: 1, close: 2.5, volume: 10 }],
    });
  };

  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 0 });
  const res = await fetchGmgnKline("MintRollback1111111111111111111111111111111", {
    resolution: "15m",
    limit: 5,
    deps: {
      centralCollector: false,
      limiter,
      runCli: mockRunCli,
    },
  });

  assert.equal(cliCalled, true);
  assert.deepEqual(capturedArgs.slice(0, 2), ["market", "kline"]);
  assert.equal(res.length, 1);
  assert.equal(res[0].close, 2.5);
});

test("shared disk kline cache allows exit worker to reuse entry worker 15m candles with 0 extra API calls", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmgn-kline-cache-"));
  const cacheFile = path.join(tmpDir, "gmgn-kline-cache.json");
  const prevEnv = process.env.GMGN_KLINE_CACHE_FILE;
  const prevCentral = config.gmgnCentralCollector;
  process.env.GMGN_KLINE_CACHE_FILE = cacheFile;
  config.gmgnCentralCollector = true;

  try {
    clearGmgn15mCache({ includeDisk: true });
    const mint = "SharedMint111111111111111111111111111111111";
    const barStart = Math.floor(Date.now() / 1000 / BAR_SEC) * BAR_SEC;
    const nowMs = (barStart + 10) * 1000; // 10s after bar start (> candleCloseDelaySec)
    let apiCalls = 0;
    const seenPriorities = [];

    const deps = {
      fetchGmgnKline: async (_m, opts) => {
        apiCalls++;
        seenPriorities.push(opts.priority);
        return sampleCandles(barStart, 25);
      },
    };

    // 1. Worker Entry fetches 15m candles -> writes to disk cache
    const entryCandles = await fetchCandlesGmgn15m(mint, null, {
      limit: 25,
      allowStale: false,
      priority: "entry",
      nowMs,
      deps,
    });
    assert.equal(entryCandles.length, 25);
    assert.equal(apiCalls, 1);
    assert.deepEqual(seenPriorities, ["entry"]);
    assert.equal(fs.existsSync(cacheFile), true);

    // 2. Simulate Worker Exit (clear in-memory cache ONLY, keep disk cache)
    clearGmgn15mCache({ includeDisk: false });

    // Worker Exit requests 15m candles -> hits shared disk cache with 0 API calls!
    const exitCandles = await fetchCandlesGmgn15m(mint, "Pool111111", {
      limit: 25,
      allowStale: true,
      priority: "exit",
      nowMs: nowMs + 1000,
      deps,
    });
    assert.equal(exitCandles.length, 25);
    assert.equal(apiCalls, 1, "Exit worker should not make a duplicate API call");
    assert.ok(getFreshGmgn15m(mint, nowMs + 1000));
  } finally {
    clearGmgn15mCache({ includeDisk: true });
    if (prevEnv === undefined) delete process.env.GMGN_KLINE_CACHE_FILE;
    else process.env.GMGN_KLINE_CACHE_FILE = prevEnv;
    config.gmgnCentralCollector = prevCentral;
  }
});
