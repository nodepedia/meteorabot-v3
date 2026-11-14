import { loadEnv, bool, num } from "./env.js";
import { modeRules, LEGACY_MODE } from "./rules.js";

const FEE_MODES = ["none", "priority", "jito", "both"];
function normalizeFeeMode(raw) {
  const value = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  return FEE_MODES.includes(value) ? value : "none";
}

// Entry execution is fixed by design: BidAsk, two-sided (token + SOL), bins ±34.
export const BINS_BELOW = 34;
export const BINS_ABOVE = 34;
export const STRATEGY = "bid_ask";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function buildConfig(e = {}) {
  // Mode = "<strategi>:<komposisi>".
  //   bidask : bidask:double | bidask:token | bidask:sol
  //   spot   : spot (satu mode, tanpa komposisi; span >= SPOT_MIN_BINS)
  const bidaskDouble = modeRules(e, "BIDASK_DOUBLE", {
    enableIndicators: true,
    trailingTakeProfit: true,
  });

  // Token-only: trailing TP OFF, indikator + trailing-dari-sinyal ON.
  // Dipakai juga oleh fallback OOR kiri spot (posisi token-only hasil konversi).
  const bidaskToken = modeRules(e, "BIDASK_TOKEN", {
    enableIndicators: true,
    trailingTakeProfit: false,
  });

  const bidaskSol = modeRules(e, "BIDASK_SOL", {
    enableIndicators: true,
    trailingTakeProfit: true,
  });

  // Spot-quote (satu mode, isi SOL-only, span >= SPOT_MIN_BINS): indikator sama
  // seperti bidask:double, trailing TP trigger +20%, OOR kanan ber-timer 2 menit
  // (dipercepat ke 1 menit bila volume 5m > $100k).
  // OOR kiri = tutup langsung (0 menit), lalu token dikonversi ke posisi
  // bidask:token oleh fallback (lihat spotFallback).
  const spot = modeRules(e, "SPOT", {
    enableIndicators: true,
    exitWarmupMinutes: 60,
    trailingTakeProfit: false,
    trailingTriggerPct: 20,
    enableOOR: true,
    oorKiriMinutes: 0,
    oorKananMinutes: 2,
    oorKananHighVol5mUsd: 100000,
    oorKananFastMinutes: 1,
    // 24h Fee/TVL posisi, angka apa adanya. Mulai hitung bila segar dan < 7.
    // Tutup setelah angka itu bertahan 60 detik.
    yieldCloseBelowPct: 7,
    yieldCloseBelowSec: 60,
  });

  // Exit indikator spot: immediate (default) = langsung close saat sinyal;
  // trailing = perilaku lama (arm trailing dari sinyal, exit saat drop terkonfirmasi).
  spot.indicatorExit =
    String(e.SPOT_INDICATOR_EXIT || "immediate")
      .trim()
      .toLowerCase() === "trailing"
      ? "trailing"
      : "immediate";

  // Fallback OOR kiri spot: tutup tanpa swap, lalu buka posisi token-only
  // satu-sisi di pool yang sama memakai seluruh saldo token.
  const spotFallback = {
    enabled: bool(e.SPOT_FALLBACK_ENABLED, true),
    binsAbove: Math.max(0, Math.floor(num(e.SPOT_FALLBACK_BINS_ABOVE, 70))),
    binsBelow: Math.max(0, Math.floor(num(e.SPOT_FALLBACK_BINS_BELOW, 0))),
    retry: Math.max(1, Math.floor(num(e.SPOT_FALLBACK_RETRY, 3))),
    distribution: (e.SPOT_FALLBACK_DISTRIBUTION || "bid_ask").toLowerCase(),
  };

  // Re-entry spot saat OOR kanan: buka posisi spot SOL-only baru di harga aktif
  // dengan jumlah bin ke bawah sama seperti posisi yang barusan ditutup.
  // Default cooldown otomatis mengikuti spot.oorKananMinutes * 60 (120s) dan
  // spot.oorKananFastMinutes * 60 (60s) agar single source of truth terjaga.
  // Size re-entry = entrySizeSol posisi lama, atau size entry di pool.txt
  // (multiplier × ENTRY_DEFAULT_SIZE_SOL). SPOT_REENTRY_SIZE_SOL dihapus.
  const spotReentry = {
    enabled: bool(e.SPOT_REENTRY_ENABLED, true),
    maxReentries: Math.max(0, Math.floor(num(e.SPOT_REENTRY_MAX, 50))),
    cooldownSec: Math.max(0, num(e.SPOT_REENTRY_COOLDOWN_SEC, spot.oorKananMinutes * 60)),
    fastCooldownSec: Math.max(0, num(e.SPOT_REENTRY_FAST_COOLDOWN_SEC, spot.oorKananFastMinutes * 60)),
    highVol5mUsd: Math.max(0, num(e.SPOT_OOR_KANAN_HIGH_VOL_5M_USD, spot.oorKananHighVol5mUsd)),
    // Tolak re-entry bila akan kena biaya non-refundable (sewa bin array/bitmap).
    skipNonRefundable: bool(e.SPOT_REENTRY_SKIP_NONREFUNDABLE, true),
    maxNonRefundableSol: Math.max(0, num(e.SPOT_REENTRY_MAX_NONREFUNDABLE_SOL, 0)),
    // Lewati re-entry bila RSI candle yang sudah tutup >= ambang. 0 = nonaktif.
    maxRsi: Math.max(0, num(e.SPOT_REENTRY_MAX_RSI, 90)),
  };

  // Entry spot pertama kena sewa non-refundable di seluruh tangga: cari pool
  // TOKEN/SOL lain untuk mint yang sama. false = skip pool seperti sebelumnya.
  const spotRentFallbackPool = bool(e.SPOT_RENT_FALLBACK_POOL, true);

  // Cara membentuk ulang likuiditas. inplace = instruksi rebalance_liquidity
  // (jumlah yang ditarik disetor ulang di tempat, saldo wallet tidak ikut).
  // withdraw = tarik ke wallet lalu setor hanya jumlah yang benar-benar keluar.
  const rebalance = {
    mode:
      String(e.REBALANCE_MODE || "inplace")
        .trim()
        .toLowerCase() === "withdraw"
        ? "withdraw"
        : "inplace",
  };

  // Rebalance sisi token posisi spot ke BidAsk tiap kelipatan stepPct% bin di atas activeBin.
  const spotTokenBidask = {
    enabled: bool(e.SPOT_TOKEN_BIDASK_ENABLED, true),
    stepPct: Math.max(1, num(e.SPOT_TOKEN_BIDASK_STEP_PCT, 10)),
    cooldownSec: Math.max(0, num(e.SPOT_TOKEN_BIDASK_COOLDOWN_SEC, 60)),
    retry: Math.max(1, Math.floor(num(e.SPOT_TOKEN_BIDASK_RETRY, 3))),
  };

  // Rebalance sisi token posisi bidask:double. Step = turunnya harga pool
  // dari entryPoolPrice posisi itu sendiri (bukan % bin seperti spot).
  const bidaskDoubleRebalance = {
    enabled: bool(e.BIDASK_DOUBLE_REBALANCE_ENABLED, true),
    // Sisi SOL: saat harga pulih satu step dari rebalance terakhir, SOL di bawah
    // bin aktif dibentuk ulang jadi BidAsk. Ikut mati bila enabled = false.
    solEnabled: bool(e.BIDASK_DOUBLE_SOL_REBALANCE_ENABLED, true),
    stepPct: Math.max(1, num(e.BIDASK_DOUBLE_REBALANCE_STEP_PCT, 10)),
    cooldownSec: Math.max(0, num(e.BIDASK_DOUBLE_REBALANCE_COOLDOWN_SEC, 60)),
    retry: Math.max(1, Math.floor(num(e.BIDASK_DOUBLE_REBALANCE_RETRY, 3))),
  };

  const entry = {
    enabled: bool(e.ENTRY_ENABLED, true),
    poolListFile: e.POOL_LIST_FILE || "pool.txt",
    // Baris CA (`<mint>,size,,spot,ca`, atau format lama `<mint>,size,max,spot,ca`):
    // pool dipilih saat entry = fee/active TVL 30m
    // tertinggi di antara pool DLMM token itu yang lolos filter di bawah.
    // Kolom max lama diabaikan.
    caCacheSec: Math.max(0, num(e.CA_POOL_CACHE_SEC, 60)),
    // Default untuk baris pool.txt yang hanya berisi alamat.
    // Kuota serentak bukan setting: 1 posisi non-DCA per strategi (spot / bidask) per pool.
    defaultSizeSol: num(e.ENTRY_DEFAULT_SIZE_SOL, 0.1),
    // Entry bidask:double hanya ke pool bin step >= nilai ini. 0 = mati.
    // Spot dan mode lain tidak memakai angka ini. DCA tidak pindah pool.
    bidaskDoubleMinBinStep: Math.max(0, Math.floor(num(e.BIDASK_DOUBLE_MIN_BIN_STEP, 100))),
    // Refresh kandidat (pool list + posisi terbuka via RPC), bukan cadence sinyal.
    scanIntervalSec: num(e.ENTRY_SCAN_INTERVAL_SEC, 15),
    timeframe: e.ENTRY_TIMEFRAME || "15m",
    stAtrPeriod: num(e.ST_ATR_PERIOD, 10),
    stMultiplier: num(e.ST_MULTIPLIER, 3),
    expiryHours: num(e.ENTRY_EXPIRY_HOURS, 24),
    sizeSplit: num(e.ENTRY_SIZE_SPLIT, 0.5),
    // Slippage initialize position (basis poin) — dipakai sebagai acuan lama.
    slippageBps: num(e.ENTRY_SLIPPAGE_BPS, 1000),
    // Slippage aktif bin untuk add-liquidity, dalam PERSEN (SDK memakai persen,
    // bukan basis poin). Menghasilkan maxActiveBinSlippage = ceil(pct / binStep%).
    activeBinSlippagePct: Math.max(0, num(e.ENTRY_ACTIVE_BIN_SLIPPAGE_PCT, 10)),
    // Rem harga: batalkan entry/DCA kalau harga aktif pool menyimpang dari harga
    // pasar (Jupiter) melebihi ambang ini. Gagal ambil harga = lanjut (fail-open).
    poolPriceCheck: bool(e.ENTRY_POOL_PRICE_CHECK, true),
    maxPoolPriceDeviationPct: Math.max(0, num(e.ENTRY_MAX_POOL_PRICE_DEVIATION_PCT, 15)),
    // Toleransi harga aktif pool terhadap garis Supertrend saat entry (persen).
    // Mencegah entry hanya karena harga Jupiter yang turun, sementara pool belum
    // menyentuh garis. Sedikit toleransi menutup pembulatan bin.
    poolLineTolerancePct: Math.max(0, num(e.ENTRY_POOL_LINE_TOLERANCE_PCT, 3)),
    // Saat deviasi di atas ambang, coba ulang (baca ulang harga tiap percobaan).
    poolPriceMaxAttempts: Math.max(1, Math.floor(num(e.ENTRY_POOL_PRICE_MAX_ATTEMPTS, 3))),
    poolPriceRetryDelaySec: Math.max(0, num(e.ENTRY_POOL_PRICE_RETRY_DELAY_SEC, 10)),
    gasReserve: num(e.GAS_RESERVE, 0.05),
    failureCooldownSec: num(e.ENTRY_FAILURE_COOLDOWN_SEC, 300),
    oneShotPerSignal: bool(e.ENTRY_ONE_SHOT_PER_SIGNAL, true),
    maxFailures: num(e.ENTRY_MAX_FAILURES, 3),
    // held_pullback = close harus tetap di atas garis; first_touch = sentuh garis = entry.
    touchMode:
      (e.ENTRY_TOUCH_MODE || "held_pullback").toLowerCase() === "first_touch" ? "first_touch" : "held_pullback",
    // Strategi fee entry. none = perilaku lama + retry; priority = ComputeBudget;
    // jito = tip Jito; both = keduanya. Lihat src/solana/{fees,send,jito}.js.
    fees: {
      mode: normalizeFeeMode(e.ENTRY_FEE_MODE),
      priorityMicroLamports: Math.max(0, num(e.ENTRY_PRIORITY_FEE_MICRO_LAMPORTS, 50000)),
      computeUnitLimit: Math.max(0, num(e.ENTRY_COMPUTE_UNIT_LIMIT, 0)),
      jitoTipSol: Math.max(0, num(e.ENTRY_JITO_TIP_SOL, 0.001)),
      maxSol: Math.max(0, num(e.ENTRY_FEE_MAX_SOL, 0.002)),
      retryAttempts: Math.max(1, Math.floor(num(e.ENTRY_TX_RETRY_ATTEMPTS, 5))),
      confirmTimeoutSec: Math.max(1, num(e.ENTRY_TX_CONFIRM_TIMEOUT_SEC, 30)),
      resendIntervalMs: Math.max(200, num(e.ENTRY_TX_RESEND_INTERVAL_MS, 2000)),
      dualSend: bool(e.ENTRY_DUAL_SEND, true),
      jitoBlockEngineUrl: e.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf",
      jitoTipAccounts:
        e.JITO_TIP_ACCOUNTS != null && e.JITO_TIP_ACCOUNTS !== ""
          ? e.JITO_TIP_ACCOUNTS.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
    },
  };

  // DCA (averaging-down). Mode price (default): arm dari turunnya harga pool
  // vs entryPoolPrice posisi utama. Mode pnl: arm saat PnL <= armPct (perilaku lama).
  const dca = {
    enabled: bool(e.DCA_ENABLED, true),
    triggerMode:
      String(e.DCA_TRIGGER_MODE ?? "price")
        .trim()
        .toLowerCase() === "pnl"
        ? "pnl"
        : "price",
    armPct: num(e.DCA_ARM_PCT, -10),
    // Ambang arm DCA#2 saat DCA#1 SUDAH close (acuan posisi utama). Saat DCA#1
    // masih open, DCA#2 tetap memakai armPct dari posisi DCA#1. Hanya mode pnl.
    armPct2: num(e.DCA_ARM_PCT_2, -30),
    // Mode price: kedua ambang diukur dari entryPoolPrice posisi utama yang sama.
    // DCA#1 saat harga <= armPricePct, DCA#2 saat <= armPricePct2, baik DCA#1
    // masih terbuka maupun sudah close.
    armPricePct: num(e.DCA_ARM_PRICE_PCT, -20),
    armPricePct2: num(e.DCA_ARM_PRICE_PCT_2, -35),
    reboundPct: Math.max(0, num(e.DCA_REBOUND_PCT, 1)),
    maxAdds: Math.max(0, Math.floor(num(e.DCA_MAX_ADDS, 2))),
    // Cross-check harga pool saat arm mode pnl: tahan arm bila PnL <= armPct tapi
    // harga pool tidak turun sepadan. Di mode price pemicu sudah harga pool,
    // jadi cek ini tidak dipakai.
    priceConfirm: bool(e.DCA_PRICE_CONFIRM, true),
    priceFlatPct: num(e.DCA_PRICE_FLAT_PCT, -1),
    // Safeguard: saat DCA terakhir (kuota sesi habis) exit karena trailing TP,
    // posisi asli (non-DCA) di pool yang sama ikut ditutup.
    closeSafeguard: bool(e.DCA_CLOSE_SAFEGUARD, true),
    // Cadence watcher DCA (detik) — scan arm/trail + konfirmasi rebound dari
    // satu request PnL yang sama.
    pollIntervalSec: Math.max(1, num(e.DCA_POLL_INTERVAL_SEC, 5)),
    // Ambang minimum sebelum pending rebound dikonfirmasi (efektif = tick watcher).
    confirmDelaySec: Math.max(0, num(e.DCA_CONFIRM_DELAY_SEC, 5)),
    cooldownSec: Math.max(0, num(e.DCA_COOLDOWN_SEC, 300)),
    // Mode yang boleh di-DCA (dipisah koma). Default: hanya bidask:double.
    eligibleModes:
      e.DCA_ELIGIBLE_MODES != null && e.DCA_ELIGIBLE_MODES !== ""
        ? e.DCA_ELIGIBLE_MODES.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["bidask:double"],
  };

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
    // Swap pasca-close yang gagal → antrean "swap tertunda" (dicoba ulang tiap
    // SWAP_PENDING_RETRY_SEC; pool baru dinonaktifkan setelah swap tuntas/give-up).
    pendingRetrySec: num(e.SWAP_PENDING_RETRY_SEC, 90),
    pendingMaxAttempts: num(e.SWAP_PENDING_MAX_ATTEMPTS, 10),
    // Token tanpa harga: berhenti setelah N kegagalan + alert Telegram.
    unpricedMaxAttempts: num(e.SWAP_UNPRICED_MAX_ATTEMPTS, 3),
  };

  return {
    walletPrivateKey: e.WALLET_PRIVATE_KEY || "",
    rpcUrl:
      e.RPC_URL ||
      (e.HELIUS_API_KEY
        ? `https://rpc.helius.xyz/?api-key=${e.HELIUS_API_KEY}`
        : "https://api.mainnet-beta.solana.com"),
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
    gmgnCentralCollector: bool(e.GMGN_CENTRAL_COLLECTOR, true),
    gmgnKlineCacheFile: e.GMGN_KLINE_CACHE_FILE || "gmgn-kline-cache.json",
    gmgnRateStateFile: e.GMGN_RATE_STATE_FILE || "gmgn-rate-state.json",
    gmgnMaxPerMin: num(e.GMGN_MAX_PER_MIN, 45),
    gmgnMinGapSec: num(e.GMGN_MIN_GAP_SEC, 1.2),
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

    // Ambang span bin minimum untuk mengenali posisi spot-quote.
    spotMinBins: Math.max(1, Math.floor(num(e.SPOT_MIN_BINS, 200))),
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
    spotFallback,
    spotReentry,
    spotRentFallbackPool,
    rebalance,
    spotTokenBidask,
    bidaskDoubleRebalance,

    bidaskDouble,
    bidaskToken,
    bidaskSol,
    spot,

    rulesFor(mode) {
      switch (LEGACY_MODE[mode] || mode) {
        case "bidask:token":
          return this.bidaskToken;
        case "bidask:sol":
          return this.bidaskSol;
        case "spot":
          return this.spot;
        case "bidask:double":
        default:
          return this.bidaskDouble;
      }
    },
  };
}

const config = buildConfig(loadEnv());

export default config;
