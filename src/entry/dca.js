import config from "../config/index.js";
import { LEGACY_MODE } from "../config/rules.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getTrackedPosition, getOpenTrackedPositions, getPoolTrackedPositions } from "../state/positions.js";
import { fetchPoolPnl, pnlFromEntry } from "../meteora/positions.js";
import { loadPoolList } from "./pool-list.js";
import { getPoolInfo } from "./pool-info.js";
import { poolPriceSolPerToken } from "./price-guard.js";
import { readPoolSolPerToken } from "./pool-price.js";
import { executeEntry } from "./execute.js";
import {
  isDcaEligible,
  shouldSkipDcaArm,
  setDcaArmedAndTrough,
  queueDcaRebound,
  resolvePendingDca,
  clearPendingDca,
  markDcaTriggered,
  clearDcaTriggered,
  getPoolDcaCount,
  incrementPoolDca,
  decrementPoolDca,
  evaluateDcaForTrigger,
  dcaMetricMatches,
  clearDcaArmIfMetricMismatch,
  dcaExecutionBlocked,
  mainPositionEntryPoolPrice,
  poolPriceChangePct,
} from "../state/dca.js";
import {
  isEntryInProgressPool,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  addEntryInProgressMint,
  removeEntryInProgressMint,
  isPoolClosing,
  getDcaCooldownUntil,
  setDcaCooldown,
  recordAction,
  getPoolAlias,
} from "./runtime.js";

// DCA hanya untuk mode yang terdaftar di config.dca.eligibleModes (default
// bidask:double). Label mode lama dinormalkan lewat LEGACY_MODE.
export function isDcaModeEligible(mode) {
  const normalized = LEGACY_MODE[mode] || mode;
  return (config.dca.eligibleModes || []).includes(normalized);
}

// Satu-satunya predikat "DCA berlaku untuk posisi ini": fitur aktif + mode eligible.
// Dipakai watcher DCA dan ringkasan status (spot tidak pernah DCA).
export function isDcaApplicable(tracked, cfg = config.dca) {
  return Boolean(cfg?.enabled) && Boolean(tracked) && isDcaModeEligible(tracked.mode);
}

const pnlFallbackLogged = new Set();

// Dipanggil tiap tick watcher DCA. Mode pnl: satu request PnL per pool.
// Mode price: satu baca harga bin aktif per pool (bukan PnL), dipakai bersama
// semua posisi di pool itu. Posisi diambil dari state.
export async function tickDca() {
  const cfg = config.dca;
  if (!cfg.enabled) return;

  const open = getOpenTrackedPositions().filter((t) => t && t.position && t.pool && isDcaApplicable(t, cfg));
  if (open.length === 0) return;

  const byPool = new Map();
  for (const t of open) {
    if (!byPool.has(t.pool)) byPool.set(t.pool, []);
    byPool.get(t.pool).push(t);
  }

  for (const [pool, list] of byPool) {
    const count = getPoolDcaCount(pool);
    const dcaOpen = list.some((t) => t.isDca === true);
    const ref = cfg.triggerMode === "price" ? mainPositionEntryPoolPrice(getPoolTrackedPositions(pool)) : null;

    let nowPrice = null;
    if (cfg.triggerMode === "price" && ref) {
      try {
        nowPrice = await readPoolSolPerToken(pool);
      } catch (err) {
        log.debug(`[detail] DCA ${pool.slice(0, 8)}: harga pool gagal dibaca (${err.message}) — tick dilewati`);
        continue;
      }
      if (poolPriceChangePct(ref.entryPoolPrice, nowPrice) == null) {
        log.debug(`[detail] DCA ${pool.slice(0, 8)}: harga pool kosong — tick dilewati`);
        continue;
      }
      pnlFallbackLogged.delete(pool);
    } else if (cfg.triggerMode === "price") {
      if (!pnlFallbackLogged.has(pool)) {
        pnlFallbackLogged.add(pool);
        const name = list[0]?.pair || pool.slice(0, 8);
        log.warn(`${name}: DCA harga tidak bisa — posisi utama tanpa entryPoolPrice, pool ini pakai PnL`);
      }
    }

    const usingPrice = cfg.triggerMode === "price" && ref && poolPriceChangePct(ref.entryPoolPrice, nowPrice) != null;
    const metricMode = usingPrice ? "price" : "pnl";
    const pnlMap = usingPrice ? null : await fetchPoolPnl(pool, { force: true, ttlSec: cfg.pollIntervalSec });
    const now = Date.now();

    for (let tracked of list) {
      const entry = pnlMap ? pnlMap.get(tracked.position) : null;
      const pnlPct = entry ? pnlFromEntry(entry) : null;
      const pairLabel = tracked.pair || tracked.position.slice(0, 8);
      const metric = usingPrice ? poolPriceChangePct(ref.entryPoolPrice, nowPrice) : pnlPct;

      if (metric == null) {
        if (tracked.pendingDcaTrough != null) clearPendingDca(tracked.position);
        continue;
      }

      if (!dcaMetricMatches(tracked, metricMode)) {
        clearDcaArmIfMetricMismatch(tracked.position, metricMode);
        tracked = getTrackedPosition(tracked.position) || tracked;
      }

      const pos = {
        position: tracked.position,
        pool,
        pair: tracked.pair,
        pnlPct,
        entryPoolPrice: ref?.entryPoolPrice ?? null,
        nowPrice: usingPrice ? nowPrice : null,
        metricMode: cfg.triggerMode,
        metricKind: metricMode,
        dcaCount: count,
        dcaOpen,
      };

      // Konfirmasi rebound pending setelah lewat confirmDelaySec.
      // Ditunda bila pool sedang di-rebalance / entry / close, supaya pending
      // tidak habis dikonsumsi saat eksekusi belum boleh jalan.
      if (tracked.pendingDcaTrough != null) {
        const block = dcaExecutionBlocked({
          entryInProgress: isEntryInProgressPool(pool),
          poolClosing: isPoolClosing(pool),
        });
        if (block.blocked) {
          log.debug(`[detail] ${pairLabel}: konfirmasi DCA ditunda (${block.reason})`);
          continue;
        }
        const waitedSec = (now - (tracked.pendingDcaStartedAt || 0)) / 1000;
        if (waitedSec >= cfg.confirmDelaySec) {
          const resolved = resolvePendingDca(tracked.position, metric, cfg.reboundPct);
          if (resolved.confirmed) {
            const fresh = getTrackedPosition(tracked.position);
            const started = maybeStartDca({ ...pos, pnlPct: metric }, fresh, pairLabel);
            // Rebalance/entry memegang kunci pool: jangan buang konfirmasi.
            if (
              !started &&
              dcaExecutionBlocked({
                entryInProgress: isEntryInProgressPool(pool),
                poolClosing: isPoolClosing(pool),
              }).blocked
            ) {
              queueDcaRebound(tracked.position, resolved.trough, resolved.current);
              log.debug(`[detail] ${pairLabel}: eksekusi DCA ditunda — pool sedang dipakai`);
            }
          } else if (resolved.rejected) {
            log.debug(`[detail] ${pairLabel}: DCA rebound ditolak (balik ke trough)`);
          }
        }
        continue;
      }

      await processDca(pos, tracked, pairLabel, cfg);
    }
  }
}

// Watcher DCA: cadence sendiri (DCA_POLL_INTERVAL_SEC), terpisah dari loop
// exit 12s. Tidak menyentuh RPC/pnl-history, hanya PnL datapi yang di-cache
// dan dipakai bersama exit loop.
export function startDcaWatcher() {
  const cfg = config.dca;
  if (!cfg.enabled) return null;
  const sec = Math.max(1, Number(cfg.pollIntervalSec) || 5);

  const armLabel =
    cfg.triggerMode === "price"
      ? `harga ${cfg.armPricePct}%/${cfg.armPricePct2}% dari entry utama`
      : `PnL ${cfg.armPct}%/${cfg.armPct2}%`;
  log.info(
    `DCA watcher started — mode ${cfg.triggerMode} | poll ${sec}s | arm ${armLabel} | rebound ${cfg.reboundPct}pt | konfirmasi ${cfg.confirmDelaySec}s | max ${cfg.maxAdds}/sesi`
  );

  tickDca().catch((e) => log.error(`DCA watcher error: ${e.message}`));
  const timer = setInterval(() => {
    tickDca().catch((e) => log.error(`DCA watcher error: ${e.message}`));
  }, sec * 1000);

  return { timer };
}

// Cross-check harga pool sebelum arm: tolak spike PnL palsu yang tidak diikuti
// penurunan harga pool. Fail-open bila data tidak tersedia.
async function priceConfirmsDcaArm(pos, tracked) {
  const cfg = config.dca;
  if (!cfg.priceConfirm) return true;
  const entryPrice = Number(tracked.entryPoolPrice);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return true;
  try {
    const { pool, baseIsX } = await getPoolInfo(pos.pool);
    const activeBin = await pool.getActiveBin();
    const nowPrice = poolPriceSolPerToken(activeBin, baseIsX);
    if (nowPrice == null) return true;
    const priceChangePct = (nowPrice / entryPrice - 1) * 100;
    if (shouldSkipDcaArm({ priceChangePct, flatPct: cfg.priceFlatPct })) {
      log.warn(
        `DCA ${pos.pair || pos.pool.slice(0, 8)}: arm ditahan — PnL ${pos.pnlPct.toFixed(2)}% tapi harga pool hanya ${priceChangePct.toFixed(2)}% dari entry (batas ${cfg.priceFlatPct}%)`
      );
      return false;
    }
    return true;
  } catch (err) {
    log.debug(`[detail] DCA price-confirm gagal (fail-open): ${err.message}`);
    return true;
  }
}

// Arm / trail / queue rebound. Metrik (harga atau PnL) dipilih evaluateDcaForTrigger.
export async function processDca(pos, tracked, pairLabel, cfgOverride) {
  const cfg = cfgOverride || config.dca;
  if (!cfg.enabled || !pos?.position) return;

  tracked = getTrackedPosition(pos.position);
  if (!isDcaEligible(tracked)) return;
  if (!isDcaModeEligible(tracked.mode)) return;
  // Konfirmasi sedang berjalan — diselesaikan tick berikutnya.
  if (tracked.pendingDcaTrough != null) return;

  const decision = evaluateDcaForTrigger({
    triggerMode: pos.metricMode ?? cfg.triggerMode,
    entryPoolPrice: pos.entryPoolPrice,
    nowPrice: pos.nowPrice,
    pnlPct: pos.pnlPct,
    count: pos.dcaCount ?? 0,
    dcaOpen: pos.dcaOpen === true,
    cfg,
    tracked,
  });
  if (decision.skip) return;

  const kind = decision.mode === "price" ? "harga" : "PnL";
  switch (decision.action) {
    case "arm":
      if (decision.priceConfirm && !(await priceConfirmsDcaArm({ ...pos, pnlPct: pos.pnlPct }, tracked))) break;
      setDcaArmedAndTrough(pos.position, decision.trough, decision.mode);
      log.debug(`[detail] ${pairLabel}: DCA armed @ ${kind} ${decision.trough.toFixed(2)}% (trough awal)`);
      break;
    case "trail":
      setDcaArmedAndTrough(pos.position, decision.trough, decision.mode);
      break;
    case "queue_rebound": {
      const block = dcaExecutionBlocked({
        entryInProgress: isEntryInProgressPool(pos.pool),
        poolClosing: isPoolClosing(pos.pool),
      });
      if (block.blocked) {
        log.debug(`[detail] ${pairLabel}: rebound DCA ditahan (${block.reason})`);
        break;
      }
      queueDcaRebound(pos.position, decision.trough, decision.current);
      log.debug(
        `[detail] ${pairLabel}: DCA rebound ${decision.rebound.toFixed(2)}pt ${kind} dari trough ${decision.trough.toFixed(2)}% → konfirmasi ${cfg.confirmDelaySec}s`
      );
      break;
    }
    default:
      break;
  }
}

// Eksekusi DCA. Guard + reservasi sinkron, eksekusi async (fire-and-forget).
export function maybeStartDca(pos, tracked, pairLabel) {
  const cfg = config.dca;
  if (!cfg.enabled || !pos?.position || !pos?.pool || pos.pnlPct == null) return false;
  if (!isDcaEligible(tracked)) return false;
  if (!isDcaModeEligible(tracked.mode)) return false;
  const block = dcaExecutionBlocked({
    entryInProgress: isEntryInProgressPool(pos.pool),
    poolClosing: isPoolClosing(pos.pool),
  });
  if (block.blocked) return false;
  if (Date.now() < getDcaCooldownUntil(pos.pool)) return false;
  if (getPoolDcaCount(pos.pool) >= cfg.maxAdds) {
    log.debug(`[detail] Pool ${pos.pool.slice(0, 8)} DCA quota sesi tercapai (${cfg.maxAdds}) — skip`);
    return false;
  }

  const alias = getPoolAlias(pos.pool);
  const entry = loadPoolList().find((x) => x.pool === pos.pool || (alias && x.ca && x.pool === alias));
  if (!entry || !(entry.sizeSol > 0)) {
    log.warn(`Pool ${pos.pool.slice(0, 8)} DCA skip: entry_size tidak ditemukan di pool.txt`);
    return false;
  }

  const pair = pos.pair || pairLabel || pos.pool.slice(0, 8);

  // Reservasi sinkron: cegah posisi lain di pool sama memicu DCA bersamaan.
  // Counter sesi dinaikkan sebelum eksekusi agar tahan crash/restart.
  const dcaMint = tracked?.baseMint || null;
  markDcaTriggered(pos.position);
  incrementPoolDca(pos.pool);
  addEntryInProgressPool(pos.pool);
  if (dcaMint) addEntryInProgressMint(dcaMint);

  const kind = pos.metricKind === "price" ? "harga" : "PnL";
  log.debug(
    `[detail] Pool ${pos.pool.slice(0, 8)} DCA: ${kind} ${pos.pnlPct.toFixed(2)}% → entry baru ${entry.sizeSol} SOL (${pair})`
  );

  if (config.dryRun) {
    log.info(`[DRY RUN] Akan DCA ${pair} — ${entry.sizeSol} SOL`);
    removeEntryInProgressPool(pos.pool);
    if (dcaMint) removeEntryInProgressMint(dcaMint);
    return true;
  }

  // Tetap di pool posisi yang sudah terbuka. Kunci bin step hanya untuk entry baru.
  executeEntry(pos.pool, { direction: "bullish", line: null, price: null, touchType: "dca" }, entry.sizeSol, {
    countUsage: false,
    isDca: true,
  })
    .then((result) => {
      if (result.success) {
        log.info(`📉 DCA ${pair} — posisi turun lalu memantul → tambah ${entry.sizeSol} SOL`);
        log.debug(`[detail] DCA position ${result.position} | tx ${result.tx?.slice(0, 16) || "-"}`);
        recordAction(`DCA ${pair} — tambah ${entry.sizeSol} SOL`);
        tg.notifyDca({ pair, pool: pos.pool, pnlPct: pos.pnlPct, sizeSol: entry.sizeSol, trigger: kind });
        return;
      }
      // Rem harga kehabisan percobaan: hentikan DCA untuk posisi ini saja
      // (biarkan dcaTriggered=true), kembalikan kuota sesi. Pool TIDAK
      // dinonaktifkan; exit posisi terbuka tetap jalan lewat state.
      if (result.skipped && result.exhausted) {
        decrementPoolDca(pos.pool);
        log.warn(`DCA ${pair} dihentikan: ${result.reason || "harga pool menyimpang"} — DCA posisi ini tidak dilanjut`);
        tg.notifyError(`DCA ${pair} dihentikan: ${result.reason || "harga pool menyimpang"}`);
        return;
      }
      if (result.skipped) {
        clearDcaTriggered(pos.position);
        decrementPoolDca(pos.pool);
        log.warn(`DCA ${pair} dilewati: ${result.reason || "harga pool menyimpang"}`);
        return;
      }
      log.warn(`DCA failed for ${pos.pool.slice(0, 8)}: ${result.error}`);
      clearDcaTriggered(pos.position);
      decrementPoolDca(pos.pool);
      setDcaCooldown(pos.pool, cfg.cooldownSec * 1000);
      tg.notifyError(`DCA failed ${pair}: ${result.error}`);
    })
    .catch((err) => {
      log.error(`DCA error for ${pos.pool.slice(0, 8)}: ${err.message}`);
      clearDcaTriggered(pos.position);
      decrementPoolDca(pos.pool);
      setDcaCooldown(pos.pool, cfg.cooldownSec * 1000);
    })
    .finally(() => {
      removeEntryInProgressPool(pos.pool);
      if (dcaMint) removeEntryInProgressMint(dcaMint);
    });

  return true;
}
