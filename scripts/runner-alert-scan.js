import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM_PKG from "@meteora-ag/dlmm";
import { OpenApiClient } from "../node_modules/gmgn-cli/dist/client/OpenApiClient.js";
import { createGmgnLimiter } from "../src/market/gmgn-limiter.js";
import { remoteConfig, remoteUpdatePool } from "../src/runner/remote-pool.js";
import { resolveSpotRangeWithRentCheck } from "../src/meteora/spot-position.js";

const DLMM = DLMM_PKG.default || DLMM_PKG;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const WSOL = "So11111111111111111111111111111111111111112";
const DLMM_PROG = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function toWibString(tsMs = Date.now()) {
  const d = new Date(tsMs + 7 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " WIB";
}

function toWibShort(tsMs = Date.now()) {
  const d = new Date(tsMs + 7 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + " WIB";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve) => {
    if (!botToken || !chatId) return resolve(false);
    const body = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) });
    const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        family: 4,
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(res.statusCode === 200));
      }
    );
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

function loadSmartWallets() {
  const gmgnSmartMap = new Map();
  const sPath = path.join(process.env.GMGN_WALLETS_DIR || parseEnvFile(path.join(ROOT, ".env")).GMGN_WALLETS_DIR || "/workspace/lowcap-hunter-exports", "gmgn_import_S.json");
  const aPath = path.join(process.env.GMGN_WALLETS_DIR || parseEnvFile(path.join(ROOT, ".env")).GMGN_WALLETS_DIR || "/workspace/lowcap-hunter-exports", "gmgn_import_A.json");
  const repPath = path.join(process.env.GMGN_WALLETS_DIR || parseEnvFile(path.join(ROOT, ".env")).GMGN_WALLETS_DIR || "/workspace/lowcap-hunter-exports", "wallets_report.json");

  if (fs.existsSync(sPath)) {
    for (const w of JSON.parse(fs.readFileSync(sPath, "utf8"))) {
      gmgnSmartMap.set(w.address, { address: w.address, tier: "S", name: w.name || "S" });
    }
  }
  if (fs.existsSync(aPath)) {
    for (const w of JSON.parse(fs.readFileSync(aPath, "utf8"))) {
      gmgnSmartMap.set(w.address, { address: w.address, tier: "A", name: w.name || "A" });
    }
  }
  if (fs.existsSync(repPath)) {
    const rep = JSON.parse(fs.readFileSync(repPath, "utf8"));
    for (const w of rep.wallets || []) {
      if (w.tier === "S" || w.tier === "A") {
        const existing = gmgnSmartMap.get(w.address);
        gmgnSmartMap.set(w.address, {
          address: w.address,
          tier: w.tier,
          name: existing?.name || w.name || `${w.tier}${w.rank || ""}`,
          winRate: w.win_rate_pct,
        });
      }
    }
  }

  const lpSmartMap = new Map();
  const lpPath = path.join(ROOT, "lpagent-smart-wallets.json");
  if (fs.existsSync(lpPath)) {
    const lpData = JSON.parse(fs.readFileSync(lpPath, "utf8"));
    for (const w of lpData.wallets || []) {
      if (w.tier === "S" || w.tier === "A") {
        lpSmartMap.set(w.address, {
          address: w.address,
          tier: w.tier,
          rank: w.rank,
          winRate: w.win_rate_pct ?? w.winRatePct,
          score: w.score,
        });
      }
    }
  }

  return { gmgnSmartMap, lpSmartMap };
}

function multRank(multStr) {
  const m = String(multStr || "1x").trim().toLowerCase();
  if (m === "1.5x" || m === "tier3") return 3;
  if (m === "1.25x" || m === "tier2") return 2;
  return 1;
}

function updatePoolTxtFile(poolTxtPath, poolAddress, multiplierStr, allTokenPoolAddresses = [], mint = "") {
  const rawBefore = fs.existsSync(poolTxtPath) ? fs.readFileSync(poolTxtPath, "utf8") : "";
  const lines = rawBefore.split("\n");
  const tokenPoolSet = new Set([poolAddress, ...(allTokenPoolAddresses || []).filter(Boolean)]);

  // Check state.json for any currently open position on the same token (baseMint) or any of its pools
  let hasOpenPositionForToken = false;
  let openPositionPool = null;
  try {
    const statePath = path.join(ROOT, "state.json");
    if (fs.existsSync(statePath)) {
      const stateJson = JSON.parse(fs.readFileSync(statePath, "utf8"));
      for (const p of Object.values(stateJson.positions || {})) {
        if (!p || p.closed) continue;
        if ((mint && p.baseMint === mint) || (p.pool && tokenPoolSet.has(p.pool))) {
          hasOpenPositionForToken = true;
          openPositionPool = p.pool || null;
          if (openPositionPool) tokenPoolSet.add(openPositionPool);
          break;
        }
      }
    }
  } catch {
    // ignore state read errors
  }

  let foundActiveIdx = -1;
  let foundPoolAddr = poolAddress;
  let existingMult = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(",").map((s) => s.trim());
    if (tokenPoolSet.has(parts[0])) {
      foundActiveIdx = i;
      foundPoolAddr = parts[0];
      existingMult = parts[1] || "1x";
      break;
    }
  }

  const activePoolToKeep = foundActiveIdx !== -1 ? foundPoolAddr : openPositionPool || poolAddress;
  const targetLine = `${activePoolToKeep},${multiplierStr},1,spot`;
  let action = "unchanged";

  // Jika token sudah punya posisi terbuka di state.json, JANGAN tambahkan baris pool baru ke pool.txt
  if (hasOpenPositionForToken && foundActiveIdx === -1) {
    return {
      changed: false,
      action: "skipped_token_already_open",
      before: rawBefore.trim(),
      after: rawBefore.trim(),
      targetLine,
    };
  }

  if (foundActiveIdx === -1) {
    const cleanLines = lines.filter((l, idx) => !(idx === lines.length - 1 && l === ""));
    cleanLines.push(targetLine);
    const rawAfter = cleanLines.join("\n") + "\n";
    fs.writeFileSync(poolTxtPath, rawAfter);
    return { changed: true, action: "added", before: rawBefore.trim(), after: rawAfter.trim(), targetLine };
  }

  if (multRank(multiplierStr) > multRank(existingMult)) {
    lines[foundActiveIdx] = targetLine;
    const rawAfter = lines.join("\n");
    fs.writeFileSync(poolTxtPath, rawAfter);
    action = `upgraded (${existingMult} -> ${multiplierStr})`;
    return { changed: true, action, before: rawBefore.trim(), after: rawAfter.trim(), targetLine };
  }

  return { changed: false, action, before: rawBefore.trim(), after: rawBefore.trim(), targetLine };
}

async function fetchMeteoraPages(maxPages = 10, pageSize = 100) {
  const pools = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(`https://dlmm.datapi.meteora.ag/pools?page=${page}&page_size=${pageSize}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;
      const json = await res.json();
      const data = json.data || [];
      if (!data.length) break;
      pools.push(...data);
    } catch {
      break;
    }
  }
  return pools;
}

async function fetchDexScreenerPairs(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function auditPoolOnChain(conn, poolAddr, lpSmartMap) {
  const dlmmPool = await DLMM.create(conn, new PublicKey(poolAddr));
  const activeBin = await dlmmPool.getActiveBin();
  const activeBinId = Number(activeBin.binId);
  const xIsSol = dlmmPool.tokenX.publicKey.toBase58() === WSOL;
  const binStep = Number(dlmmPool.lbPair.binStep);

  const around = await dlmmPool.getBinsAroundActiveBin(40, 40);
  const binsList = around.bins || [];
  const binMap = new Map(binsList.map((b) => [Number(b.binId), b]));

  let bins35Ge1Sol = 0;
  let bins35Gt0Sol = 0;
  let bins31RequiredGe1Sol = 0;
  let minBinSol35 = Infinity;
  let minBinSol31Req = Infinity;
  let maxBinSol35 = 0;
  let totalSolIn35Bins = 0;
  const binSolDetails = [];

  for (let offset = 0; offset <= 34; offset++) {
    const bid = xIsSol ? activeBinId + offset : activeBinId - offset;
    const b = binMap.get(bid);
    const rawLamports = b ? Number(xIsSol ? b.xAmount.toString() : b.yAmount.toString()) : 0;
    const solAmt = rawLamports / 1e9;
    totalSolIn35Bins += solAmt;
    if (solAmt > 0) bins35Gt0Sol++;
    if (solAmt >= 1.0) bins35Ge1Sol++;
    if (solAmt < minBinSol35) minBinSol35 = solAmt;
    if (solAmt > maxBinSol35) maxBinSol35 = solAmt;

    if (offset >= 4) {
      if (solAmt >= 1.0) bins31RequiredGe1Sol++;
      if (solAmt < minBinSol31Req) minBinSol31Req = solAmt;
    }
    binSolDetails.push({ offset, binId: bid, sol: Number(solAmt.toFixed(4)), inToleranceZone: offset <= 3 });
  }

  const rentCheck = await resolveSpotRangeWithRentCheck({
    pool: dlmmPool,
    activeBinId,
    binStep,
    lowerPctPrimary: -95,
    lowerPctFallback: -90,
    upperPct: 15,
    skipNonRefundable: true,
    maxNonRefundableSol: 0,
  });

  const posAccts = await conn.getProgramAccounts(DLMM_PROG, {
    dataSlice: { offset: 40, length: 32 },
    filters: [{ memcmp: { offset: 8, bytes: poolAddr } }],
  });
  const owners = new Set(posAccts.map((a) => new PublicKey(a.account.data).toBase58()));
  const matchedSmartLps = [];
  for (const o of owners) {
    if (lpSmartMap.has(o)) {
      matchedSmartLps.push(lpSmartMap.get(o));
    }
  }

  return {
    pool: poolAddr,
    binStep,
    xIsSol,
    activeBinId,
    activePrice: String(activeBin.price),
    activePricePerToken: String(activeBin.pricePerToken),
    bins35Stats: {
      all35BinsGe1Sol: bins35Ge1Sol === 35,
      binsGe1SolCount: bins35Ge1Sol,
      binsGt0SolCount: bins35Gt0Sol,
      bins31RequiredGe1SolCount: bins31RequiredGe1Sol,
      passes3BinToleranceRule: bins31RequiredGe1Sol === 31,
      minBinSol35: Number((minBinSol35 === Infinity ? 0 : minBinSol35).toFixed(4)),
      minBinSol31Req: Number((minBinSol31Req === Infinity ? 0 : minBinSol31Req).toFixed(4)),
      maxBinSol: Number(maxBinSol35.toFixed(4)),
      avgBinSol: Number((totalSolIn35Bins / 35).toFixed(4)),
      totalSolIn35Bins: Number(totalSolIn35Bins.toFixed(4)),
    },
    rentCheck: {
      ok: Boolean(rentCheck.ok),
      usedFallback: Boolean(rentCheck.usedFallback),
      redflagNonRefundable: Boolean(rentCheck.redflagNonRefundable),
      lowerPctUsed: rentCheck.lowerPctUsed ?? null,
      upperPctUsed: rentCheck.upperPctUsed ?? 15,
      nonRefundableSol: rentCheck.nonRefundableSol ?? rentCheck.costPrimarySol ?? 0,
    },
    onChainPositions: {
      positionAccountCount: posAccts.length,
      uniqueOwnerCount: owners.size,
      matchedSmartLps,
    },
  };
}

function isOfficialPoolOrProgramHolder(h, knownPoolAddrs) {
  if (!h) return false;
  if (Number(h.addr_type) === 2) return true;
  if (h.is_on_curve === false) return true;
  const ex = String(h.exchange || "").toLowerCase();
  if (ex.includes("pump") || ex.includes("meteora") || ex.includes("raydium") || ex.includes("orca") || ex.includes("dlmm")) {
    return true;
  }
  const addr = String(h.address || "");
  const acct = String(h.account_address || "");
  if (knownPoolAddrs.has(addr) || knownPoolAddrs.has(acct)) return true;
  return false;
}

async function auditGmgnToken(gmgnClient, limiter, mint, knownPoolAddrs, gmgnSmartMap) {
  const info = await limiter.schedule(`info:${mint}`, () => gmgnClient.getTokenInfo("sol", mint));
  const security = await limiter.schedule(`sec:${mint}`, () => gmgnClient.getTokenSecurity("sol", mint));
  const holdersRes = await limiter.schedule(`holders:${mint}`, () =>
    gmgnClient.getTokenTopHolders("sol", mint, { limit: 50 })
  );
  const tradersRes = await limiter.schedule(`traders:${mint}`, () =>
    gmgnClient.getTokenTopTraders("sol", mint, { limit: 100 })
  );

  const holders = Array.isArray(holdersRes) ? holdersRes : holdersRes?.list || [];
  const traders = Array.isArray(tradersRes) ? tradersRes : tradersRes?.list || [];

  if (info?.biggest_pool_address) knownPoolAddrs.add(info.biggest_pool_address);
  if (info?.pool?.pool_address) knownPoolAddrs.add(info.pool.pool_address);
  if (info?.pool?.base_vault_address) knownPoolAddrs.add(info.pool.base_vault_address);
  if (info?.pool?.quote_vault_address) knownPoolAddrs.add(info.pool.quote_vault_address);

  const stat = info?.stat || {};
  const totalFeeSol = Number(info?.total_fee || 0);
  const top10Rate = Number(security?.top_10_holder_rate ?? stat.top_10_holder_rate ?? info?.dev?.top_10_holder_rate ?? 1);
  const sniperRate = Number(stat.top70_sniper_hold_rate ?? 0);
  const ratTraderRate = Number(stat.top_rat_trader_percentage ?? 0);
  const devRate = Number(stat.dev_team_hold_rate ?? 0);
  const creatorRate = Number(stat.creator_hold_rate ?? 0);
  const insiderRate = Math.max(ratTraderRate, devRate, creatorRate);

  const renouncedMint = Boolean(security?.renounced_mint);
  const renouncedFreeze = Boolean(security?.renounced_freeze_account);
  const blacklist = Number(security?.blacklist || 0);
  const burnRatio = Number(security?.burn_ratio ?? 0);

  const activeHolders = holders.filter((h) => Number(h.amount_cur ?? h.balance ?? 0) > 0).slice(0, 30);
  const zeroBuyOffenders = [];
  for (let i = 0; i < activeHolders.length; i++) {
    const h = activeHolders[i];
    if (isOfficialPoolOrProgramHolder(h, knownPoolAddrs)) continue;
    const buys = Number(h.buy_tx_count_cur || 0);
    const buyAmt = Number(h.buy_amount_cur || 0);
    const boughtCost = Number(h.history_bought_cost || 0);
    if (buys === 0 && buyAmt === 0 && boughtCost === 0) {
      zeroBuyOffenders.push({
        rank: i + 1,
        address: h.address,
        pct: Number(((Number(h.amount_percentage || 0)) * 100).toFixed(2)),
        tags: h.maker_token_tags || h.tags || [],
      });
    }
  }

  const matchedGmgnSmart = [];
  const seenSmart = new Set();
  for (const item of [...holders, ...traders]) {
    const addr = item.address || item.wallet_address;
    if (addr && gmgnSmartMap.has(addr) && !seenSmart.has(addr)) {
      seenSmart.add(addr);
      matchedGmgnSmart.push(gmgnSmartMap.get(addr));
    }
  }

  const checks = {
    feesGe30Sol: totalFeeSol >= 30,
    top10Le40Pct: top10Rate <= 0.40,
    sniperZero: sniperRate === 0,
    insiderZero: insiderRate === 0,
    noMint: renouncedMint,
    noBlacklistFreeze: renouncedFreeze && blacklist === 0,
    burnt100Pct: burnRatio >= 0.99,
    top30NoZeroBuy: zeroBuyOffenders.length === 0,
  };

  const passedStage3 = Object.values(checks).every(Boolean);

  return {
    totalFeeSol: Number(totalFeeSol.toFixed(2)),
    top10Pct: Number((top10Rate * 100).toFixed(2)),
    sniperPct: Number((sniperRate * 100).toFixed(2)),
    insiderPct: Number((insiderRate * 100).toFixed(2)),
    ratTraderPct: Number((ratTraderRate * 100).toFixed(2)),
    devHoldPct: Number((devRate * 100).toFixed(2)),
    creatorHoldPct: Number((creatorRate * 100).toFixed(2)),
    renouncedMint,
    renouncedFreeze,
    blacklist,
    burnRatioPct: Number((burnRatio * 100).toFixed(2)),
    top30CheckedCount: activeHolders.length,
    zeroBuyOffendersCount: zeroBuyOffenders.length,
    zeroBuyOffenders: zeroBuyOffenders.slice(0, 5),
    checks,
    passedStage3,
    matchedGmgnSmart,
    gmgnCreationTsSec: Number(info?.creation_timestamp || info?.open_timestamp || 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const auditAllStage1 = args.includes("--audit-stage1");
  const dryRun = args.includes("--dry-run");

  // Prioritas: process.env > .env > output/.env.scanner > SCANNER_ENV_FILE (legacy).
  const botEnv = parseEnvFile(path.join(ROOT, ".env"));
  const scannerEnv = {
    ...parseEnvFile(process.env.SCANNER_ENV_FILE || "/workspace/lowcap-hunter-exports/.env.scanner"),
    ...parseEnvFile(path.join(ROOT, "output", ".env.scanner")),
    ...botEnv,
  };

  const gmgnApiKey = process.env.SCANNER_GMGN_API_KEY || scannerEnv.SCANNER_GMGN_API_KEY;
  const rpcUrl = process.env.SCANNER_RPC_URL || scannerEnv.SCANNER_RPC_URL;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN || botEnv.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID || botEnv.TELEGRAM_CHAT_ID;

  if (!gmgnApiKey || !rpcUrl) {
    throw new Error("Missing SCANNER_GMGN_API_KEY / SCANNER_RPC_URL (isi di .env)");
  }

  // Throttle RPC (Helius free ~10 req/s) agar tidak 429: jeda minimal antar request.
  const rpcGapMs = Number(process.env.RUNNER_RPC_MIN_GAP_MS || botEnv.RUNNER_RPC_MIN_GAP_MS) || 150;
  let rpcNext = 0;
  const throttledFetch = async (url, opts) => {
    const now = Date.now();
    const wait = Math.max(0, rpcNext - now);
    rpcNext = Math.max(now, rpcNext) + rpcGapMs;
    if (wait) await sleep(wait);
    return fetch(url, opts);
  };
  const conn = new Connection(rpcUrl, { commitment: "confirmed", fetch: throttledFetch });
  const gmgnClient = new OpenApiClient({
    apiKey: gmgnApiKey,
    host: "https://openapi.gmgn.ai",
  });
  const limiter = createGmgnLimiter({
    maxPerMin: 15,
    minGapMs: 1500,
    crossProcess: true,
    stateFile: "/tmp/gmgn-runner-alert-rate-state.json",
  });

  const { gmgnSmartMap, lpSmartMap } = loadSmartWallets();
  const poolTxtPath = path.join(ROOT, "pool.txt");
  const poolTxtBefore = fs.existsSync(poolTxtPath) ? fs.readFileSync(poolTxtPath, "utf8").trim() : "";

  const scanNowMs = Date.now();
  const scanNowWib = toWibString(scanNowMs);

  // STAGE 1: Fetch Meteora DLMM pools & group by TOKEN/SOL
  const rawPools = await fetchMeteoraPages(10, 100);
  const tokenMap = new Map();
  let tokenSolPoolCount = 0;

  for (const p of rawPools) {
    if (p.is_blacklisted) continue;
    const xIsSol = p.token_x?.address === WSOL;
    const yIsSol = p.token_y?.address === WSOL;
    if (!xIsSol && !yIsSol) continue;
    tokenSolPoolCount++;

    const baseToken = xIsSol ? p.token_y : p.token_x;
    const solToken = xIsSol ? p.token_x : p.token_y;
    const mint = baseToken?.address;
    if (!mint) continue;

    if (!tokenMap.has(mint)) {
      tokenMap.set(mint, {
        mint,
        symbol: baseToken.symbol || "UNKNOWN",
        name: baseToken.name || "",
        meteoraMcapUsd: Number(baseToken.market_cap || 0),
        solPriceUsd: Number(solToken?.price || 100),
        holders: Number(baseToken.holders || 0),
        earliestMeteoraPoolMs: Number(p.created_at || Infinity),
        pools: [],
      });
    }
    const entry = tokenMap.get(mint);
    if (Number(baseToken.market_cap || 0) > entry.meteoraMcapUsd) {
      entry.meteoraMcapUsd = Number(baseToken.market_cap || 0);
    }
    if (Number(p.created_at || Infinity) < entry.earliestMeteoraPoolMs) {
      entry.earliestMeteoraPoolMs = Number(p.created_at);
    }
    entry.pools.push({
      address: p.address,
      name: p.name,
      xIsSol,
      createdAtMs: Number(p.created_at || 0),
      binStep: Number(p.pool_config?.bin_step || 100),
      baseFeePct: Number(p.pool_config?.base_fee_pct || 0),
      tvlUsd: Number(p.tvl || 0),
      vol24hUsd: Number(p.volume?.["24h"] || 0),
      fees24hUsd: Number(p.fees?.["24h"] || 0),
      cumFeesUsd: Number(p.cumulative_metrics?.fees || 0),
      reserveX: p.reserve_x,
      reserveY: p.reserve_y,
    });
  }

  // Filter tokens that might have mcap >= $250k (check all with meteoraMcap >= $150k on DexScreener)
  const preCandidates = Array.from(tokenMap.values()).filter((t) => t.meteoraMcapUsd >= 150000);
  const stage1Passed = [];
  const stage1RejectedSample = [];

  for (const cand of preCandidates) {
    const dexPairs = await fetchDexScreenerPairs(cand.mint);
    let earliestDexMs = cand.earliestMeteoraPoolMs;
    let bestLiqUsd = -1;
    let dexPrimaryMcapUsd = 0;

    for (const dp of dexPairs) {
      const created = Number(dp.pairCreatedAt || 0);
      if (created > 0 && created < earliestDexMs) {
        earliestDexMs = created;
      }
      const liq = Number(dp.liquidity?.usd || 0);
      const mc = Number(dp.marketCap || dp.fdv || 0);
      if (liq > bestLiqUsd && mc > 0) {
        bestLiqUsd = liq;
        dexPrimaryMcapUsd = mc;
      }
    }
    const dexMaxMcapUsd = dexPrimaryMcapUsd;

    const effectiveMcapUsd = dexMaxMcapUsd > 0 ? dexMaxMcapUsd : cand.meteoraMcapUsd;
    const ageHours = (scanNowMs - earliestDexMs) / 3600000;
    const sumCumFeesUsd = cand.pools.reduce((s, p) => s + p.cumFeesUsd, 0);
    const sumCumFeesSolEst = cand.solPriceUsd > 0 ? sumCumFeesUsd / cand.solPriceUsd : 0;

    cand.earliestPairCreatedAtMs = earliestDexMs;
    cand.birthWib = toWibShort(earliestDexMs);
    cand.ageHours = Number(ageHours.toFixed(2));
    cand.effectiveMcapUsd = Math.round(effectiveMcapUsd);
    cand.dexMaxMcapUsd = Math.round(dexMaxMcapUsd);
    cand.sumCumFeesUsd = Math.round(sumCumFeesUsd);
    cand.sumCumFeesSolEst = Number(sumCumFeesSolEst.toFixed(2));
    cand.dexPairsCount = dexPairs.length;
    cand.allDexPoolAddresses = dexPairs.map((p) => p.pairAddress).filter(Boolean);

    if (ageHours >= 4.0 && ageHours <= 24.0 && effectiveMcapUsd >= 250000) {
      stage1Passed.push(cand);
    } else if (ageHours <= 30.0) {
      stage1RejectedSample.push({
        symbol: cand.symbol,
        mint: cand.mint,
        ageHours: cand.ageHours,
        effectiveMcapUsd: cand.effectiveMcapUsd,
        reason:
          ageHours < 4.0
            ? `Umur < 4 jam (${cand.ageHours}h)`
            : ageHours > 24.0
              ? `Umur > 24 jam (${cand.ageHours}h)`
              : `Mcap < $250k ($${Math.round(effectiveMcapUsd / 1000)}k)`,
      });
    }
  }

  // Sort stage1Passed by sumCumFeesUsd desc
  stage1Passed.sort((a, b) => b.sumCumFeesUsd - a.sumCumFeesUsd);

  // STAGE 2: On-Chain Meteora DLMM Audit via separate VPS Helius RPC
  const stage2Results = [];
  for (const cand of stage1Passed) {
    // Sort pools by efficiency score: TVL + 24h fees * 5 + cumFees
    const sortedPools = cand.pools
      .slice()
      .sort((a, b) => b.tvlUsd + b.fees24hUsd * 5 + b.cumFeesUsd - (a.tvlUsd + a.fees24hUsd * 5 + a.cumFeesUsd));

    // Audit top pools (up to 3 pools per token if multiple exist) to pick the single most efficient qualifying pool
    const poolAudits = [];
    for (const p of sortedPools.slice(0, 3)) {
      try {
        const audit = await auditPoolOnChain(conn, p.address, lpSmartMap);
        poolAudits.push({ poolMeta: p, onchain: audit });
      } catch (err) {
        poolAudits.push({ poolMeta: p, onchain: { pool: p.address, error: err.message } });
      }
    }

    // Pick best pool: prefer one that passes Stage 2, otherwise highest bins31RequiredGe1SolCount then positionAccountCount then TVL
    poolAudits.sort((a, b) => {
      const aPass =
        (a.onchain?.onChainPositions?.positionAccountCount || 0) >= 20 &&
        a.onchain?.bins35Stats?.passes3BinToleranceRule &&
        a.onchain?.rentCheck?.ok
          ? 1
          : 0;
      const bPass =
        (b.onchain?.onChainPositions?.positionAccountCount || 0) >= 20 &&
        b.onchain?.bins35Stats?.passes3BinToleranceRule &&
        b.onchain?.rentCheck?.ok
          ? 1
          : 0;
      if (bPass !== aPass) return bPass - aPass;
      const aBins = a.onchain?.bins35Stats?.bins31RequiredGe1SolCount || 0;
      const bBins = b.onchain?.bins35Stats?.bins31RequiredGe1SolCount || 0;
      if (bBins !== aBins) return bBins - aBins;
      const aLp = a.onchain?.onChainPositions?.positionAccountCount || 0;
      const bLp = b.onchain?.onChainPositions?.positionAccountCount || 0;
      if (bLp !== aLp) return bLp - aLp;
      return b.poolMeta.tvlUsd - a.poolMeta.tvlUsd;
    });

    const chosen = poolAudits[0];
    const oc = chosen?.onchain || {};
    const lpCount = oc.onChainPositions?.positionAccountCount || 0;
    const uniqueLps = oc.onChainPositions?.uniqueOwnerCount || 0;
    const bins31Count = oc.bins35Stats?.bins31RequiredGe1SolCount || 0;
    const passesBins31 = Boolean(oc.bins35Stats?.passes3BinToleranceRule);
    const passesLp20 = lpCount >= 20;
    const passesRent = Boolean(oc.rentCheck?.ok);
    const passedStage2 = passesLp20 && passesBins31 && passesRent;

    const stage2Reasons = [];
    if (!passesLp20) stage2Reasons.push(`LP aktif ${lpCount} < 20`);
    if (!passesBins31) stage2Reasons.push(`Bin wajib >=1 SOL hanya ${bins31Count}/31 bin (min=${oc.bins35Stats?.minBinSol31Req ?? 0} SOL)`);
    if (!passesRent) stage2Reasons.push(`Non-refundable rent redflag`);

    stage2Results.push({
      candidate: cand,
      bestPool: chosen.poolMeta,
      onchain: oc,
      allPoolsAudited: poolAudits.map((x) => ({
        pool: x.poolMeta.address,
        tvlUsd: Math.round(x.poolMeta.tvlUsd),
        fees24hUsd: Math.round(x.poolMeta.fees24hUsd),
        lpPositions: x.onchain?.onChainPositions?.positionAccountCount ?? 0,
        uniqueLpOwners: x.onchain?.onChainPositions?.uniqueOwnerCount ?? 0,
        bins31Ge1Sol: x.onchain?.bins35Stats?.bins31RequiredGe1SolCount ?? 0,
        minBinSol31Req: x.onchain?.bins35Stats?.minBinSol31Req ?? 0,
        totalSolIn35Bins: x.onchain?.bins35Stats?.totalSolIn35Bins ?? 0,
        rentOk: x.onchain?.rentCheck?.ok ?? false,
      })),
      passedStage2,
      stage2Reasons,
    });
  }

  // STAGE 3 & 4: GMGN Security + Holder Audit & Dual Confluence
  const fullResults = [];
  const passedAll = [];

  for (const item of stage2Results) {
    const { candidate, bestPool, onchain, passedStage2 } = item;
    let gmgnAudit = null;

    if (passedStage2 || auditAllStage1) {
      const knownPools = new Set([
        ...candidate.pools.map((p) => p.address),
        ...candidate.pools.map((p) => p.reserveX).filter(Boolean),
        ...candidate.pools.map((p) => p.reserveY).filter(Boolean),
        ...(candidate.allDexPoolAddresses || []),
      ]);
      try {
        gmgnAudit = await auditGmgnToken(gmgnClient, limiter, candidate.mint, knownPools, gmgnSmartMap);
        // Also accept Meteora cumulative fees >= 30 SOL if GMGN total_fee is lower
        if (!gmgnAudit.checks.feesGe30Sol && candidate.sumCumFeesSolEst >= 30) {
          gmgnAudit.checks.feesGe30Sol = true;
          gmgnAudit.passedStage3 = Object.values(gmgnAudit.checks).every(Boolean);
        }
      } catch (err) {
        gmgnAudit = { error: err.message, passedStage3: false };
      }
    }

    const gmgnSmartMatches = gmgnAudit?.matchedGmgnSmart || [];
    const lpSmartMatches = onchain?.onChainPositions?.matchedSmartLps || [];
    // Tier S = syarat confluence; Tier A hanya bonus (A tanpa S tidak dihitung).
    const allSmart = [...gmgnSmartMatches, ...lpSmartMatches];
    const hasTierS = allSmart.some((w) => w?.tier === "S");
    const hasTierA = allSmart.some((w) => w?.tier === "A");

    let confluenceLevel = 1;
    let multiplier = "1x";
    let label = "✅ RUNNER LOLOS FILTER";
    if (hasTierS && hasTierA) {
      confluenceLevel = 3;
      multiplier = "1.5x";
      label = "🔥🔥 DOUBLE CONFLUENCE RUNNER (Tier S + Tier A)";
    } else if (hasTierS) {
      confluenceLevel = 2;
      multiplier = "1.25x";
      label = "🔥 HIGH CONFLUENCE RUNNER (Tier S)";
    }

    // Verify true token age if GMGN creation_timestamp is older than 24h
    let trueAgeHours = candidate.ageHours;
    let ageStillValid = true;
    if (gmgnAudit?.gmgnCreationTsSec > 0) {
      const gmgnAgeH = (scanNowMs / 1000 - gmgnAudit.gmgnCreationTsSec) / 3600;
      if (gmgnAgeH > trueAgeHours) {
        trueAgeHours = Number(gmgnAgeH.toFixed(2));
      }
      if (trueAgeHours < 4.0 || trueAgeHours > 24.0) {
        ageStillValid = false;
      }
    }

    const passedAllStages = Boolean(ageStillValid && passedStage2 && gmgnAudit?.passedStage3);

    const record = {
      symbol: candidate.symbol,
      name: candidate.name,
      mint: candidate.mint,
      pipeFormat: `${candidate.symbol}|${candidate.mint}|${scanNowWib}|`,
      ageHoursDex: candidate.ageHours,
      trueAgeHours,
      ageStillValid,
      birthWib: candidate.birthWib,
      mcapUsd: candidate.effectiveMcapUsd,
      sumCumFeesSolEst: candidate.sumCumFeesSolEst,
      bestPool: bestPool.address,
      allPoolsAudited: item.allPoolsAudited,
      allTokenPoolAddresses: Array.from(
        new Set([
          bestPool.address,
          ...(candidate.pools || []).map((p) => p.address),
          ...(candidate.allDexPoolAddresses || []),
          ...(item.allPoolsAudited || []).map((x) => x.pool || x.address),
        ].filter(Boolean))
      ),
      passedStage2,
      stage2Reasons: item.stage2Reasons,
      onchain,
      gmgnAudit,
      confluence: {
        level: confluenceLevel,
        multiplier,
        label,
        gmgnSmartMatches,
        lpSmartMatches,
      },
      passedAllStages,
    };

    fullResults.push(record);
    if (passedAllStages) {
      passedAll.push(record);
    }
  }

  // STAGE 5: Update pool.txt & send Telegram if any passed all stages
  const poolUpdates = [];
  if (!dryRun && passedAll.length > 0) {
    for (const winner of passedAll) {
      const remoteCfg = remoteConfig({ ...parseEnvFile(path.join(ROOT, ".env")), ...process.env });
      const upd = remoteCfg
        ? remoteUpdatePool(remoteCfg, {
            poolAddress: winner.bestPool,
            multiplierStr: winner.confluence.multiplier,
            allTokenPoolAddresses: winner.allTokenPoolAddresses || (winner.allPoolsAudited || []).map((x) => x.pool || x.address),
            mint: winner.mint,
          })
        : updatePoolTxtFile(
        poolTxtPath,
        winner.bestPool,
        winner.confluence.multiplier,
        winner.allTokenPoolAddresses || (winner.allPoolsAudited || []).map((x) => x.pool || x.address),
        winner.mint
      );
      poolUpdates.push({ symbol: winner.symbol, pool: winner.bestPool, ...upd });

      if (upd.changed) {
        const msgLines = [
          `Halo King! Kandidat Runner Baru Lolos Filter:`,
          `${winner.confluence.label}`,
          `${winner.symbol}|${winner.mint}|${scanNowWib}|`,
          ``,
          `Token: ${winner.symbol} (${winner.name})`,
          `CA: ${winner.mint}`,
          `Pool DLMM: ${winner.bestPool}`,
          `Umur: ${winner.trueAgeHours} jam | Mcap: $${winner.mcapUsd.toLocaleString("en-US")}`,
          `Total Fees: ${winner.gmgnAudit?.totalFeeSol ?? winner.sumCumFeesSolEst} SOL`,
          `LP Aktif: ${winner.onchain.onChainPositions.positionAccountCount} posisi (${winner.onchain.onChainPositions.uniqueOwnerCount} owner)`,
          `Bin Wajib (activeBin-34..activeBin-4): ${winner.onchain.bins35Stats.bins31RequiredGe1SolCount}/31 bin >= 1 SOL (Total 35 bin: ${winner.onchain.bins35Stats.totalSolIn35Bins} SOL)`,
          `GMGN Security: Top10 ${winner.gmgnAudit.top10Pct}% | Sniper ${winner.gmgnAudit.sniperPct}% | Insider ${winner.gmgnAudit.insiderPct}% | Burnt ${winner.gmgnAudit.burnRatioPct}% | Top30 0-buy: ${winner.gmgnAudit.zeroBuyOffendersCount}`,
          `Sizing Tier: Level ${winner.confluence.level} (${winner.confluence.multiplier}, mode spot)`,
          `Perubahan pool.txt: ditambahkan baris ${upd.targetLine}`,
        ];
        await sendTelegram(tgToken, tgChatId, msgLines.join("\n"));
      }
    }
  }

  const poolTxtAfter = fs.existsSync(poolTxtPath) ? fs.readFileSync(poolTxtPath, "utf8").trim() : "";

  const summary = {
    scannedAtWib: scanNowWib,
    funnel: {
      meteoraPoolsFetched: rawPools.length,
      tokenSolPoolsCount: tokenSolPoolCount,
      uniqueTokenSolMints: tokenMap.size,
      preCandidatesMcapGe150kCheckedOnDexScreener: preCandidates.length,
      stage1PassedCount: stage1Passed.length,
      stage2PassedCount: stage2Results.filter((x) => x.passedStage2).length,
      stage3PassedCount: fullResults.filter((x) => x.gmgnAudit?.passedStage3).length,
      passedAllStagesCount: passedAll.length,
    },
    poolTxtBefore,
    poolTxtAfter,
    poolUpdates,
    stage1PassedResults: fullResults,
    stage1NearMissesUnder30h: stage1RejectedSample,
  };

  fs.writeFileSync("/tmp/latest-runner-alert-scan.json", JSON.stringify(summary, null, 2));
  const recBySym = new Map(fullResults.map((r) => [r.mint || r.symbol, r]));
  const f = summary.funnel;
  console.log(`[scan] ${scanNowWib} pools=${f.meteoraPoolsFetched} S1=${f.stage1PassedCount} S2=${f.stage2PassedCount} S3=${f.stage3PassedCount} ALL=${f.passedAllStagesCount}`);
  for (const it of stage2Results) {
    const c = it.candidate || {};
    const r = recBySym.get(c.mint || c.symbol);
    const s3 = Boolean(r?.gmgnAudit?.passedStage3);
    const all = Boolean(r?.passedAllStages);
    const conf = r?.confluence?.multiplier ? ` (${r.confluence.multiplier})` : "";
    console.log(`${c.symbol || "?"} : passStage1 [true], passStage2 [${Boolean(it.passedStage2)}], passStage3 [${s3}], passAll [${all}]${all ? conf : ""}`);
  }
  for (const u of poolUpdates) console.log(`pool.txt: ${u.symbol} ${u.action || "added"}`);
}

main().catch((err) => {
  console.error("Runner Alert Scan Error:", err);
  process.exit(1);
});
