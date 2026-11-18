import config from "../config/index.js";
import log from "../core/logger.js";
import { fmtQuote } from "../core/report.js";
import { WSOL_MINT } from "../core/constants.js";
import * as tg from "../notify/telegram.js";
import { getOpenTrackedPositions } from "../state/positions.js";
import {
  bidaskSolTouchKey,
  clearBidaskSolTouchForMint,
  getBidaskSolTouchDirection,
  pruneBidaskSolTouch,
} from "../state/bidask-sol-touch.js";
import { loadPoolList, commentPoolInList, ensurePoolListHeader } from "./pool-list.js";
import { getPoolInfo, pairNameCache } from "./pool-info.js";
import { watchPrices, getLastPrices } from "./price-watch.js";
import { getSupertrend, getSupertrendFallback } from "../market/supertrend-state.js";
import { getConnection } from "../solana/connection.js";
import {
  selectMostEfficientSpotPool,
  summarizeSpotRentCheck,
  minSpotNonRefundableSol,
} from "../meteora/spot-position.js";
import { executeEntry, executeSpotEntry, executeBidaskSolEntry } from "./execute.js";
import {
  selectWatchCandidates,
  strategyOfMode,
  quotaKey,
  isQuotaFull,
  mintBlocksEntry,
  poolKeysToReset,
} from "./candidates.js";
import { resolveCaPool, chooseBidaskDoublePool, shouldLogCaSkip, markCaPoolInvalid } from "./ca-resolve.js";
import { pollBidaskSolPrices, pickBidaskSolEntryPool, bidaskSolQuotePrice } from "./bidask-sol-entry.js";
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
  const rows = candidateCache.map((c) => {
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
  for (const c of bidaskSolCache) {
    const cmp = bidaskSolQuotePrice({
      tokenUsd: prices.get(c.mint),
      solUsd: prices.get(WSOL_MINT),
      entryPriceUnit: c.entryPriceUnit,
    });
    const unit = c.entryPriceUnit === "sol" ? "sol" : "usd";
    rows.push({
      pool: c.mint,
      pairName: c.pairName || `CA ${c.mint.slice(0, 8)}`,
      mint: c.mint,
      sizeSol: c.sizeSol,
      mode: "bidask:sol",
      entryPrice: c.entryPrice,
      entryPriceUnit: cmp.unit,
      price: cmp.price,
      touchDirection:
        c.touchDirection || getBidaskSolTouchDirection(bidaskSolTouchKey(c.mint, c.entryPrice, unit)) || null,
      pendingBidaskSol: true,
    });
  }
  return rows;
}

export function getWatchSnapshot() {
  if (candidateCache.length > 0 || bidaskSolCache.length > 0) return buildLocalWatchSnapshot();
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
// Baris bidask:sol (CA + harga). Pool dipilih saat harga Jupiter menyentuh target.
let bidaskSolCache = [];
// Jeda singkat setelah pencarian pool gagal, supaya tidak menembak RPC tiap poll.
const bidaskSolWaitUntil = new Map();
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
    bidaskSolWaitUntil.delete(key);
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

// Slot spot pool lain. Lock mint entry yang sedang berjalan diabaikan karena
// lock itu milik pemanggilan ini sendiri.
function isSpotPoolSlotFree(pool, mint) {
  if (!pool) return false;
  const key = quotaKey(pool, "spot");
  if (inFlightPools.has(pool) || inFlightPools.has(key)) return false;
  if (isPoolClosing(pool) || isPoolSwapPending(pool) || isMintSwapPending(mint)) return false;
  if (enteredPools.has(key)) return false;
  if (isMintClosing(mint)) return false;
  if (mintBlocksEntry(getOpenTrackedPositions(), { pool, mint, strategy: "spot" }).block) return false;
  return true;
}

function spotRentFallbackEnabled() {
  return config.spotRentFallbackPool !== false;
}

// Matikan pool secara persisten: beri `#` di pool.txt + hentikan pemantauan
// in-process seketika (poll harga cepat tidak mengecek `skipped`). Hapus `#`
// secara manual untuk mengaktifkan kembali — refresh berikutnya mengangkat
// gate memori (cooldown, timer expiry, skipped) tanpa restart.
export function deactivatePool(pool, reason, opts = {}) {
  if (!pool) return false;
  const dryRun = opts.dryRun != null ? opts.dryRun : config.dryRun;
  // Dry run tidak boleh mengubah pool.txt; cukup skip runtime.
  if (dryRun) {
    skipped.add(pool);
    heldThisRefresh.add(pool);
    return false;
  }
  candidateCache = candidateCache.filter((c) => c.pool !== pool);
  failureCounts.delete(pool);
  failureCooldownUntil.delete(pool);
  dryRunNoted.delete(pool);
  const alias = getPoolAlias(pool);
  bidaskSolCache = bidaskSolCache.filter((c) => c.mint !== pool && c.mint !== alias);
  heldThisRefresh.add(pool);
  if (alias) heldThisRefresh.add(alias);
  if (commentPoolInList(pool, alias, opts.file)) {
    clearBidaskSolTouchForMint(pool);
    if (alias && alias !== pool) clearBidaskSolTouchForMint(alias);
    clearInMemoryGate(pool);
    if (alias) clearPoolAliasesFor(alias);
    const listed = opts.file || config.entry.poolListFile;
    log.info(
      `Pool ${pool.slice(0, 8)} ditandai '#' di ${listed}${reason ? ` (${reason})` : ""} — hapus '#' untuk memantau lagi`
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
    try {
      if (ensurePoolListHeader()) {
        log.info(`Header format ${config.entry.poolListFile} diperbarui`);
      }
    } catch (err) {
      log.warn(`Gagal menulis header ${config.entry.poolListFile}: ${err.message}`);
    }
    const pools = loadPoolList();
    const reactivated = poolKeysToReset(activeLineIds, pools);
    activeLineIds = reactivated.ids;
    // Baris yang baru aktif lagi (pengguna menghapus `#`) tidak boleh tertahan
    // gate memori dari siklus sebelumnya.
    for (const key of reactivated.resetKeys) clearInMemoryGate(key);

    if (pools.length === 0) {
      candidateCache = [];
      bidaskSolCache = [];
      pruneBidaskSolTouch([]);
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
    const solWatches = [];
    const stillOpen = new Set();

    for (const {
      pool: lineKey,
      sizeSol,
      mode = ENTRY_MODE,
      ca = false,
      entryPrice = null,
      entryPriceUnit = null,
    } of pools) {
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

      // bidask:sol: pantau harga Jupiter saja. Pool dipilih nanti, saat harga menyentuh target.
      if (mode === "bidask:sol") {
        if (!(Number(entryPrice) > 0)) continue;
        if (isEntryInProgressMint(lineKey) || isMintClosing(lineKey)) continue;
        const sameStrategyOpen = openPositions.some(
          (p) =>
            p && p.closed !== true && p.baseMint === lineKey && p.isDca !== true && strategyOfMode(p.mode) === strategy
        );
        if (sameStrategyOpen) continue;
        if (solWatches.some((w) => w.mint === lineKey)) continue;
        solWatches.push({
          mint: lineKey,
          sizeSol,
          entryPrice: Number(entryPrice),
          entryPriceUnit: entryPriceUnit === "sol" ? "sol" : "usd",
          mode,
          strategy,
          pairName: `CA ${lineKey.slice(0, 8)}`,
        });
        continue;
      }

      const minBinStep = mode === "bidask:double" ? Math.max(0, Number(config.entry.bidaskDoubleMinBinStep) || 0) : 0;

      if (ca) {
        if (isEntryInProgressMint(lineKey) || isMintClosing(lineKey)) continue;
        // Strategi yang sama sudah terbuka di mint ini: tunggu, jangan '#' baris CA.
        const sameStrategyOpen = openPositions.some(
          (p) =>
            p && p.closed !== true && p.baseMint === lineKey && p.isDca !== true && strategyOfMode(p.mode) === strategy
        );
        if (sameStrategyOpen) continue;
        const r = await resolveCaPool(lineKey, { minBinStep });
        if (!r.pool) {
          if (shouldLogCaSkip(lineKey, now)) {
            log.info(`CA ${lineKey.slice(0, 8)} skip: ${r.reason} (log berikutnya ≥10 menit lagi)`);
            if (r.binStepMiss) {
              tg.notifyBinStepSkip({
                mint: lineKey,
                pool: lineKey,
                minBinStep,
                reason: r.reason,
              });
            }
          }
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
        const stepNote = Number.isFinite(Number(r.binStep)) ? `, bin step ${r.binStep}` : "";
        log.info(
          `CA ${lineKey.slice(0, 8)} → pool ${poolAddress.slice(0, 8)} (fee/active TVL 30m ${r.ratio}%${stepNote})`
        );
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

      // bidask:double: pool di bawah ambang bin step diganti pool X/SOL paling
      // efisien yang lolos. Tidak ada pengganti → skip siklus ini, baris tidak di-'#'.
      // DCA tidak lewat sini; posisi yang sudah terbuka tetap di poolnya.
      if (!ca && mode === "bidask:double" && minBinStep > 0) {
        const listedStep = Number(info.pool?.lbPair?.binStep);
        if (!(Number.isFinite(listedStep) && listedStep >= minBinStep)) {
          let alt = { pools: [] };
          try {
            alt = await resolveCaPool(info.baseMint, { minBinStep });
          } catch (err) {
            alt = { pools: [], reason: err.message };
          }
          const decision = chooseBidaskDoublePool({
            listedPool: poolAddress,
            listedBinStep: listedStep,
            minBinStep,
            pools: alt.pools,
            mint: info.baseMint,
          });
          if (!decision.pool) {
            if (shouldLogCaSkip(`binstep:${lineKey}`, now)) {
              const why = decision.reason || alt.reason || `bin step < ${minBinStep}`;
              log.info(
                `Pool ${lineKey.slice(0, 8)} (${info.pairName || info.baseMint.slice(0, 8)}) skip bidask:double: ${why} — baris tidak dimatikan`
              );
              tg.notifyBinStepSkip({
                pair: info.pairName,
                pool: lineKey,
                mint: info.baseMint,
                minBinStep,
                binStep: listedStep,
                reason: why,
              });
            }
            continue;
          }
          if (decision.redirected && decision.pool !== poolAddress) {
            const fromPool = poolAddress;
            poolAddress = decision.pool;
            if (
              skipped.has(poolAddress) ||
              heldThisRefresh.has(poolAddress) ||
              now < (failureCooldownUntil.get(poolAddress) || 0)
            ) {
              continue;
            }
            const altSlot = quotaKey(poolAddress, strategy);
            if (isQuotaFull(openPositions, poolAddress, strategy)) {
              stillOpen.add(altSlot);
              continue;
            }
            if (inFlightPools.has(altSlot) || inFlightPools.has(poolAddress)) {
              if (inFlightPools.has(altSlot)) stillOpen.add(altSlot);
              continue;
            }
            if (getPoolAlias(poolAddress) !== lineKey) setPoolAlias(poolAddress, lineKey);
            try {
              info = await getPoolInfo(poolAddress);
            } catch (err) {
              log.warn(`Pool ${poolAddress.slice(0, 8)} lookup failed: ${err.message}`);
              continue;
            }
            const altStep = Number(info.pool?.lbPair?.binStep);
            if (info.unsupported || !info.baseMint || !Number.isFinite(altStep) || altStep < minBinStep) {
              if (shouldLogCaSkip(`binstep:${lineKey}`, now)) {
                log.info(
                  `Pool ${lineKey.slice(0, 8)} skip bidask:double: pengganti ${poolAddress.slice(0, 8)} bin step ${Number.isFinite(altStep) ? altStep : "?"} < ${minBinStep} — baris tidak dimatikan`
                );
                tg.notifyBinStepSkip({
                  pair: info.pairName,
                  pool: lineKey,
                  mint: info.baseMint,
                  minBinStep,
                  binStep: altStep,
                  reason: `pengganti bin step < ${minBinStep}`,
                });
              }
              continue;
            }
            log.info(
              `Pool ${fromPool.slice(0, 8)} bin step ${listedStep} < ${minBinStep} → ${poolAddress.slice(0, 8)} (bin step ${altStep}, fee/active TVL 30m ${decision.ratio}%)`
            );
          }
        }
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
    bidaskSolCache = solWatches;
    pruneBidaskSolTouch(
      pools
        .filter((row) => row.mode === "bidask:sol")
        .map((row) => bidaskSolTouchKey(row.pool, row.entryPrice, row.entryPriceUnit))
        .filter(Boolean)
    );
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
function bidaskSolWatchable(now = Date.now()) {
  const openPositions = getOpenTrackedPositions();
  return bidaskSolCache.filter((w) => {
    if (!w?.mint || !(Number(w.entryPrice) > 0)) return false;
    if (now < (bidaskSolWaitUntil.get(w.mint) || 0)) return false;
    if (now < (failureCooldownUntil.get(w.mint) || 0)) return false;
    if (isEntryInProgressMint(w.mint) || isMintClosing(w.mint) || isMintSwapPending(w.mint)) return false;
    const sameOpen = openPositions.some(
      (p) => p && p.closed !== true && p.baseMint === w.mint && p.isDca !== true && strategyOfMode(p.mode) === "bidask"
    );
    return !sameOpen;
  });
}

export async function watchAndEnter() {
  if (!config.entry.enabled) return null;
  if (_watchBusy) return null;
  if (candidateCache.length === 0 && bidaskSolCache.length === 0) return null;
  _watchBusy = true;

  try {
    const solWatchable = bidaskSolWatchable();
    let solTriggered = [];
    if (solWatchable.length > 0) {
      const polled = await pollBidaskSolPrices(solWatchable);
      solTriggered = polled.triggered || [];
    }

    const watchable = selectWatchCandidates(candidateCache, {
      inFlight: inFlightPools,
      entered: enteredPools,
      cooldowns: failureCooldownUntil,
      now: Date.now(),
    });
    let triggered = [];
    if (watchable.length > 0) {
      const byPool = new Map(watchable.map((c) => [c.pool, c]));
      const watched = await watchPrices(watchable.map((c) => ({ pool: c.pool, mint: c.mint })));
      triggered = watched.triggered || [];
      for (const t of triggered) {
        const c = byPool.get(t.pool);
        if (c) startEntry(t, c);
      }
    }

    setWatchSnapshot(buildLocalWatchSnapshot());
    for (const w of solTriggered) startBidaskSolEntry(w);

    const any = triggered.length + solTriggered.length;
    return any > 0 ? [...triggered, ...solTriggered] : null;
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

function notifySpotRentPoolSwitch(fromPool, toPool, notifyFn) {
  const text = `pindah pool karena rent: ${fromPool} -> ${toPool}`;
  log.info(text);
  try {
    const pending = notifyFn({ fromPool, toPool, text });
    Promise.resolve(pending).catch((err) => {
      log.warn(`Info pindah pool karena rent gagal dikirim: ${err.message}`);
    });
  } catch (err) {
    log.warn(`Info pindah pool karena rent gagal dikirim: ${err.message}`);
  }
}

function binStepOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rentChecksFromSelection(selection) {
  if (Array.isArray(selection?.rentChecks)) return selection.rentChecks;
  if (!Array.isArray(selection?.candidatesAudited)) return [];
  return selection.candidatesAudited.map((audit) => summarizeSpotRentCheck(audit));
}

// Pool asal dulu, lalu kandidat fallback (tanpa dobel). Hasil retry menimpa baris pool itu.
function buildCheckedSpotPools(originPool, originResult, rentChecks, retryRent) {
  const rows = new Map();
  const order = [];
  const upsert = (addr, row) => {
    if (!addr) return;
    if (!rows.has(addr)) order.push(addr);
    const prev = rows.get(addr) || {};
    rows.set(addr, {
      pool: addr,
      binStep: row.binStep ?? prev.binStep,
      costsByPct: row.costsByPct !== undefined ? row.costsByPct : prev.costsByPct,
      minNonRefundableSol: row.minNonRefundableSol !== undefined ? row.minNonRefundableSol : prev.minNonRefundableSol,
      rentOk: row.rentOk !== undefined ? row.rentOk : prev.rentOk,
    });
  };

  upsert(originPool, {
    binStep: binStepOf(originResult?.binStep),
    costsByPct: originResult?.costsByPct,
    minNonRefundableSol: minSpotNonRefundableSol(originResult?.costsByPct),
    rentOk: false,
  });

  for (const check of Array.isArray(rentChecks) ? rentChecks : []) {
    const addr = check?.poolAddress || check?.pool;
    if (!addr) continue;
    if (addr === originPool) {
      const prev = rows.get(addr);
      const step = binStepOf(check.binStep);
      if (prev && !prev.binStep && step) rows.set(addr, { ...prev, binStep: step });
      continue;
    }
    const rawMin =
      check.minNonRefundableSol == null ? minSpotNonRefundableSol(check.costsByPct) : Number(check.minNonRefundableSol);
    upsert(addr, {
      binStep: binStepOf(check.binStep),
      costsByPct: check.costsByPct,
      minNonRefundableSol: Number.isFinite(rawMin) ? rawMin : null,
      rentOk: check.rentOk === true,
    });
  }

  if (retryRent?.pool) {
    upsert(retryRent.pool, {
      binStep: binStepOf(retryRent.result?.binStep),
      costsByPct: retryRent.result?.costsByPct,
      minNonRefundableSol: minSpotNonRefundableSol(retryRent.result?.costsByPct),
      rentOk: false,
    });
  }

  return order.map((addr) => rows.get(addr));
}

async function chooseSpotRentFallbackPool(pool, mint, deps) {
  if (!spotRentFallbackEnabled() || !pool || !mint) return { chosen: null, rentChecks: [] };
  const selectFn = deps.selectMostEfficientSpotPool || selectMostEfficientSpotPool;
  const args = {
    currentPool: pool,
    baseMint: mint,
    notRentOkPools: [pool],
    rentFallbackPool: true,
    skipNonRefundable: config.spotReentry?.skipNonRefundable ?? true,
    maxNonRefundableSol: config.spotReentry?.maxNonRefundableSol ?? 0,
    getPoolInfoFn: deps.getPoolInfo || getPoolInfo,
  };
  if (typeof deps.discoverPoolsFn === "function") args.discoverPoolsFn = deps.discoverPoolsFn;
  if (typeof deps.fetchFn === "function") args.fetchFn = deps.fetchFn;
  if (typeof deps.getConnection === "function") {
    args.connection = deps.getConnection();
  } else if (!deps.selectMostEfficientSpotPool) {
    args.connection = getConnection();
  }
  try {
    const selection = await selectFn(args);
    const rentChecks = rentChecksFromSelection(selection);
    const chosen = selection?.chosenPoolAddress;
    if (!chosen || chosen === pool || selection?.chosenAudit?.rentOk !== true) return { chosen: null, rentChecks };
    if (!isSpotPoolSlotFree(chosen, mint)) {
      log.info(`Pool ${pool.slice(0, 8)} tidak pindah ke ${chosen.slice(0, 8)}: slot spot pool itu sedang terpakai`);
      return { chosen: null, rentChecks };
    }
    return { chosen, rentChecks };
  } catch (err) {
    log.warn(`Pool ${pool.slice(0, 8)} pencarian pool pengganti rent gagal: ${err.message}`);
    return { chosen: null, rentChecks: [] };
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
  let fallbackSlotKey = null;
  addEntryInProgressPool(slotKey);
  addEntryInProgressMint(mint);

  return executeSpotEntryFn(pool, sizeSol)
    .then(async (result) => {
      let activePool = pool;
      let activeSlotKey = slotKey;
      let activePair = pair;

      let rentChecks = null;
      let retryRent = null;
      if (result?.skipped && result.redflagNonRefundable && spotRentFallbackEnabled()) {
        const fallback = await chooseSpotRentFallbackPool(pool, mint || result.baseMint, deps);
        rentChecks = fallback?.rentChecks || [];
        const altPool = fallback?.chosen || null;
        if (altPool) {
          const altKey = quotaKey(altPool, "spot");
          fallbackSlotKey = altKey;
          addEntryInProgressPool(altKey);
          notifySpotRentPoolSwitch(pool, altPool, deps.notifySpotRentPoolSwitch || tg.notifySpotRentPoolSwitch);
          const retry = await executeSpotEntryFn(altPool, sizeSol);
          const retryRedflag = Boolean(retry?.skipped && retry.redflagNonRefundable);
          if (retry && !retryRedflag) {
            result = retry;
            activePool = altPool;
            activeSlotKey = altKey;
            activePair = retry.pair || pair;
          } else if (retryRedflag) {
            retryRent = { pool: altPool, result: retry };
          }
        }
      }

      if (result.success) {
        enteredPools.set(activeSlotKey, Date.now());
        for (const addr of new Set([pool, activePool])) {
          firstSeenAt.delete(addr);
          const alias = getPoolAlias(addr);
          if (alias) firstSeenAt.delete(alias);
          failureCooldownUntil.delete(addr);
          failureCounts.delete(addr);
        }
        return result;
      }

      if (result.skipped && result.redflagNonRefundable) {
        log.warn(
          `Pool ${activePool.slice(0, 8)} (${activePair}) REDFLAG non-refundable rent pada tangga -95/-90/-85/-80% — skip & nonaktifkan pool`
        );
        let watchDisabled = false;
        try {
          watchDisabled = deactivatePool(activePool, "redflag non-refundable rent (-95/-90/-85/-80%)") === true;
        } catch (err) {
          log.warn(`Pool ${activePool.slice(0, 8)} gagal dinonaktifkan: ${err.message}`);
        }
        alertSpotRentRedflag(
          {
            pool: activePool,
            pair: result.pair || activePair,
            mint: mint || result.baseMint,
            costsByPct: result.costsByPct,
            cost95Sol: result.cost95Sol,
            cost90Sol: result.cost90Sol,
            upperPct: result.upperPct,
            maxNonRefundableSol: result.maxNonRefundableSol,
            sizeSol,
            reason: result.reason,
            context: "Entry Spot Instan",
            watchDisabled,
            fallbackEnabled: spotRentFallbackEnabled(),
            poolsChecked: buildCheckedSpotPools(pool, result, rentChecks, retryRent),
          },
          deps.notifySpotNonRefundableSkipped || tg.notifySpotNonRefundableSkipped
        );
        return result;
      }

      if (result.skipped) {
        log.warn(`Pool ${activePool.slice(0, 8)} dilewati: ${result.reason || "spot entry skipped"}`);
        return result;
      }

      log.warn(`Spot entry failed for ${activePool.slice(0, 8)}: ${result.error}`);
      const failures = (failureCounts.get(activePool) || 0) + 1;
      failureCounts.set(activePool, failures);
      if (failures >= config.entry.maxFailures) {
        deactivatePool(activePool, `gagal spot entry ${failures}x`);
        log.error(`Pool ${activePool.slice(0, 8)} aborted after ${failures} failed spot entries — dinonaktifkan`);
        tg.notifyEntryAborted({
          pool: activePool,
          pair: activePair,
          attempts: failures,
          error: result.error,
        });
      } else {
        const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
        const cooldownMs = cooldownSec * 1000;
        if (cooldownMs > 0) {
          failureCooldownUntil.set(activePool, Date.now() + cooldownMs);
          log.info(
            `Pool ${activePool.slice(0, 8)} cooldown ${config.entry.failureCooldownSec}s after failed spot entry (${failures}/${config.entry.maxFailures})`
          );
        }
        tg.notifyEntryFailed({
          pool: activePool,
          pair: activePair,
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
      if (fallbackSlotKey && fallbackSlotKey !== slotKey) removeEntryInProgressPool(fallbackSlotKey);
      removeEntryInProgressMint(mint);
    });
}

function noteBidaskSolFailure(mint, pool, error) {
  log.warn(`bidask:sol entry gagal untuk ${mint.slice(0, 8)}: ${error}`);
  const failures = (failureCounts.get(mint) || 0) + 1;
  failureCounts.set(mint, failures);
  const pair = `CA ${mint.slice(0, 8)}`;
  if (failures >= config.entry.maxFailures) {
    deactivatePool(mint, `gagal bidask:sol entry ${failures}x`);
    tg.notifyEntryAborted({ pool: pool || mint, pair, attempts: failures, error });
    return;
  }
  const cooldownSec = Math.max(0, Number(config.entry.failureCooldownSec) || 0);
  if (cooldownSec > 0) {
    failureCooldownUntil.set(mint, Date.now() + cooldownSec * 1000);
    log.info(
      `CA ${mint.slice(0, 8)} cooldown ${cooldownSec}s after failed bidask:sol entry (${failures}/${config.entry.maxFailures})`
    );
  }
  tg.notifyEntryFailed({
    pool: pool || mint,
    pair,
    error,
    attempts: failures,
    maxFailures: config.entry.maxFailures,
    cooldownSec,
  });
}

function bidaskSolWaitMs() {
  return Math.max(15_000, (Number(config.entry.caCacheSec) || 60) * 1000);
}

// Harga sudah menyentuh target. Pilih pool sekarang; kalau tidak ada yang lolos, tunggu.
function bidaskSolHarga(price, entryPrice, unit) {
  const u = unit === "sol" ? "sol" : "usd";
  return `${fmtQuote(price, u)} menyentuh ${fmtQuote(entryPrice, u)}`;
}

export async function runBidaskSolEntry(watch, deps = {}) {
  const resolveFn = deps.resolveCaPool || resolveCaPool;
  const executeFn = deps.executeBidaskSolEntry || executeBidaskSolEntry;
  const pickFn = deps.pickBidaskSolEntryPool || pickBidaskSolEntryPool;
  const dryRun = deps.dryRun != null ? deps.dryRun : config.dryRun;
  const poolListFile = deps.poolListFile;
  const { mint, sizeSol, entryPrice, price, solPrice, priceUsd, entryPriceUnit } = watch;
  const unit = entryPriceUnit === "sol" ? "sol" : "usd";
  const pairHint = `CA ${mint.slice(0, 8)}`;
  addEntryInProgressMint(mint);
  let poolLocked = null;
  try {
    const resolved = await resolveFn(mint);
    if (!Array.isArray(resolved?.pools)) {
      bidaskSolWaitUntil.set(mint, Date.now() + bidaskSolWaitMs());
      if (shouldLogCaSkip(`bidasksol:${mint}`)) {
        log.info(
          `${pairHint} bidask:sol menunggu: ${resolved?.reason || "gagal ambil daftar pool"} (harga ${bidaskSolHarga(price, entryPrice, unit)}) — baris tidak dimatikan`
        );
      }
      return;
    }
    const picked = pickFn(resolved.pools, mint);
    if (!picked.ranked.length) {
      bidaskSolWaitUntil.set(mint, Date.now() + bidaskSolWaitMs());
      if (shouldLogCaSkip(`bidasksol:${mint}`)) {
        log.info(
          `${pairHint} bidask:sol menunggu: ${picked.reason || resolved?.reason || "tidak ada pool"} (harga ${bidaskSolHarga(price, entryPrice, unit)}) — baris tidak dimatikan`
        );
      }
      return;
    }

    if (dryRun) {
      if (!dryRunNoted.has(mint)) {
        dryRunNoted.add(mint);
        const top = picked.ranked[0];
        log.info(
          `[DRY RUN] Would enter bidask:sol ${pairHint} — ${sizeSol} SOL saat harga ${bidaskSolHarga(price, entryPrice, unit)} | pool ${top.pool.slice(0, 8)} step ${top.binStep} TVL ${Math.round(top.tvl)} ${top.binCount} bin`
        );
      }
      return;
    }

    const openPositions = getOpenTrackedPositions();
    let lastReason = null;
    for (const row of picked.ranked) {
      const pool = row.pool;
      if (skipped.has(pool) || heldThisRefresh.has(pool)) continue;
      if (Date.now() < (failureCooldownUntil.get(pool) || 0)) continue;
      const block = mintBlocksEntry(openPositions, { pool, mint, strategy: "bidask" });
      if (block.otherPool || block.sameStrategy) {
        bidaskSolWaitUntil.set(mint, Date.now() + bidaskSolWaitMs());
        if (shouldLogCaSkip(`bidasksol-block:${mint}`)) {
          log.info(
            `${pairHint} bidask:sol menunggu: token sudah punya posisi ${block.otherPool ? "di pool lain" : "bidask di pool ini"} — baris tidak dimatikan`
          );
        }
        return;
      }
      const slotKey = quotaKey(pool, "bidask");
      if (inFlightPools.has(slotKey) || inFlightPools.has(pool) || isPoolClosing(pool) || isPoolSwapPending(pool)) {
        return;
      }
      if (isQuotaFull(openPositions, pool, "bidask")) return;

      addEntryInProgressPool(slotKey);
      poolLocked = slotKey;
      if (getPoolAlias(pool) !== mint) setPoolAlias(pool, mint);
      log.info(
        `${pairHint} → pool ${pool.slice(0, 8)} bidask:sol (bin step ${row.binStep}, TVL ${Math.round(row.tvl)}, ${row.binCount} bin, fee/active TVL ${row.feeRatio})`
      );
      const result = await executeFn(pool, sizeSol, {
        tvlUsd: row.tvl,
        entryPrice,
        entryPriceUnit: unit,
        triggerPrice: price,
        priceUsd: priceUsd ?? (unit === "usd" ? price : null),
        solPrice,
        binStepHint: row.binStep,
      });
      removeEntryInProgressPool(slotKey);
      poolLocked = null;

      if (result?.success) {
        enteredPools.set(slotKey, Date.now());
        firstSeenAt.delete(mint);
        firstSeenAt.delete(pool);
        failureCooldownUntil.delete(mint);
        failureCounts.delete(mint);
        bidaskSolWaitUntil.delete(mint);
        bidaskSolCache = bidaskSolCache.filter((c) => c.mint !== mint);
        // Baris CA (termasuk 6 kolom + akhiran sol/usd) diberi # supaya tidak masuk lagi.
        deactivatePool(mint, "bidask:sol entry berhasil", { dryRun, file: poolListFile });
        return;
      }
      if (result?.duplicateMint) {
        bidaskSolWaitUntil.set(mint, Date.now() + bidaskSolWaitMs());
        log.info(`${pairHint} bidask:sol dilewati: ${result.reason || "posisi sudah ada"} — baris tidak dimatikan`);
        return;
      }
      if (result?.tryNext) {
        lastReason = result.reason || result.error;
        if (result.invalidPool) markCaPoolInvalid(pool, lastReason);
        continue;
      }
      noteBidaskSolFailure(mint, pool, result?.error || result?.reason || "entry gagal");
      return;
    }

    bidaskSolWaitUntil.set(mint, Date.now() + bidaskSolWaitMs());
    if (shouldLogCaSkip(`bidasksol:${mint}`)) {
      log.info(
        `${pairHint} bidask:sol menunggu: ${lastReason || "tidak ada pool yang bisa dibuka"} (harga ${bidaskSolHarga(price, entryPrice, unit)}) — baris tidak dimatikan`
      );
    }
  } catch (err) {
    log.error(`bidask:sol entry error for ${mint.slice(0, 8)}: ${err.message}`);
    noteBidaskSolFailure(mint, null, err.message);
  } finally {
    if (poolLocked) removeEntryInProgressPool(poolLocked);
    removeEntryInProgressMint(mint);
  }
}

function startBidaskSolEntry(watch) {
  const mint = watch?.mint;
  if (!mint) return;
  if (config.dryRun && dryRunNoted.has(mint)) return;
  if (isEntryInProgressMint(mint) || isMintClosing(mint) || isMintSwapPending(mint)) return;
  log.info(
    `CA ${mint.slice(0, 8)} bidask:sol: harga ${bidaskSolHarga(watch.price, watch.entryPrice, watch.entryPriceUnit)} — cari pool (${watch.sizeSol} SOL)`
  );
  return runBidaskSolEntry(watch);
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
