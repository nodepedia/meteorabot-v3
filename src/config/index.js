import { loadEnv, bool, num } from "./env.js";
import { modeRules, LEGACY_MODE } from "./rules.js";

const e = loadEnv();

// Mode = "<strategi>:<komposisi>".
//   strategi   : bidask | spot
//   komposisi  : double (token+SOL) | token | sol
const bidaskDouble = modeRules(e, "BIDASK_DOUBLE", {
  enableIndicators: true,
  trailingTakeProfit: true,
});

// Token-only: trailing TP OFF, indikator + trailing-dari-sinyal ON.
const bidaskToken = modeRules(e, "BIDASK_TOKEN", {
  enableIndicators: true,
  trailingTakeProfit: false,
});

const bidaskSol = modeRules(e, "BIDASK_SOL", {
  enableIndicators: true,
  trailingTakeProfit: true,
});

const spotDouble = modeRules(e, "SPOT_DOUBLE", {
  trailingTakeProfit: true,
  trailingTriggerPct: 15,
});

// Scaffold — rules diisi saat update spot token-only datang.
const spotToken = modeRules(e, "SPOT_TOKEN", {});

// Scaffold — rules diisi saat update spot sol-only datang.
const spotSol = modeRules(e, "SPOT_SOL", {});

const entry = {
  enabled: bool(e.ENTRY_ENABLED, true),
  poolListFile: e.POOL_LIST_FILE || "pool.txt",
  // Refresh kandidat (pool list + posisi terbuka via RPC), bukan cadence sinyal.
  scanIntervalSec: num(e.ENTRY_SCAN_INTERVAL_SEC, 30),
  timeframe: e.ENTRY_TIMEFRAME || "15m",
  stAtrPeriod: num(e.ST_ATR_PERIOD, 10),
  stMultiplier: num(e.ST_MULTIPLIER, 3),
  expiryHours: num(e.ENTRY_EXPIRY_HOURS, 6),
  sizeSplit: num(e.ENTRY_SIZE_SPLIT, 0.5),
  slippageBps: num(e.ENTRY_SLIPPAGE_BPS, 1000),
  gasReserve: num(e.GAS_RESERVE, 0.05),
  failureCooldownSec: num(e.ENTRY_FAILURE_COOLDOWN_SEC, 300),
  oneShotPerSignal: bool(e.ENTRY_ONE_SHOT_PER_SIGNAL, true),
  maxFailures: num(e.ENTRY_MAX_FAILURES, 3),
  // held_pullback = close harus tetap di atas garis; first_touch = sentuh garis = entry.
  touchMode: (e.ENTRY_TOUCH_MODE || "held_pullback").toLowerCase() === "first_touch" ? "first_touch" : "held_pullback",
};

// DCA (averaging-down) — trailing TP terbalik: arm saat PnL <= armPct, lacak
// trough (titik terendah), lalu entry baru saat PnL rebound dari trough.
const dca = {
  enabled: bool(e.DCA_ENABLED, false),
  armPct: num(e.DCA_ARM_PCT, -10),
  reboundPct: Math.max(0, num(e.DCA_REBOUND_PCT, 1)),
  maxAdds: Math.max(0, Math.floor(num(e.DCA_MAX_ADDS, 1))),
  // Cadence watcher DCA (detik) — scan arm/trail + konfirmasi rebound dari
  // satu request PnL yang sama.
  pollIntervalSec: Math.max(1, num(e.DCA_POLL_INTERVAL_SEC, 5)),
  // Ambang minimum sebelum pending rebound dikonfirmasi (efektif = tick watcher).
  confirmDelaySec: Math.max(0, num(e.DCA_CONFIRM_DELAY_SEC, 5)),
  cooldownSec: Math.max(0, num(e.DCA_COOLDOWN_SEC, 300)),
};

// Entry execution is fixed by design: BidAsk, two-sided (token + SOL), bins ±34.
export const BINS_BELOW = 34;
export const BINS_ABOVE = 34;
export const STRATEGY = "bid_ask";
// One concurrent position per pool; total opens per pool come from pool.txt.
export const MAX_CONCURRENT_PER_POOL = 1;

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const swap = {
  autoSwapAfterClose: bool(e.AUTO_SWAP_AFTER_CLOSE, true),
  slippageBps: num(e.SWAP_SLIPPAGE_BPS, 100),
  // true = Jupiter RTSE (estimasi slippage otomatis, mode ultra); false =
  // pakai SWAP_SLIPPAGE_BPS tetap.
  useRtse: bool(e.SWAP_USE_RTSE, false),
  retryAttempts: num(e.SWAP_RETRY_ATTEMPTS, 3),
  dustUsdThreshold: num(e.DUST_USD_THRESHOLD, 0.5),
  excludeMints:
    e.SWEEP_EXCLUDE_MINTS != null && e.SWEEP_EXCLUDE_MINTS !== ""
      ? e.SWEEP_EXCLUDE_MINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [USDC_MINT],
  failureCooldownSec: num(e.SWEEP_FAILURE_COOLDOWN_SEC, 1800),
};

const config = {
  walletPrivateKey: e.WALLET_PRIVATE_KEY || "",
  rpcUrl:
    e.RPC_URL ||
    (e.HELIUS_API_KEY ? `https://rpc.helius.xyz/?api-key=${e.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com"),
  heliusApiKey: e.HELIUS_API_KEY || "",
  gmgnApiKey: e.GMGN_API_KEY || "",
  jupiterPriceApiKey: e.JUPITER_PRICE_API_KEY || e.JUPITER_API_KEY || "",
  jupiterSwapApiKey: e.JUPITER_SWAP_API_KEY || e.JUPITER_API_KEY || "",
  dryRun: e.DRY_RUN !== "false",
  solMode: e.SOL_MODE !== "false",
  // info (default) = naratif + warn/error; debug = ikut menampilkan [detail] teknis.
  logLevel: (e.LOG_LEVEL || "info").toLowerCase() === "debug" ? "debug" : "info",

  timeframe: e.TIMEFRAME || "15m",

  volumeCandleCount: num(e.VOLUME_CANDLE_COUNT, 5),
  volumeTimeframe: e.VOLUME_TIMEFRAME || "5m",

  // Data layer: TF native pakai Meteora; 15m (non-native) pakai GMGN.
  candleCacheTtlSec: num(e.CANDLE_CACHE_TTL_SEC, 60),
  // Jeda (detik) setelah bar 15m tutup sebelum request data baru, agar bar
  // baru sudah terbentuk dan bar yang baru tutup sudah final.
  candleCloseDelaySec: Math.max(0, num(e.CANDLE_CLOSE_DELAY_SEC, 3)),
  candle15mSource: (e.CANDLE_15M_SOURCE || "gmgn").toLowerCase() === "meteora" ? "meteora" : "gmgn",
  gmgnMaxPerMin: num(e.GMGN_MAX_PER_MIN, 4),
  gmgnMinGapSec: num(e.GMGN_MIN_GAP_SEC, 15),
  gmgnMaxStaleMin: num(e.GMGN_MAX_STALE_MIN, 30),
  gmgnFallbackToMeteora: bool(e.GMGN_FALLBACK_TO_METEORA, false),
  meteoraMaxPerMin: num(e.METEORA_MAX_PER_MIN, 120),

  // Sinyal entry: GMGN 15m (arah+garis) + Jupiter (harga real-time).
  // Satu request batch untuk semua pool. Limit price/v3 ≈ 10 req/10s (~1 req/s);
  // pakai key khusus harga + interval 2s (≈5 req/10s) agar aman dari 429.
  jupiterPollIntervalSec: Math.max(1, num(e.JUPITER_POLL_INTERVAL_SEC, 2)),
  entryTouchTolerancePct: num(e.ENTRY_TOUCH_TOLERANCE_PCT, 0),
  supertrendCacheFile: e.SUPERTREND_CACHE_FILE || "supertrend-cache.json",

  logRetentionDays: num(e.LOG_RETENTION_DAYS, 7),

  binThreshold: num(e.BIN_THRESHOLD, 80),
  pollIntervalHold: num(e.POLL_INTERVAL_HOLD, 0.2),
  pollIntervalIdle: num(e.POLL_INTERVAL_IDLE, 5),
  trailingConfirmDelaySec: num(e.TRAILING_CONFIRM_DELAY_SEC, 10),
  // Jumlah siklus berturut-turut posisi tidak terbaca on-chain sebelum
  // dianggap sudah ditutup manual.
  missingCycleThreshold: Math.max(1, num(e.MISSING_CYCLE_THRESHOLD, 5)),

  telegramBotToken: e.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: e.TELEGRAM_CHAT_ID || "",
  tgStatusInterval: num(e.TG_STATUS_INTERVAL, 5),

  entry,
  swap,
  dca,

  bidaskDouble,
  bidaskToken,
  bidaskSol,
  spotDouble,
  spotToken,
  spotSol,

  rulesFor(mode) {
    switch (LEGACY_MODE[mode] || mode) {
      case "bidask:token":
        return this.bidaskToken;
      case "bidask:sol":
        return this.bidaskSol;
      case "spot:double":
        return this.spotDouble;
      case "spot:token":
        return this.spotToken;
      case "spot:sol":
        return this.spotSol;
      case "bidask:double":
      default:
        return this.bidaskDouble;
    }
  },
};

export default config;
