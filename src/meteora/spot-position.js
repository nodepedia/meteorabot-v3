import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config/index.js";
import log from "../core/logger.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { chunkSpotRanges } from "../exit/spot-token-bidask.js";

/**
 * Hitung jumlah bin dari activeBin untuk persentase perubahan harga tertentu.
 * Contoh binStepBps = 100 (1% per bin):
 *   pctChange = -95 -> r = 1.01, t = 0.05 -> round(|ln(0.05)| / ln(1.01)) = 301 bin
 *   pctChange = -90 -> r = 1.01, t = 0.10 -> round(|ln(0.10)| / ln(1.01)) = 231 bin
 *   pctChange = +15 -> r = 1.01, t = 1.15 -> round(|ln(1.15)| / ln(1.01)) = 14 bin
 */
export function calcBinsForPricePct(binStepBps, pctChange) {
  const step = Number(binStepBps);
  const pct = Number(pctChange);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`Invalid binStepBps: ${binStepBps}`);
  }
  if (!Number.isFinite(pct) || pct <= -100 || pct === 0) {
    throw new Error(`Invalid pctChange: ${pctChange}`);
  }
  const r = 1 + step / 10000;
  const t = 1 + pct / 100;
  return Math.max(1, Math.round(Math.abs(Math.log(t)) / Math.log(r)));
}

/**
 * Ekstrak komponen sewa NON-REFUNDABLE dari hasil pool.quoteCreatePosition.
 * Catatan penting tentang rent DLMM Meteora:
 *  - positionCost (~0.057 SOL) dikembalikan ke rent payer saat closePosition -> REFUNDABLE.
 *  - binArrayCost (~0.071 SOL per bin array baru) akun milik pool -> NON-REFUNDABLE.
 *  - bitmapExtensionCost: akun milik pool -> NON-REFUNDABLE.
 */
export function nonRefundableCost(quote) {
  const binArray = Number(quote?.binArrayCost ?? 0) || 0;
  const bitmap = Number(quote?.bitmapExtensionCost ?? 0) || 0;
  return binArray + bitmap;
}

export function exceedsNonRefundable(cost, maxSol) {
  const cap = Number.isFinite(Number(maxSol)) && Number(maxSol) >= 0 ? Number(maxSol) : 0;
  return cost > cap;
}

/** Tangga sisi SOL untuk Spot: coba -95% lalu mundur 5pp sampai -80%. Sisi token tetap +15%. */
export const SPOT_LOWER_PCT_LADDER = Object.freeze([-95, -90, -85, -80]);
export const SPOT_UPPER_PCT = 15;

/**
 * Tentukan rentang Spot dengan tangga sisi SOL [-95, -90, -85, -80] .. +15%.
 * Tiap step yang kena non-refundable rent (binArrayCost / bitmapExtensionCost)
 * diganti step berikutnya yang lebih sempit. Bila seluruh tangga masih kena,
 * kembalikan { ok: false, redflagNonRefundable: true }.
 * Deposit SOL satu sisi hanya masuk ke [minBinId .. activeBinId], sehingga
 * (activeBinId + 1 .. maxBinId] (+15% ke atas) menjadi bin kosong untuk ruang rebalance.
 */
export async function resolveSpotRangeWithRentCheck({
  pool,
  activeBinId,
  binStep,
  lowerPctLadder = SPOT_LOWER_PCT_LADDER,
  // Kompat: caller lama boleh kirim primary/fallback; diabaikan bila ladder ada.
  lowerPctPrimary,
  lowerPctFallback,
  upperPct = SPOT_UPPER_PCT,
  skipNonRefundable = true,
  maxNonRefundableSol = 0,
}) {
  const step = Number(binStep) > 0 ? Number(binStep) : 100;
  const binsAbove = calcBinsForPricePct(step, upperPct);
  const maxBinId = activeBinId + binsAbove;

  let ladder;
  if (Array.isArray(lowerPctLadder) && lowerPctLadder.length > 0) {
    ladder = lowerPctLadder.map(Number).filter((p) => Number.isFinite(p) && p > -100 && p < 0);
  } else if (Number.isFinite(Number(lowerPctPrimary))) {
    ladder = [Number(lowerPctPrimary)];
    if (Number.isFinite(Number(lowerPctFallback)) && Number(lowerPctFallback) !== Number(lowerPctPrimary)) {
      ladder.push(Number(lowerPctFallback));
    }
  } else {
    ladder = [...SPOT_LOWER_PCT_LADDER];
  }
  if (ladder.length === 0) ladder = [...SPOT_LOWER_PCT_LADDER];

  const costsByPct = {};
  let firstMinBinId = null;

  for (let i = 0; i < ladder.length; i++) {
    const lowerPct = ladder[i];
    const binsBelow = calcBinsForPricePct(step, lowerPct);
    const minBinId = activeBinId - binsBelow;
    if (i === 0) firstMinBinId = minBinId;

    let quote = null;
    if (typeof pool?.quoteCreatePosition === "function") {
      quote = await pool.quoteCreatePosition({
        strategy: { minBinId, maxBinId },
      });
    }
    const cost = nonRefundableCost(quote);
    costsByPct[lowerPct] = cost;

    const acceptWithoutCheck = i === 0 && !skipNonRefundable;
    if (acceptWithoutCheck || !exceedsNonRefundable(cost, maxNonRefundableSol)) {
      return {
        ok: true,
        minBinId,
        maxBinId,
        depositMinBinId: minBinId,
        depositMaxBinId: activeBinId,
        lowerPctUsed: lowerPct,
        upperPctUsed: upperPct,
        usedFallback: i > 0,
        nonRefundableSol: cost,
        costsByPct,
        costPrimarySol: costsByPct[ladder[0]],
        costFallbackSol: i > 0 ? cost : undefined,
        quote,
      };
    }

    if (i < ladder.length - 1) {
      log.warn(
        `Spot range ${lowerPct}%..${upperPct}% ([${minBinId}..${maxBinId}]) kena non-refundable rent ${cost.toFixed(6)} SOL — coba fallback ${ladder[i + 1]}%..${upperPct}%`
      );
    }
  }

  const costParts = ladder.map((p) => `${p}% (${Number(costsByPct[p] || 0).toFixed(6)} SOL)`).join(", ");
  const reason = `non-refundable rent masih muncul pada ${costParts} > batas ${maxNonRefundableSol} SOL`;
  return {
    ok: false,
    redflagNonRefundable: true,
    costsByPct,
    costPrimarySol: costsByPct[ladder[0]],
    costFallbackSol: costsByPct[ladder[ladder.length - 1]],
    minBinId95: firstMinBinId,
    maxBinId,
    upperPct,
    maxNonRefundableSol,
    reason,
  };
}

/**
 * Buka posisi Spot SOL satu sisi:
 *  - Rentang posisi on-chain penuh: [minBinId .. maxBinId] (tangga -95/-90/-85/-80% s/d +15%)
 *  - Deposit SOL satu sisi hanya di [depositMinBinId .. depositMaxBinId] ([minBinId .. activeBinId])
 *  - Bin (activeBinId + 1 .. maxBinId] dibiarkan kosong.
 * Bila pool mendukung createExtendedEmptyPosition dan rentang > 70 bin (atau ada bin kosong di atas),
 * posisi diinisialisasi lewat createExtendedEmptyPosition lalu diisi per chunk <= 70 bin.
 */
export async function openSpotSolPosition({
  pool,
  connection,
  wallet,
  feePlan,
  baseIsX,
  solLamports,
  minBinId,
  maxBinId,
  depositMinBinId = minBinId,
  depositMaxBinId = maxBinId,
  strategyType = 0,
  slippage = 10,
  sendAndConfirmFn = sendAndConfirmRobust,
  newPositionKeypair = null,
  maxBinsPerChunk = 70,
  maxChunkRetries = 3,
}) {
  const newPosition = newPositionKeypair || Keypair.generate();
  const totalBins = maxBinId - minBinId + 1;
  const useExtended =
    typeof pool?.createExtendedEmptyPosition === "function" &&
    (totalBins > maxBinsPerChunk || maxBinId > depositMaxBinId);

  const txSigs = [];

  if (useExtended) {
    const rawInitTx = await pool.createExtendedEmptyPosition(
      minBinId,
      maxBinId,
      newPosition.publicKey,
      wallet.publicKey
    );
    const initTxs = Array.isArray(rawInitTx) ? rawInitTx : [rawInitTx];
    for (const initTx of initTxs) {
      const sig = await sendAndConfirmFn({
        connection,
        tx: initTx,
        signers: [wallet, newPosition],
        feePlan,
        wallet,
      });
      txSigs.push(sig);
    }

    const chunks = chunkSpotRanges(depositMinBinId, depositMaxBinId, solLamports, maxBinsPerChunk);
    let chunksAdded = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const totalXAmount = baseIsX ? new BN(0) : chunk.amountRaw;
      const totalYAmount = baseIsX ? chunk.amountRaw : new BN(0);

      let lastErr = null;
      let chunkDone = false;
      for (let attempt = 1; attempt <= maxChunkRetries; attempt++) {
        try {
          const rawAddTx = await pool.addLiquidityByStrategy({
            positionPubKey: newPosition.publicKey,
            user: wallet.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
              minBinId: chunk.minBinId,
              maxBinId: chunk.maxBinId,
              strategyType,
            },
            slippage,
          });
          const addTxs = Array.isArray(rawAddTx) ? rawAddTx : [rawAddTx];
          for (const addTx of addTxs) {
            const sig = await sendAndConfirmFn({
              connection,
              tx: addTx,
              signers: [wallet],
              feePlan,
              wallet,
            });
            txSigs.push(sig);
          }
          chunksAdded++;
          chunkDone = true;
          break;
        } catch (err) {
          lastErr = err;
          log.warn(
            `Spot chunk ${i + 1}/${chunks.length} [${chunk.minBinId}..${chunk.maxBinId}] gagal (attempt ${attempt}/${maxChunkRetries}): ${err.message}`
          );
        }
      }

      if (!chunkDone && chunksAdded === 0) {
        throw lastErr || new Error("Gagal deposit chunk pertama posisi Spot");
      }
    }

    return {
      positionPubkey: newPosition.publicKey.toString(),
      txSigs,
      lastSig: txSigs[txSigs.length - 1] || "",
      chunksAdded,
      totalChunks: chunks.length,
      usedExtended: true,
    };
  }

  // Fallback untuk rentang <= 70 bin tanpa empty upper bins, atau unit test mock
  const lamportsBn = BN.isBN(solLamports) ? solLamports : new BN(String(solLamports));
  const totalXAmount = baseIsX ? new BN(0) : lamportsBn;
  const totalYAmount = baseIsX ? lamportsBn : new BN(0);

  const rawCreateTx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId,
      minBinId,
      strategyType,
    },
    slippage,
  });

  const txs = Array.isArray(rawCreateTx) ? rawCreateTx : [rawCreateTx];
  for (let i = 0; i < txs.length; i++) {
    const signers = i === 0 ? [wallet, newPosition] : [wallet];
    const sig = await sendAndConfirmFn({
      connection,
      tx: txs[i],
      signers,
      feePlan,
      wallet,
    });
    txSigs.push(sig);
  }

  return {
    positionPubkey: newPosition.publicKey.toString(),
    txSigs,
    lastSig: txSigs[txSigs.length - 1] || "",
    chunksAdded: 1,
    totalChunks: 1,
    usedExtended: false,
  };
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

export function calcSpotPoolEfficiencyScore({ tvlUsd = 0, fees24hUsd = 0, cumFeesUsd = 0 } = {}) {
  return (Number(tvlUsd) || 0) + (Number(fees24hUsd) || 0) * 5 + (Number(cumFeesUsd) || 0);
}

/**
 * Ambil seluruh pool Meteora DLMM TOKEN/SOL yang tidak di-blacklist untuk baseMint,
 * lalu urutkan dari skor efisiensi tertinggi (TVL + 24h fees * 5 + cumFees).
 */
export async function fetchTokenSolDlmmPools(baseMint, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
  if (!baseMint || typeof fetchFn !== "function") return [];
  try {
    const url = `https://dlmm.datapi.meteora.ag/pools?page=1&page_size=20&query=${encodeURIComponent(baseMint)}`;
    const res = await fetchFn(url, {
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res?.ok) return [];
    const json = await res.json();
    const raw = Array.isArray(json?.data) ? json.data : [];
    const pools = [];

    for (const p of raw) {
      if (!p?.address || p.is_blacklisted) continue;
      const xAddr = p.token_x?.address;
      const yAddr = p.token_y?.address;
      const isTokenSol = (xAddr === WSOL_MINT && yAddr === baseMint) || (yAddr === WSOL_MINT && xAddr === baseMint);
      if (!isTokenSol) continue;

      const tvlUsd = Number(p.tvl || 0);
      const vol24hUsd = Number(p.volume?.["24h"] || 0);
      const fees24hUsd = Number(p.fees?.["24h"] || 0);
      const cumFeesUsd = Number(p.cumulative_metrics?.fees || 0);
      const efficiencyScore = calcSpotPoolEfficiencyScore({ tvlUsd, fees24hUsd, cumFeesUsd });

      pools.push({
        address: p.address,
        name: p.name || "",
        binStep: Number(p.pool_config?.bin_step || 100),
        baseFeePct: Number(p.pool_config?.base_fee_pct || 0),
        tvlUsd,
        vol24hUsd,
        fees24hUsd,
        cumFeesUsd,
        efficiencyScore,
      });
    }

    pools.sort((a, b) => b.efficiencyScore - a.efficiencyScore);
    return pools;
  } catch (err) {
    log.debug(`[detail] fetchTokenSolDlmmPools gagal untuk ${String(baseMint).slice(0, 8)}: ${err.message}`);
    return [];
  }
}

export async function auditSpotPoolCandidate({
  poolAddress,
  poolMeta = {},
  getPoolInfoFn,
  connection,
  skipNonRefundable = true,
  maxNonRefundableSol = 0,
}) {
  try {
    const poolInfo = await getPoolInfoFn(poolAddress);
    if (!poolInfo || poolInfo.unsupported || !poolInfo.baseMint || !poolInfo.pool) {
      return { ok: false, poolAddress, reason: "unsupported" };
    }

    const { pool, baseIsX } = poolInfo;
    const activeBin = await pool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const hasBinStep = Number(pool.lbPair?.binStep) > 0;
    const binStep = hasBinStep ? Number(pool.lbPair.binStep) : Number(poolMeta?.binStep || 100);

    let rangeRes = { ok: true, usedFallback: false };
    if (hasBinStep) {
      rangeRes = await resolveSpotRangeWithRentCheck({
        pool,
        activeBinId,
        binStep,
        skipNonRefundable,
        maxNonRefundableSol,
      });
    }

    let bins31RequiredGe1SolCount = 31;
    let totalSolIn35Bins = 0;
    const xIsSol = !baseIsX;

    if (typeof pool.getBinsAroundActiveBin === "function") {
      try {
        const around = await pool.getBinsAroundActiveBin(40, 40);
        const binsList = around?.bins || [];
        const binMap = new Map(binsList.map((b) => [Number(b.binId), b]));
        bins31RequiredGe1SolCount = 0;
        for (let offset = 0; offset <= 34; offset++) {
          const bid = xIsSol ? activeBinId + offset : activeBinId - offset;
          const b = binMap.get(bid);
          const rawLamports = b
            ? Number(xIsSol ? (b.xAmount?.toString?.() ?? b.xAmount) : (b.yAmount?.toString?.() ?? b.yAmount))
            : 0;
          const solAmt = (Number(rawLamports) || 0) / 1e9;
          totalSolIn35Bins += solAmt;
          if (offset >= 4 && solAmt >= 1.0) {
            bins31RequiredGe1SolCount++;
          }
        }
      } catch {
        bins31RequiredGe1SolCount = Number(pool.mockBins31Ge1Sol ?? 0);
      }
    } else if (pool.mockBins31Ge1Sol != null) {
      bins31RequiredGe1SolCount = Number(pool.mockBins31Ge1Sol);
    }

    let lpCount = 20;
    if (connection && typeof connection.getProgramAccounts === "function") {
      try {
        const posAccts = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
          dataSlice: { offset: 40, length: 0 },
          filters: [{ memcmp: { offset: 8, bytes: poolAddress } }],
        });
        lpCount = Array.isArray(posAccts) ? posAccts.length : 0;
      } catch {
        lpCount = Number(pool.mockLpCount ?? 20);
      }
    } else if (pool.mockLpCount != null) {
      lpCount = Number(pool.mockLpCount);
    }

    const tvlUsd = Number(poolMeta?.tvlUsd || 0);
    const fees24hUsd = Number(poolMeta?.fees24hUsd || 0);
    const cumFeesUsd = Number(poolMeta?.cumFeesUsd || 0);
    const efficiencyScore =
      poolMeta?.efficiencyScore != null
        ? Number(poolMeta.efficiencyScore)
        : calcSpotPoolEfficiencyScore({ tvlUsd, fees24hUsd, cumFeesUsd });

    const rentOk = Boolean(rangeRes?.ok);
    const passes3BinToleranceRule = bins31RequiredGe1SolCount === 31;
    const passesLp20 = lpCount >= 20;
    const passedStage2 = rentOk && passes3BinToleranceRule && passesLp20;

    return {
      ok: true,
      poolAddress,
      poolInfo,
      activeBin,
      rangeRes,
      rentOk,
      passedStage2,
      passes3BinToleranceRule,
      bins31RequiredGe1SolCount,
      totalSolIn35Bins: Number(totalSolIn35Bins.toFixed(4)),
      lpCount,
      tvlUsd,
      fees24hUsd,
      cumFeesUsd,
      efficiencyScore,
    };
  } catch (err) {
    return { ok: false, poolAddress, reason: err.message };
  }
}

export function compareSpotPoolAudits(a, b) {
  const aRent = a?.rentOk ? 1 : 0;
  const bRent = b?.rentOk ? 1 : 0;
  if (bRent !== aRent) return bRent - aRent;

  const aStage2 = a?.passedStage2 ? 1 : 0;
  const bStage2 = b?.passedStage2 ? 1 : 0;
  if (bStage2 !== aStage2) return bStage2 - aStage2;

  const aBins = Number(a?.bins31RequiredGe1SolCount || 0);
  const bBins = Number(b?.bins31RequiredGe1SolCount || 0);
  if (bBins !== aBins) return bBins - aBins;

  const aEff = Number(a?.efficiencyScore || 0);
  const bEff = Number(b?.efficiencyScore || 0);
  if (bEff !== aEff) return bEff - aEff;

  const aLp = Number(a?.lpCount || 0);
  const bLp = Number(b?.lpCount || 0);
  if (bLp !== aLp) return bLp - aLp;

  return Number(b?.tvlUsd || 0) - Number(a?.tvlUsd || 0);
}

function positiveBinStep(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Sewa non-refundable terkecil pada tangga range. Null bila angkanya tidak ada. */
export function minSpotNonRefundableSol(costsByPct) {
  if (!costsByPct || typeof costsByPct !== "object") return null;
  let min = null;
  for (const value of Object.values(costsByPct)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (min == null || n < min) min = n;
  }
  return min;
}

/** Ringkas hasil sewa satu kandidat untuk alert. Tidak dipakai untuk memilih pool. */
export function summarizeSpotRentCheck(audit, meta = {}) {
  const costs = audit?.rangeRes?.costsByPct;
  const minNonRefundableSol = minSpotNonRefundableSol(costs);
  return {
    poolAddress: audit?.poolAddress || meta?.address || null,
    binStep: positiveBinStep(audit?.poolInfo?.pool?.lbPair?.binStep) ?? positiveBinStep(meta?.binStep),
    rentOk: audit?.rentOk === true,
    minNonRefundableSol,
    costsByPct: costs && typeof costs === "object" ? costs : undefined,
  };
}

/**
 * Evaluasi seluruh kandidat pool DLMM TOKEN/SOL untuk baseMint dan pilih pool
 * paling efisien yang rentOk (urutan compareSpotPoolAudits: sewa, kepadatan bin,
 * LP, skor, TVL). Tidak ada syarat bin step. Pool di `notRentOkPools` dipaksa
 * tidak rentOk bila SPOT_RENT_FALLBACK_POOL nyala. Bila tidak ada yang rentOk,
 * tetap di currentPool. `rentChecks` memuat setiap kandidat yang dievaluasi
 * (termasuk yang auditnya gagal) beserta sewa minimumnya; pilihan pool tidak berubah.
 */
export async function selectMostEfficientSpotPool({
  currentPool,
  baseMint,
  getPoolInfoFn,
  connection,
  skipNonRefundable = true,
  maxNonRefundableSol = 0,
  fetchFn = fetch,
  discoverPoolsFn = null,
  maxCandidates = 3,
  notRentOkPools = null,
  rentFallbackPool = null,
}) {
  if (!currentPool || !baseMint) {
    return {
      chosenPoolAddress: currentPool,
      switched: false,
      chosenAudit: null,
      candidatesAudited: [],
      rentChecks: [],
    };
  }

  const discovered =
    typeof discoverPoolsFn === "function"
      ? await discoverPoolsFn(baseMint)
      : await fetchTokenSolDlmmPools(baseMint, { fetchFn });

  const list = Array.isArray(discovered) ? discovered.slice() : [];
  if (list.length === 0) {
    return {
      chosenPoolAddress: currentPool,
      switched: false,
      chosenAudit: null,
      candidatesAudited: [],
      rentChecks: [],
    };
  }

  list.sort((a, b) => {
    const scoreA = a.efficiencyScore ?? calcSpotPoolEfficiencyScore(a);
    const scoreB = b.efficiencyScore ?? calcSpotPoolEfficiencyScore(b);
    return scoreB - scoreA;
  });

  const shortlist = list.slice(0, Math.max(1, maxCandidates));
  if (!shortlist.some((p) => p.address === currentPool)) {
    const existingCur = list.find((p) => p.address === currentPool) || {
      address: currentPool,
      tvlUsd: 0,
      fees24hUsd: 0,
      cumFeesUsd: 0,
      efficiencyScore: 0,
    };
    shortlist.push(existingCur);
  }

  // Bila hanya ada 1 pool (currentPool saja), tidak perlu bandingkan multi-pool
  if (shortlist.length <= 1 && shortlist[0]?.address === currentPool) {
    return {
      chosenPoolAddress: currentPool,
      switched: false,
      chosenAudit: null,
      candidatesAudited: [],
      rentChecks: [],
    };
  }

  const audited = [];
  const attempted = [];
  for (const cand of shortlist) {
    const audit = await auditSpotPoolCandidate({
      poolAddress: cand.address,
      poolMeta: cand,
      getPoolInfoFn,
      connection,
      skipNonRefundable,
      maxNonRefundableSol,
    });
    attempted.push({ cand, audit });
    if (audit.ok) audited.push(audit);
  }

  const rentChecksFor = () =>
    attempted.map(({ cand, audit }) =>
      audit?.ok
        ? summarizeSpotRentCheck(audit, cand)
        : {
            poolAddress: cand.address,
            binStep: positiveBinStep(cand.binStep),
            rentOk: false,
            minNonRefundableSol: null,
          }
    );

  if (audited.length === 0) {
    return {
      chosenPoolAddress: currentPool,
      switched: false,
      chosenAudit: null,
      candidatesAudited: [],
      rentChecks: rentChecksFor(),
    };
  }

  const fallbackOn = rentFallbackPool == null ? config.spotRentFallbackPool !== false : rentFallbackPool !== false;
  const blocked = new Set((Array.isArray(notRentOkPools) ? notRentOkPools : []).filter(Boolean));
  if (fallbackOn && blocked.size > 0) {
    for (const audit of audited) {
      if (!blocked.has(audit.poolAddress)) continue;
      audit.rentOk = false;
      audit.passedStage2 = false;
    }
  }

  audited.sort(compareSpotPoolAudits);
  const best = audited[0];
  const currentAudit = audited.find((a) => a.poolAddress === currentPool) || null;
  const rentChecks = rentChecksFor();

  if (fallbackOn) {
    const pick = audited.find((a) => a.rentOk);
    if (!pick) {
      return {
        chosenPoolAddress: currentPool,
        switched: false,
        chosenAudit: currentAudit,
        currentAudit,
        candidatesAudited: audited,
        rentChecks,
      };
    }
    return {
      chosenPoolAddress: pick.poolAddress,
      switched: pick.poolAddress !== currentPool,
      chosenAudit: pick,
      currentAudit,
      candidatesAudited: audited,
      rentChecks,
    };
  }

  // Sakelar mati: perilaku lama. Jangan pindah bila pool teratas gagal rent.
  if (best.poolAddress !== currentPool && !best.rentOk) {
    return {
      chosenPoolAddress: currentPool,
      switched: false,
      chosenAudit: currentAudit,
      currentAudit,
      candidatesAudited: audited,
      rentChecks,
    };
  }

  return {
    chosenPoolAddress: best.poolAddress,
    switched: best.poolAddress !== currentPool,
    chosenAudit: best,
    currentAudit,
    candidatesAudited: audited,
    rentChecks,
  };
}
