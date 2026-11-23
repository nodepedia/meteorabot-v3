import config from "../config/index.js";
import log from "../core/logger.js";
import { WSOL_MINT } from "../core/constants.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getInitialCapitalSol } from "../state/positions.js";
import { getDlmmSdk } from "./sdk.js";

const poolMetaCache = new Map();
const POOL_META_TTL = 15 * 60 * 1000;
const POOL_DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag";

// Lightweight count of open position addresses (no PnL/metadata enrichment).
export async function getOpenPositionAddresses() {
  try {
    const connection = getConnection();
    const wallet = getWallet();
    const { DLMM } = await getDlmmSdk();

    const map = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
    const addresses = [];
    for (const [, info] of map) {
      for (const p of info?.lbPairPositionsData || []) {
        const addr = p.publicKey?.toString?.();
        if (addr) addresses.push(addr);
      }
    }
    return addresses;
  } catch (err) {
    log.error(`getOpenPositionAddresses failed: ${err.message}`);
    return [];
  }
}

// Count of open positions per pool (lbPair address), lightweight.
export async function getOpenPositionCountsByPool() {
  const counts = new Map();
  try {
    const connection = getConnection();
    const wallet = getWallet();
    const { DLMM } = await getDlmmSdk();

    const map = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
    for (const [lbPairKey, info] of map) {
      const posList = info?.lbPairPositionsData || [];
      let n = 0;
      for (const p of posList) {
        if (p?.publicKey?.toString?.()) n++;
      }
      if (n > 0) counts.set(lbPairKey, n);
    }
  } catch (err) {
    log.error(`getOpenPositionCountsByPool failed: ${err.message}`);
  }
  return counts;
}

// Ringan (tanpa enrich API): semua posisi DLMM wallet beserta mint pool-nya.
// Melempar error bila RPC gagal — dipakai proteksi swap (fail closed).
export async function getOpenPositionMints() {
  const connection = getConnection();
  const wallet = getWallet();
  const { DLMM } = await getDlmmSdk();
  const map = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
  const out = [];
  for (const [lbPairKey, info] of map) {
    const x = info?.tokenX?.mint?.address?.toString?.() ?? info?.lbPair?.tokenXMint?.toString?.() ?? "";
    const y = info?.tokenY?.mint?.address?.toString?.() ?? info?.lbPair?.tokenYMint?.toString?.() ?? "";
    for (const p of info?.lbPairPositionsData || []) {
      out.push({ position: p.publicKey?.toString() || "", pool: String(lbPairKey), mints: [x, y].filter(Boolean) });
    }
  }
  return out;
}

export async function getOpenPositions() {
  const connection = getConnection();
  const wallet = getWallet();
  const { DLMM } = await getDlmmSdk();

  try {
    const map = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);

    const positions = [];
    const walletStr = wallet.publicKey.toString();

    for (const [lbPairKey, info] of map) {
      const tokenXMint = info?.tokenX?.mint?.address?.toString?.() ?? "";
      const tokenYMint = info?.tokenY?.mint?.address?.toString?.() ?? "";
      const activeBin = info?.lbPair?.activeId ?? null;
      const collectFeeMode = info?.lbPair?.parameters?.collectFeeMode ?? null;
      const xIsSol = tokenXMint === WSOL_MINT;
      const yIsSol = tokenYMint === WSOL_MINT;
      const baseMint = xIsSol ? tokenYMint : tokenXMint;

      const posList = info?.lbPairPositionsData || [];
      for (const p of posList) {
        const d = p.positionData || {};
        try {
          const totalX = Number(d.totalXAmount?.toString?.() ?? d.totalXAmount ?? 0);
          const totalY = Number(d.totalYAmount?.toString?.() ?? d.totalYAmount ?? 0);
          const lowerBin = Number(d.lowerBinId ?? null);
          const upperBin = Number(d.upperBinId ?? null);
          const posAddress = p.publicKey?.toString() || "";

          const binData = d.positionBinData ?? [];
          const hasX = binData.some((b) => BigInt(b?.positionXAmount ?? 0) > 0n);
          const hasY = binData.some((b) => BigInt(b?.positionYAmount ?? 0) > 0n);
          let maxFilledBin = null;
          for (const b of binData) {
            if (BigInt(b?.positionXAmount ?? 0) > 0n || BigInt(b?.positionYAmount ?? 0) > 0n) {
              const id = Number(b.binId);
              if (Number.isFinite(id) && (maxFilledBin == null || id > maxFilledBin)) {
                maxFilledBin = id;
              }
            }
          }
          const binSpan = lowerBin != null && upperBin != null ? upperBin - lowerBin : 0;
          const solRaw = xIsSol ? totalX : yIsSol ? totalY : 0;
          const solAmountUi = Number.isFinite(solRaw) && solRaw > 0 ? solRaw / 1e9 : 0;

          positions.push({
            position: posAddress,
            pool: lbPairKey,
            wallet: walletStr,
            pair: `${tokenXMint.slice(0, 4)}-${tokenYMint.slice(0, 4)}`,
            baseMint,
            mintX: tokenXMint,
            mintY: tokenYMint,
            xIsSol,
            yIsSol,
            lowerBin,
            upperBin,
            maxFilledBin,
            activeBin,
            collectFeeMode,
            pnlPct: 0,
            totalValue: totalX + totalY,
            hasX,
            hasY,
            binSpan,
            solAmountUi,
          });
        } catch (err) {
          log.warn(`Skip position in pool ${lbPairKey.slice(0, 8)}: ${err.message}`);
        }
      }
    }

    // Enrich with PnL + metadata + market cap
    await Promise.all([enrichPnl(positions), enrichMetadata(positions), enrichMarketCap(positions)]);

    return positions;
  } catch (err) {
    log.error(`getOpenPositions failed: ${err.message}`);
    // null = fetch gagal (bukan benar-benar kosong); caller bisa membedakan
    // dari [] yang berarti tidak ada posisi terbuka.
    return null;
  }
}

async function getPoolMetadata(poolAddress) {
  const cached = poolMetaCache.get(poolAddress);
  if (cached && Date.now() - cached.ts < POOL_META_TTL) {
    return cached;
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    const meta = {
      name: data?.name || null,
      tokenX: data?.token_x?.symbol || null,
      tokenY: data?.token_y?.symbol || null,
      volume24h: null,
      avgVolume: null,
      fee24h: null,
      ts: Date.now(),
    };
    try {
      const v = await fetch(`${POOL_DISCOVERY}/pools?page_size=1&filter_by=pool_address%3D${poolAddress}`);
      if (v.ok) {
        const vd = await v.json();
        const p = vd?.data?.[0];
        if (p) {
          meta.volume24h = p.volume;
          meta.avgVolume = p.avg_volume;
          meta.fee24h = p.fee;
        }
      }
    } catch {}
    poolMetaCache.set(poolAddress, meta);
    return meta;
  } catch {
    return null;
  }
}

async function enrichMetadata(positions) {
  const seen = new Set();
  for (const p of positions) {
    if (seen.has(p.pool)) continue;
    seen.add(p.pool);
    const meta = await getPoolMetadata(p.pool);
    if (meta) {
      const label = meta.name || (meta.tokenX && meta.tokenY ? `${meta.tokenX}/${meta.tokenY}` : null);
      for (const pos of positions) {
        if (pos.pool === p.pool) {
          if (label) pos.pair = label;
          pos.volume24h = meta.volume24h;
          pos.avgVolume = meta.avgVolume;
          pos.fee24h = meta.fee24h;
        }
      }
    }
  }
}

async function enrichMarketCap(positions) {
  const seen = new Set();
  for (const p of positions) {
    if (!p.baseMint || seen.has(p.baseMint)) continue;
    seen.add(p.baseMint);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${p.baseMint}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      const pair = pairs.find((x) => x.marketCap && x.marketCap > 0);
      const mc = pair ? Number(pair.marketCap) : null;
      const dexVol5m = pairs.reduce((max, x) => {
        const v = Number(x?.volume?.m5);
        return Number.isFinite(v) && v > max ? v : max;
      }, 0);
      for (const pos of positions) {
        if (pos.baseMint === p.baseMint) {
          pos.marketCap = mc;
          if (dexVol5m > 0) pos.dexVolume5m = dexVol5m;
        }
      }
    } catch {
      // non-critical
    }
  }
}

// Cache respons PnL per pool. Watcher DCA me-refresh (force) tiap
// DCA_POLL_INTERVAL_SEC; loop exit membaca cache yang sama agar tidak dobel
// request ke Meteora.
const poolPnlCache = new Map(); // pool -> { at, map: Map(position -> entry) }

// Persen PnL. Urutan penyebut (mode SOL):
// 1. modal awal (`initialCapitalSol`) bila diketahui (> 0): pnlSol / modal × 100.
//    Rebalance in-place tercatat tarik + setor ulang, jadi setoran seumur hidup
//    membengkak dan modal bersih (setor − tarik) bisa ≤ 0. Modal awal tidak ikut.
// 2. modal bersih = allTimeDeposits − allTimeWithdrawals, bila aman.
// 3. field persen Meteora (pnlSolPctChange), yang terencer oleh setoran seumur hidup.
//
// Mode USD tidak punya modal awal tersimpan: pnlUsd / modal bersih usd × 100,
// lalu pnlPctChange. Tarikan yang tidak ada dihitung 0.
//
// Kembali ke field persen Meteora bila modal bersih tidak aman:
// - pnl absolut atau total setoran tidak ada / bukan angka
// - modal bersih bukan angka, ≤ 1e-6, atau ≤ 1% dari total setoran
//   (pembagi ~0, termasuk modal negatif)
// Field persen Meteora yang kosong dihitung 0, sama seperti sebelumnya.
//
// pnlBasisFromEntry mengembalikan { pct, pnlSol }. pnlSol adalah pembilang
// SOL hanya bila persen dihitung dari angka itu (mode SOL). Cadangan field
// persen Meteora dan mode USD tidak punya pembilang SOL (pnlSol null).
const NET_CAPITAL_ABS_EPSILON = 1e-6;
const NET_CAPITAL_MIN_DEPOSIT_RATIO = 0.01;

// Entri PnL terbuka dari fetch terakhir, supaya adopsi bisa baca deposit
// tanpa request kedua. Tidak ditulis ke state.
const livePnlEntries = new Map();

function finiteAmount(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function meteoraPctChange(entry, solMode) {
  const raw = solMode ? entry.pnlSolPctChange : entry.pnlPctChange;
  const pnl = parseFloat(raw || "0");
  return Number.isFinite(pnl) ? pnl : null;
}

// Nilai SOL satu setoran. Bentuk yang dikenali:
// - total.sol / amountSol / totalSol (sudah dalam SOL)
// - amountXSol + amountYSol
// - event historis datapi (amountX/amountY + mint). Sisi WSOL dipakai apa
//   adanya (UI, sama seperti allTimeDeposits.amount). Sisi token diubah ke
//   SOL lewat harga setoran (usd sisi SOL / jumlah SOL).
export function depositSolAmount(deposit) {
  if (!deposit || typeof deposit !== "object" || Array.isArray(deposit)) return null;
  const explicit = finiteAmount(deposit.total?.sol ?? deposit.totalSol ?? deposit.amountSol ?? deposit.sol);
  if (explicit != null && explicit > 0) return explicit;

  const xSol = finiteAmount(deposit.amountXSol ?? deposit.tokenX?.amountSol);
  const ySol = finiteAmount(deposit.amountYSol ?? deposit.tokenY?.amountSol);
  if ((xSol != null && xSol > 0) || (ySol != null && ySol > 0)) {
    return (xSol > 0 ? xSol : 0) + (ySol > 0 ? ySol : 0);
  }

  const xMint = deposit.tokenXMint || (typeof deposit.tokenX === "string" ? deposit.tokenX : null);
  const yMint = deposit.tokenYMint || (typeof deposit.tokenY === "string" ? deposit.tokenY : null);
  const xIsSol = xMint === WSOL_MINT;
  const yIsSol = yMint === WSOL_MINT;
  if (!xIsSol && !yIsSol) return null;

  const solAmt = finiteAmount(
    xIsSol ? (deposit.amountX ?? deposit.tokenX?.amount) : (deposit.amountY ?? deposit.tokenY?.amount)
  );
  const solUsd = finiteAmount(
    xIsSol ? (deposit.amountXUsd ?? deposit.tokenX?.usd) : (deposit.amountYUsd ?? deposit.tokenY?.usd)
  );
  const otherUsd = finiteAmount(
    xIsSol ? (deposit.amountYUsd ?? deposit.tokenY?.usd) : (deposit.amountXUsd ?? deposit.tokenX?.usd)
  );
  if (solAmt == null || solAmt <= 0) return null;
  let otherSol = 0;
  if (otherUsd != null && otherUsd > 0 && solUsd != null && solUsd > 0) {
    otherSol = otherUsd / (solUsd / solAmt);
  }
  const total = solAmt + (Number.isFinite(otherSol) ? otherSol : 0);
  return total > 0 ? total : null;
}

function eventKind(event) {
  const raw = event?.eventType || event?.type;
  return raw ? String(raw) : "add";
}

// SOL setoran pembuka. Satu objek = satu setoran. Daftar event dijumlahkan
// sampai tarikan pertama (remove), supaya setoran ulang rebalance tidak ikut.
// Chunk pembuka (beberapa add sebelum remove) dijumlahkan.
export function initialDepositSol(source) {
  if (source == null) return null;
  const list = (Array.isArray(source) ? source : [source]).filter((e) => e && typeof e === "object");
  if (!list.length) return null;
  const single = list.length === 1 && !list[0].eventType && !list[0].type;
  if (single) return depositSolAmount(list[0]);

  const sorted = [...list].sort((a, b) => (Number(a.blockTime) || 0) - (Number(b.blockTime) || 0));
  let sol = 0;
  let saw = false;
  for (const event of sorted) {
    const kind = eventKind(event);
    if (kind === "remove") break;
    if (kind !== "add" && kind !== "deposit") continue;
    const part = depositSolAmount(event);
    if (part != null && part > 0) {
      sol += part;
      saw = true;
    }
  }
  return saw && sol > 0 ? sol : null;
}

function inlineInitialDepositSol(entry) {
  if (!entry || typeof entry !== "object") return null;
  return (
    initialDepositSol(entry.firstDeposit) ??
    initialDepositSol(entry.deposits) ??
    initialDepositSol(entry.depositHistory) ??
    initialDepositSol(entry.events)
  );
}

// Setoran seumur hidup sudah membengkak (ada tarikan). allTimeDeposits.total.sol
// bukan modal awal lagi.
function allTimeDepositsInflated(entry) {
  if (!entry || typeof entry !== "object") return false;
  const withdrawn = finiteAmount(entry.allTimeWithdrawals?.total?.sol) ?? 0;
  return withdrawn > NET_CAPITAL_ABS_EPSILON;
}

// Modal awal dari data yang sudah ada. `firstDeposit` = event historis (objek
// atau daftar). Bila tidak ada: posisi yang baru diadopsi memakai
// allTimeDeposits saat itu; posisi lama yang setorannya sudah membengkak
// dibiarkan kosong supaya rumus cadangan (modal bersih) tetap dipakai.
export function initialCapitalForPosition(entry, { firstDeposit = null, adopted = false } = {}) {
  const fromFirst = initialDepositSol(firstDeposit) ?? inlineInitialDepositSol(entry);
  if (fromFirst != null && fromFirst > 0) return fromFirst;
  if (!adopted && allTimeDepositsInflated(entry)) return null;
  const all = finiteAmount(entry?.allTimeDeposits?.total?.sol);
  return all != null && all > 0 ? all : null;
}

// Perlu baca riwayat datapi: setoran seumur hidup sudah membengkak dan entri
// PnL tidak memuat deposit pertama.
export function needsHistoricalFirstDeposit(entry) {
  if (inlineInitialDepositSol(entry) != null) return false;
  return allTimeDepositsInflated(entry);
}

export function pnlBasisFromEntry(entry, { solMode = config.solMode, initialCapitalSol = null } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const useSol = Boolean(solMode);
  const fallback = { pct: meteoraPctChange(entry, useSol), pnlSol: null };
  const pnlAbs = finiteAmount(useSol ? entry.pnlSol : entry.pnlUsd);
  if (useSol) {
    const capital = finiteAmount(initialCapitalSol);
    if (capital != null && capital > 0 && pnlAbs != null) {
      const pct = (pnlAbs / capital) * 100;
      if (Number.isFinite(pct)) return { pct, pnlSol: pnlAbs };
    }
  }
  const deposits = finiteAmount(useSol ? entry.allTimeDeposits?.total?.sol : entry.allTimeDeposits?.total?.usd);
  if (pnlAbs == null || deposits == null) return fallback;
  const withdrawals =
    finiteAmount(useSol ? entry.allTimeWithdrawals?.total?.sol : entry.allTimeWithdrawals?.total?.usd) ?? 0;
  const net = deposits - withdrawals;
  if (!Number.isFinite(net) || net <= NET_CAPITAL_ABS_EPSILON) return fallback;
  if (deposits > 0 && net <= deposits * NET_CAPITAL_MIN_DEPOSIT_RATIO) return fallback;
  const pct = (pnlAbs / net) * 100;
  if (!Number.isFinite(pct)) return fallback;
  return { pct, pnlSol: useSol ? pnlAbs : null };
}

export function pnlFromEntry(entry, opts = {}) {
  const basis = pnlBasisFromEntry(entry, opts);
  return basis ? basis.pct : null;
}

export function livePnlEntryFor(positionAddress) {
  if (!positionAddress) return null;
  return livePnlEntries.get(positionAddress) || null;
}

// "24h Fee/TVL" satu posisi. Field atas `feePerTvl24h`, di fixture historis
// berupa string angka ("6.011..."). Dipakai apa adanya lewat parseFloat.
// Tidak dikali dan tidak dibagi 100. Bukan ringkasan pool, bukan PnL,
// bukan unclaimed/saldo, bukan all-time fee. Fixture tidak memuat rumus satuan.
export function positionFeePct24h(entry) {
  if (!entry || typeof entry !== "object") return null;
  const feeTvl = parseFloat(entry.feePerTvl24h);
  return Number.isFinite(feeTvl) ? feeTvl : null;
}

// `updatedAt` pada entri PnL historis adalah unix detik (bukan milidetik).
export function positionPnlUpdatedAtMs(entry) {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry.updatedAt;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

// Hanya baris posisi terbuka. Ringkasan pool tidak punya positionAddress.
// Baris closed (fee bisa > 7) tidak boleh masuk keputusan exit.
export function isOpenPositionPnlEntry(entry) {
  return (
    !!entry &&
    typeof entry === "object" &&
    entry.isClosed !== true &&
    typeof entry.positionAddress === "string" &&
    entry.positionAddress.length > 0
  );
}

export function indexOpenPositionPnl(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!isOpenPositionPnlEntry(entry)) continue;
    map.set(entry.positionAddress, entry);
  }
  return map;
}

// Simpan angka yield, waktu fetch sukses, dan updatedAt data.
// Salah satu kosong → aturan tutup yield tinggi menolak.
export function applyPositionFeeTvl(position, entry, observedAt = null) {
  const feePct24h = positionFeePct24h(entry);
  position.feePct24h = feePct24h;
  const observed = Number.isFinite(observedAt) ? observedAt : null;
  position.feePct24hAt = feePct24h == null ? null : observed;
  position.feePct24hUpdatedAt = feePct24h == null ? null : positionPnlUpdatedAtMs(entry);
  return position;
}

// Baca satu entri posisi dari endpoint `status=closed` (paginate sederhana).
// `wallet` bisa diisi eksplisit untuk pengujian; default ambil dari wallet bot.
async function fetchClosedEntry(poolAddress, positionAddress, wallet) {
  try {
    let page = 1;
    for (;;) {
      const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet}&status=closed&pageSize=100&page=${page}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      for (const entry of data.positions || []) {
        if ((entry.positionAddress || "") === positionAddress) return entry;
      }
      if (!data.hasNext || page >= 20) return null;
      page++;
    }
  } catch (err) {
    log.warn(`fetchClosedEntry failed: ${err.message}`);
    return null;
  }
}

// Riwayat aksi posisi (add/remove/claim). Dipakai sekali saat adopsi bila
// setoran seumur hidup sudah membengkak, untuk mengambil SOL setoran pembuka.
export async function fetchInitialDepositEvents(positionAddress) {
  if (!positionAddress) return null;
  try {
    const url = `https://dlmm.datapi.meteora.ag/positions/${positionAddress}/historical?order_direction=asc`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.events)) return data.events;
    if (Array.isArray(data)) return data;
    return null;
  } catch (err) {
    log.warn(`fetchInitialDepositEvents failed: ${err.message}`);
    return null;
  }
}

// PnL final posisi dari Meteora (endpoint closed) agar alert close sama dengan
// dashboard. Poll sampai entri muncul/ter-index; `null` bila timeout.
// `initialCapitalSol` memakai penyebut yang sama dengan PnL live.
export async function waitClosedPositionPnl(
  poolAddress,
  positionAddress,
  { timeoutMs = 20000, intervalMs = 1500, wallet = null, initialCapitalSol = null } = {}
) {
  if (!poolAddress || !positionAddress) return null;

  let walletStr = wallet;
  if (!walletStr) {
    try {
      walletStr = getWallet().publicKey.toString();
    } catch (err) {
      log.warn(`waitClosedPositionPnl: wallet tidak tersedia (${err.message})`);
      return null;
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const pnl = pnlFromEntry(await fetchClosedEntry(poolAddress, positionAddress, walletStr), { initialCapitalSol });
    if (pnl != null) return pnl;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.max(0, intervalMs)));
  }
}

// Satu request PnL ringan untuk seluruh posisi di pool. `force` = refresh
// walaupun cache masih segar (dipakai watcher DCA).
export async function fetchPoolPnl(poolAddress, { ttlSec = 5, force = false } = {}) {
  if (!poolAddress) return new Map();
  const now = Date.now();
  const ttl = Math.max(0, Number(ttlSec) || 0);
  const cached = poolPnlCache.get(poolAddress);
  if (!force && cached && now - cached.at < ttl * 1000) return cached.map;

  try {
    const walletStr = getWallet().publicKey.toString();
    const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletStr}&status=open&pageSize=100&page=1`;
    const res = await fetch(url);
    if (!res.ok) return cached ? cached.map : new Map();
    const data = await res.json();
    const map = indexOpenPositionPnl(data.positions || []);
    poolPnlCache.set(poolAddress, { at: now, map });
    return map;
  } catch (err) {
    log.warn(`fetchPoolPnl failed: ${err.message}`);
    return cached ? cached.map : new Map();
  }
}

// Waktu sukses terakhir cache PnL pool. Cache basi (fetch gagal) tidak
// memperbarui waktu ini, jadi aturan yield tinggi bisa menolaknya.
export function poolPnlObservedAt(poolAddress) {
  const cached = poolPnlCache.get(poolAddress);
  return cached && Number.isFinite(cached.at) ? cached.at : null;
}

async function enrichPnl(positions) {
  // Cache dianggap segar selama satu interval loop exit; watcher DCA yang
  // me-refresh tiap pollIntervalSec. Saat DCA nonaktif, ttl 0 = selalu fetch
  // (perilaku lama).
  const ttlSec = config.dca.enabled ? config.pollIntervalHold * 60 : 0;

  // Group positions by pool for batch PnL fetches
  const byPool = {};
  for (const p of positions) {
    if (!byPool[p.pool]) byPool[p.pool] = [];
    byPool[p.pool].push(p);
  }

  for (const [poolAddress, poolPositions] of Object.entries(byPool)) {
    const pnlMap = await fetchPoolPnl(poolAddress, { ttlSec });
    const observedAt = poolPnlObservedAt(poolAddress);
    for (const p of poolPositions) {
      const entry = pnlMap.get(p.position);
      if (!isOpenPositionPnlEntry(entry)) continue;

      const initialCapitalSol = getInitialCapitalSol(p.position);
      const basis = pnlBasisFromEntry(entry, { initialCapitalSol });
      const pnl = basis?.pct ?? null;
      p.pnlPct = pnl == null ? 0 : pnl;
      p.pnlSol = basis?.pnlSol ?? null;
      if (p.position) livePnlEntries.set(p.position, entry);
      // null = data yield tidak tersedia (dibedakan dari 0%).
      // feePct24hAt = waktu cache sukses; kosong bila angka yield tidak ada.
      applyPositionFeeTvl(p, entry, observedAt);
      const feeX = parseFloat(entry.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || "0");
      const feeY = parseFloat(entry.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || "0");
      p.unclaimedFee = Number.isFinite(feeX + feeY) ? feeX + feeY : 0;

      // Komposisi deposit awal (UI units) untuk deteksi double/token-only/sol-only.
      // tokenX/tokenY mengikuti orientasi pool, jadi dipetakan ke base/SOL via xIsSol.
      const depX = Number(entry.allTimeDeposits?.tokenX?.amount);
      const depY = Number(entry.allTimeDeposits?.tokenY?.amount);
      if (Number.isFinite(depX) && Number.isFinite(depY)) {
        p.entryBaseAmount = p.xIsSol ? depY : depX;
        p.entrySolAmount = p.xIsSol ? depX : depY;
      }
    }
  }
}
