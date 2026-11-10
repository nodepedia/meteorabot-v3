import config from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getOpenTrackedPositions } from "../state/positions.js";
import { loadPoolList, commentPoolInList } from "./pool-list.js";
import { getPoolInfo, pairNameCache } from "./pool-info.js";
import { watchPrices, getLastPrices } from "./price-watch.js";
import { getSupertrend, getSupertrendFallback } from "../market/supertrend-state.js";
import { executeEntry, executeSpotEntry } from "./execute.js";
import {
  selectWatchCandidates,
  strategyOfMode,
  quotaKey,
  isQuotaFull,
  mintBlocksEntry,
  poolKeysToReset,
} from "./candidates.js";
import { resolveCaPool, shouldLogCaSkip, markCaPoolInvalid } from "./ca-resolve.js";
import {
  addEntryInProgressMint,
  removeEntryInProgressMint,
  isEntryInProgressMint,
  addEntryInProgressPool,
  removeEntryInProgressPool,
  isPoolClosing,
  isPoolSwapPending,
  isMintSwapPending,
  isMintClosing,
  getEntryInProgressPools,
  setPoolAlias,
  getPoolAlias,
  getPoolAliases,
  clearPoolAliasesFor,
  setWatchSnapshot,
  getSharedWatchSnapshot,
} from "./runtime.js";

export { getPoolNames } from "./pool-info.js";
export { selectWatchCandidates } from "./candidates.js";

// Ringkasan pool yang sedang dipantau untuk log naratif (tanpa I/O).
function buildLocalWatchSnapshot() {
  const prices = getLastPrices();
  return candidateCache.map((c) => {
    const st = getSupertrend(c.mint) || getSupertrendFallback(c.mint);
    const price = prices.get(c.mint);
    return {
      pool: c.pool,
      pairName: c.pairName || pairNameCache.get(c.pool) || null,
      mint: c.mint,
      sizeSol: c.sizeSol,
      trend: st ? st.direction : null,
      line: st ? st.line : null,
      price: Number.isFinite(price) ? price : null,
    };
  });
}

export function getWatchSnapshot() {
  if (candidateCache.length > 0) return buildLocalWatchSnapshot();
  return getSharedWatchSnapshot();
}

// Runtime-only state (resets on restart, as designed)
const firstSeenAt = new Map();
const skipped = new Set();
const dryRunNoted = new Set();
const failureCooldownUntil = new Map();
const failureCounts = new Map();
// Mode default bila baris pool.txt tidak menulis mode.
const ENTRY_MODE = "bidask:double";
// Lock tx bersama DCA/exit (kunci = alamat pool) plus lock kuota entry
// (kunci = pool|strategi). Lihat isEntryInProgressPool.
const inFlightPools = getEntryInProgressPools();
// Kunci = pool|strategi → waktu entry strategi itu selesai / posisi masih terbuka.
const enteredPools = new Map();
// Id baris pool.txt yang aktif pada refresh sebelumnya. Dipakai agar `#` yang
// dihapus saat proses jalan membersihkan gate memori (cooldown, expiry, skipped).
let activeLineIds = new Set();
// Pool yang baru dinonaktifkan di siklus refresh ini, supaya baris strategi lain
// di pool yang sama tidak ikut masuk di sisa siklus.
const heldThisRefresh = new Set();

// Kandidat dari refresh lambat; dibaca oleh poll harga cepat.
let candidateCache = [];
let _refreshBusy = false;
let _watchBusy = false;

function clearInMemoryGate(pool) {
  if (!pool) return;
  const keys = new Set([pool]);
  for (const [resolved, ca] of Object.entries(getPoolAliases())) {
    if (resolved === pool || ca === pool) {
      keys.add(resolved);
      keys.add(ca);
    }
  }
  for (const key of keys) {
    skipped.delete(key);
    failureCounts.delete(key);
    failureCooldownUntil.delete(key);
    dryRunNoted.delete(key);
    firstSeenAt.delete(key);
    enteredPools.delete(key);
    enteredPools.delete(quotaKey(key, "spot"));
    enteredPools.delete(quotaKey(key, "bidask"));
  }
}

function isStrategySlotBusy(pool, mint, strategy) {
  const key = quotaKey(pool, strategy);
  if (inFlightPools.has(pool) || inFlightPools.has(key)) return true;
  if (isPoolClosing(pool) || isPoolSwapPending(pool) || isMintSwapPending(mint)) return true;
  if (enteredPools.has(key)) return true;
  if (isEntryInProgressMint(mint) || isMintClosing(mint)) return true;
  if (mintBlocksEntry(getOpenTrackedPositions(), { pool, mint, strategy }).block) return true;
  return false;
}

// Matikan pool secara persisten: beri `#` di pool.txt + hentikan pemantauan
// in-process seketika (poll harga cepat tidak mengecek `skipped`). Hapus `#`
// secara manual untuk mengaktifkan kembali — refresh berikutnya mengangkat
// gate memori (cooldown, timer expiry, skipped) tanpa restart.
export function deactivatePool(pool, reason) {
  if (!pool) return false;
  // Dry run tidak boleh mengubah pool.txt; cukup skip runtime.
  if (config.dryRun) {
    skipped.add(pool);
    heldThisRefresh.add(pool);
    return false;
  }
  candidateCache = candidateCache.filter((c) => c.pool !== pool);
  failureCounts.delete(pool);
  failureCooldownUntil.delete(pool);
  dryRunNoted.delete(pool);
  const alias = getPoolAlias(pool);
  heldThisRefresh.add(pool);
  if (alias) heldThisRefresh.add(alias);
  if (commentPoolInList(pool, alias)) {
    clearInMemoryGate(pool);
    if (alias) clearPoolAliasesFor(alias);
    log.info(
      `Pool ${pool.slice(0, 8)} ditandai '#' di ${config.entry.poolListFile}${reason ? ` (${reason})` : ""} — hapus '#' untuk memantau lagi`
    );
    return true;
  }
  skipped.add(pool);
  log.warn(`Pool ${pool.slice(0, 8)} gagal ditandai di ${config.entry.poolListFile} — skip sampai restart`);
  return false;
}

// Refresh lambat: pool list, expiry, kuota serentak (dari state), dan pool info.
// Hanya fungsi ini yang menyentuh RPC, sehingga aman dijalankan sesekali.
export async function refreshCandidates() {
  if (!config.entry.enabled) return null;
  if (_refreshBusy) return null;
  _refreshBusy = true;
  const refreshStartedAt = Date.now();

  try {
    heldThisRefresh.clear();
    const pools = loadPoolList();
    const reactivated = poolKeysToReset(activeLineIds, pools);
    activeLineIds = reactivated.ids;
    // Baris yang baru aktif lagi (pengguna menghapus `#`) tidak boleh tertahan
    // gate memori dari siklus sebelumnya.
    for (const key of reactivated.resetKeys) clearInMemoryGate(key);

    if (pools.length === 0) {
      candidateCache = [];
      setWatchSnapshot([]);
      return null;
    }

    // Kuota = 1 posisi non-DCA per (pool, strategi). DCA tidak dihitung.
    // bidask:double / token / sol berbagi slot bidask. Spot punya slot sendiri,
    // jadi satu spot + satu bidask boleh terbuka di pool yang sama.
    const openPositions = getOpenTrackedPositions();
    const seenMintPool = new Map();
    const now = Date.now();
    const candidates = [];
    const stillOpen = new Set();

    for (const { pool: lineKey, sizeSol, mode = ENTRY_MODE, ca = false } of pools) {
      // lineKey = kolom pertama baris pool.txt (alamat pool, atau CA untuk baris `,ca`).
      let poolAddress = lineKey;
      const strategy = strategyOfMode(mode);
      if (!strategy) continue;
      if (skipped.has(poolAddress) || heldThisRefresh.has(poolAddress)) continue;

      const cooldownUntil = failureCooldownUntil.get(poolAddress) || 0;
      if (now < cooldownUntil) continue;

      if (!firstSeenAt.has(poolAddress)) firstSeenAt.set(poolAddress, now);
      const ageHours = (now - firstSeenAt.get(poolAddress)) / 3_600_000;
      if (ageHours >= config.entry.expiryHours) {
        log.warn(
          `Pool ${poolAddress.slice(0, 8)} expired after ${config.entry.expiryHours}h without entry — dinonaktifkan`
        );
        tg.notifyPoolExpired({
          pool: poolAddress,
          pair: pairNameCache.get(poolAddress) || null,
          expiryHours: config.entry.expiryHours,
        });
        deactivatePool(poolAddress, "expired tanpa entry");
        continue;
      }

      if (ca) {
        if (isEntryInProgressMint(lineKey) || isMintClosing(lineKey)) continue;
        // Strategi yang sama sudah terbuka di mint ini: tunggu, jangan '#' baris CA.
        const sameStrategyOpen = openPositions.some(
          (p) =>
            p && p.closed !== true && p.baseMint === lineKey && p.isDca !== true && strategyOfMode(p.mode) === strategy
        );
        if (sameStrategyOpen) continue;
        const r = await resolveCaPool(lineKey);
        if (!r.pool) {
          if (shouldLogCaSkip(lineKey, now))
            log.info(`CA ${lineKey.slice(0, 8)} skip: ${r.reason} (log berikutnya ≥10 menit lagi)`);
          continue;
        }
        poolAddress = r.pool;
        if (
          skipped.has(poolAddress) ||
          heldThisRefresh.has(poolAddress) ||
          now < (failureCooldownUntil.get(poolAddress) || 0)
        ) {
          continue;
        }
        // Simpan pool hasil resolve → CA, supaya '#'/exit/re-entry ikut baris CA.
        if (getPoolAlias(poolAddress) !== lineKey) setPoolAlias(poolAddress, lineKey);
        log.info(`CA ${lineKey.slice(0, 8)} → pool ${poolAddress.slice(0, 8)} (fee/active TVL 30m ${r.ratio}%)`);
      }

      const slotKey = quotaKey(poolAddress, strategy);
      if (isQuotaFull(openPositions, poolAddress, strategy)) {
        stillOpen.add(slotKey);
        continue;
      }
      // Tx strategi ini sedang berjalan, atau pool dikunci DCA/exit/reentry.
      if (inFlightPools.has(slotKey) || inFlightPools.has(poolAddress)) {
        if (inFlightPools.has(slotKey)) stillOpen.add(slotKey);
        continue;
      }

      let info;
      try {
        info = await getPoolInfo(poolAddress);
      } catch (err) {
        log.warn(`Pool ${poolAddress.slice(0, 8)} lookup failed: ${err.message}`);
        // CA: pool non-DLMM / akun rusak — jangan dipilih lagi di siklus berikutnya.
        if (ca) markCaPoolInvalid(poolAddress, err.message);
        continue;
      }
      if (info.unsupported) {
        const quoteLabel = info.quoteMint || `${info.xMint?.slice(0, 4) || "?"}/${info.yMint?.slice(0, 4) || "?"}`;
        log.warn(
          `Pool ${poolAddress.slice(0, 8)} rejected: pair bukan SOL (${info.pairName || poolAddress} | quote ${quoteLabel})`
        );
        tg.notifyPoolUnsupported({ pool: poolAddress, pair: info.pairName, quoteMint: quoteLabel });
        deactivatePool(poolAddress, "pair bukan SOL");
        continue;
      }
      if (!info.baseMint) {
        log.warn(`Pool ${poolAddress.slice(0, 8)} has no base mint — skip`);
        continue;
      }

      // Pool lain pada mint yang sama tetap dilarang. Strategi lain di pool ini
      // (spot vs bidask) tidak dilarang — itu kuota terpisah.
      const mintBlock = mintBlocksEntry(openPositions, {
        pool: poolAddress,
        mint: info.baseMint,
        strategy,
      });
      if (mintBlock.otherPool) {
        if (ca) continue;
        log.info(
          `Pool ${poolAddress.slice(0, 8)} (${info.pairName || info.baseMint.slice(0, 8)}) dilewati — token sudah punya posisi aktif di pool lain`
        );
        deactivatePool(poolAddress, "token sudah punya posisi aktif di pool lain");
        continue;
      }
      if (mintBlock.sameStrategy) {
        stillOpen.add(slotKey);
        continue;
      }
      if (isEntryInProgressMint(info.baseMint) || isMintClosing(info.baseMint)) continue;
      const claimedPool = seenMintPool.get(info.baseMint);
      if (claimedPool && claimedPool !== poolAddress) continue;
      seenMintPool.set(info.baseMint, poolAddress);

      if (mode === "spot") {
        startSpotEntry({
          pool: poolAddress,
          mint: info.baseMint,
          sizeSol,
          pairName: info.pairName,
          mode: "spot",
          strategy: "spot",
        });
        continue;
      }

      candidates.push({
        pool: poolAddress,
        mint: info.baseMint,
        sizeSol,
        pairName: info.pairName,
        mode,
        strategy,
      });
    }

    // Sinkronkan enteredPools per (pool, strategi). Pertahankan entry yang
    // selesai setelah refresh ini mulai (belum sempat terlihat di state).
    for (const key of stillOpen) {
      if (!enteredPools.has(key)) enteredPools.set(key, 0);
    }
    for (const [key, at] of enteredPools) {
      if (stillOpen.has(key)) continue;
      if (at >= refreshStartedAt) continue;
      enteredPools.delete(key);
    }

    candidateCache = candidates;
    setWatchSnapshot(buildLocalWatchSnapshot());
    return candidates;
  } catch (err) {
    log.error(`refreshCandidates failed: ${err.message}`);
    return null;
  } finally {
    _refreshBusy = false;
  }
}

// Poll harga cepat: hanya baca kandidat + state Supertrend, lalu satu request
// batch Jupiter. Tidak ada RPC di jalur ini.
export async function watchAndEnter() {
  if (!config.entry.enabled) return null;
  if (_watchBusy) return null;
  if (candidateCache.length === 0) return null;
  _watchBusy = true;

  try {
    const watchable = selectWatchCandidates(candidateCache, {
      inFlight: inFlightPools,
      entered: enteredPools,
      cooldowns: failureCooldownUntil,
      now: Date.now(),
    });
    if (watchable.length === 0) return null;

    const byPool = new Map(watchable.map((c) => [c.pool, c]));
    const { triggered } = await watchPrices(watchable.map((c) => ({ pool: c.pool, mint: c.mint })));
    setWatchSnapshot(buildLocalWatchSnapshot());

    for (const t of triggered) {
      const c = byPool.get(t.pool);
      if (c) startEntry(t, c);
    }

    return triggered.length > 0 ? triggered : null;
  } catch (err) {
    log.error(`watchAndEnter failed: ${err.message}`);
    return null;
  } finally {
    _watchBusy = false;
  }
}

// Jalankan entry tanpa memblokir poll harga berikutnya. Guard in-flight/entered
// mencegah retrigger selama swap/tx (10-30s) saat harga masih <= garis.
function startEntry(trigger, candidate) {
  const { pool, mint, sizeSol, pairName } = candidate;
  const strategy = candidate.strategy || strategyOfMode(candidate.mode) || "bidask";
  if (isStrategySlotBusy(pool, mint, strategy)) return;

  const pair = pairName || `${mint.slice(0, 4)}-SOL`;
  log.info(
    `Pool ${pool.slice(0, 8)} touch: bullish line ${trigger.line} | harga ${trigger.price} — entry (first_touch)`
  );

  if (config.dryRun) {
    if (!dryRunNoted.has(pool)) {
      dryRunNoted.add(pool);
      log.info(`[DRY RUN] Would enter ${pair} — ${sizeSol} SOL split ${config.entry.sizeSplit}`);
    }
    return;
  }

  const slotKey = quotaKey(pool, strategy);
  addEntryInProgressPool(slotKey);
  addEntryInProgressMint(mint);

  executeEntry(
    pool,
    {
      direction: trigger.direction,
      line: trigger.line,
      price: trigger.price,
      solPrice: trigger.solPrice,
      touchType: "price",
    },
    sizeSol
  )
    .then((result) => {
      if (result.success) {
        enteredPools.set(slotKey, Date.now());
        firstSeenAt.delete(pool);
        const alias = getPoolAlias(pool);
        if (alias) firstSeenAt.delete(alias);
        failureCooldownUntil.delete(pool);
        failureCounts.delete(pool);
        return;
      }

      // Rem harga kehabisan percobaan (harga pool meleset terus): batalkan dan
      // nonaktifkan pool (beri '#' di pool.txt) — bukan dihitung gagal biasa.
      if (result.skipped && result.exhausted) {
        log.warn(`Pool ${pool.slice(0, 8)} dibatalkan: ${result.reason || "harga pool menyimpang"} — dinonaktifkan`);
        deactivatePool(pool, "harga pool meleset terus");
        tg.notifyEntryAborted({
          pool,
          pair: pairName,
          attempts: result.attempts || config.entry.poolPriceMaxAttempts,
          error: result.reason || "harga pool menyimpang",
        });
        return;
      }
      if (result.skipped) {
        log.warn(`Pool ${pool.slice(0, 8)} dilewati: ${result.reason || "harga pool menyimpang"}`);
        return;
      }

      log.warn(`Entry failed for ${pool.slice(0, 8)}: ${result.error}`);
      const rateLimited = !!result.rateLimited;
      const failures = (failureCounts.get(pool) || 0) + 1;
      failureCounts.set(pool, failures);
      if (failures >= config.entry.maxFailures) {
        deactivatePool(pool, `gagal entry ${failures}x`);
        log.error(`Pool ${pool.slice(0, 8)} aborted after ${failures} failed entries — dinonaktifkan`);
        if (rateLimited) {
          tg.notifyEntryRateLimited({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec: 0,
          });
        } else {
          tg.notifyEntryAborted({
            pool,
            pair: pairName,
            attempts: failures,
            error: result.error,
          });
        }
      } else {
        const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
        const cooldownMs = cooldownSec * 1000;
        if (cooldownMs > 0) {
          failureCooldownUntil.set(pool, Date.now() + cooldownMs);
          log.info(
            `Pool ${pool.slice(0, 8)} cooldown ${config.entry.failureCooldownSec}s after failed entry (${failures}/${config.entry.maxFailures})`
          );
        }
        if (rateLimited) {
          tg.notifyEntryRateLimited({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec,
          });
        } else {
          tg.notifyEntryFailed({
            pool,
            pair: pairName,
            error: result.error,
            attempts: failures,
            maxFailures: config.entry.maxFailures,
            cooldownSec,
          });
        }
      }
    })
    .catch((err) => log.error(`Entry error for ${pool.slice(0, 8)}: ${err.message}`))
    .finally(() => {
      removeEntryInProgressPool(slotKey);
      removeEntryInProgressMint(mint);
    });
}

// Satu alert sewa per pool per proses, supaya gagal tulis daftar tidak memicu spam.
const rentRedflagAlerted = new Set();

export function resetSpotRentRedflagAlerts() {
  rentRedflagAlerted.clear();
}

function alertSpotRentRedflag(payload, notifyFn) {
  const pool = payload?.pool;
  if (pool && rentRedflagAlerted.has(pool)) return;
  if (pool) rentRedflagAlerted.add(pool);
  try {
    const pending = notifyFn(payload);
    Promise.resolve(pending).catch((err) => {
      log.warn(`Alert sewa non-refundable gagal dikirim: ${err.message}`);
    });
  } catch (err) {
    log.warn(`Alert sewa non-refundable gagal dikirim: ${err.message}`);
  }
}

// Entry instan untuk pool mode="spot" (Runner Spot): langsung eksekusi saat refreshCandidates
// tanpa menunggu sinyal Supertrend 15m.
export function startSpotEntry(candidate, executeSpotEntryFn = executeSpotEntry, deps = {}) {
  const { pool, mint, sizeSol, pairName } = candidate;
  const strategy = "spot";
  if (isStrategySlotBusy(pool, mint, strategy)) return null;

  const pair = pairName || `${mint.slice(0, 4)}-SOL`;
  log.info(`Pool ${pool.slice(0, 8)} (${pair}) mode=spot — entry instan tanpa tunggu Supertrend (${sizeSol} SOL)`);

  if (config.dryRun) {
    if (!dryRunNoted.has(pool)) {
      dryRunNoted.add(pool);
      log.info(`[DRY RUN] Would enter SPOT ${pair} immediately — ${sizeSol} SOL (-95/-90/-85/-80%..+15% SOL 1-sisi)`);
    }
    return null;
  }

  const slotKey = quotaKey(pool, strategy);
  addEntryInProgressPool(slotKey);
  addEntryInProgressMint(mint);

  return executeSpotEntryFn(pool, sizeSol)
    .then((result) => {
      if (result.success) {
        enteredPools.set(slotKey, Date.now());
        firstSeenAt.delete(pool);
        const alias = getPoolAlias(pool);
        if (alias) firstSeenAt.delete(alias);
        failureCooldownUntil.delete(pool);
        failureCounts.delete(pool);
        return result;
      }

      if (result.skipped && result.redflagNonRefundable) {
        log.warn(
          `Pool ${pool.slice(0, 8)} (${pair}) REDFLAG non-refundable rent pada tangga -95/-90/-85/-80% — skip & nonaktifkan pool`
        );
        let watchDisabled = false;
        try {
          watchDisabled = deactivatePool(pool, "redflag non-refundable rent (-95/-90/-85/-80%)") === true;
        } catch (err) {
          log.warn(`Pool ${pool.slice(0, 8)} gagal dinonaktifkan: ${err.message}`);
        }
        alertSpotRentRedflag(
          {
            pool,
            pair: result.pair || pair,
            costsByPct: result.costsByPct,
            cost95Sol: result.cost95Sol,
            cost90Sol: result.cost90Sol,
            upperPct: result.upperPct,
            maxNonRefundableSol: result.maxNonRefundableSol,
            sizeSol,
            reason: result.reason,
            context: "Entry Spot Instan",
            watchDisabled,
          },
          deps.notifySpotNonRefundableSkipped || tg.notifySpotNonRefundableSkipped
        );
        return result;
      }

      if (result.skipped) {
        log.warn(`Pool ${pool.slice(0, 8)} dilewati: ${result.reason || "spot entry skipped"}`);
        return result;
      }

      log.warn(`Spot entry failed for ${pool.slice(0, 8)}: ${result.error}`);
      const failures = (failureCounts.get(pool) || 0) + 1;
      failureCounts.set(pool, failures);
      if (failures >= config.entry.maxFailures) {
        deactivatePool(pool, `gagal spot entry ${failures}x`);
        log.error(`Pool ${pool.slice(0, 8)} aborted after ${failures} failed spot entries — dinonaktifkan`);
        tg.notifyEntryAborted({
          pool,
          pair,
          attempts: failures,
          error: result.error,
        });
      } else {
        const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
        const cooldownMs = cooldownSec * 1000;
        if (cooldownMs > 0) {
          failureCooldownUntil.set(pool, Date.now() + cooldownMs);
          log.info(
            `Pool ${pool.slice(0, 8)} cooldown ${config.entry.failureCooldownSec}s after failed spot entry (${failures}/${config.entry.maxFailures})`
          );
        }
        tg.notifyEntryFailed({
          pool,
          pair,
          error: result.error,
          attempts: failures,
          maxFailures: config.entry.maxFailures,
          cooldownSec,
        });
      }
      return result;
    })
    .catch((err) => log.error(`Spot entry error for ${pool.slice(0, 8)}: ${err.message}`))
    .finally(() => {
      removeEntryInProgressPool(slotKey);
      removeEntryInProgressMint(mint);
    });
}

export function startEntryScanner() {
  const fastSec = Math.max(0.1, Number(config.jupiterPollIntervalSec) || 1);
  const slowSec = Math.max(5, Number(config.entry.scanIntervalSec) || 30);

  log.info(
    `Entry monitor started — kandidat refresh ${slowSec}s | Jupiter poll ${fastSec}s (signal: GMGN ${config.entry.timeframe} Supertrend bullish + Jupiter price <= line)`
  );

  refreshCandidates().catch((e) => log.error(`initial candidate refresh failed: ${e.message}`));
  const slowTimer = setInterval(
    () => refreshCandidates().catch((e) => log.error(`candidate refresh failed: ${e.message}`)),
    slowSec * 1000
  );
  const fastTimer = setInterval(
    () => watchAndEnter().catch((e) => log.error(`price watch failed: ${e.message}`)),
    fastSec * 1000
  );

  return { slowTimer, fastTimer };
}
