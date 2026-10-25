import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
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

/**
 * Tentukan rentang Spot [-95% .. +15%] dengan fallback [-90% .. +15%] bila kena
 * biaya sewa non-refundable (binArrayCost / bitmapExtensionCost).
 * Bila -90% masih kena non-refundable rent, kembalikan { ok: false, redflagNonRefundable: true }.
 * Deposit SOL satu sisi hanya masuk ke [minBinId .. activeBinId], sehingga
 * (activeBinId + 1 .. maxBinId] (+15% ke atas) menjadi bin kosong untuk ruang rebalance.
 */
export async function resolveSpotRangeWithRentCheck({
  pool,
  activeBinId,
  binStep,
  lowerPctPrimary = -95,
  lowerPctFallback = -90,
  upperPct = 15,
  skipNonRefundable = true,
  maxNonRefundableSol = 0,
}) {
  const step = Number(binStep) > 0 ? Number(binStep) : 100;
  const binsAbove = calcBinsForPricePct(step, upperPct);
  const maxBinId = activeBinId + binsAbove;

  const binsBelowPrimary = calcBinsForPricePct(step, lowerPctPrimary);
  const minBinId95 = activeBinId - binsBelowPrimary;

  let quote95 = null;
  if (typeof pool?.quoteCreatePosition === "function") {
    quote95 = await pool.quoteCreatePosition({
      strategy: { minBinId: minBinId95, maxBinId },
    });
  }
  const cost95 = nonRefundableCost(quote95);

  if (!skipNonRefundable || !exceedsNonRefundable(cost95, maxNonRefundableSol)) {
    return {
      ok: true,
      minBinId: minBinId95,
      maxBinId,
      depositMinBinId: minBinId95,
      depositMaxBinId: activeBinId,
      lowerPctUsed: lowerPctPrimary,
      upperPctUsed: upperPct,
      usedFallback: false,
      nonRefundableSol: cost95,
      quote: quote95,
    };
  }

  log.warn(
    `Spot range ${lowerPctPrimary}%..${upperPct}% ([${minBinId95}..${maxBinId}]) kena non-refundable rent ${cost95.toFixed(6)} SOL — coba fallback ${lowerPctFallback}%..${upperPct}%`
  );

  const binsBelowFallback = calcBinsForPricePct(step, lowerPctFallback);
  const minBinId90 = activeBinId - binsBelowFallback;

  let quote90 = null;
  if (typeof pool?.quoteCreatePosition === "function") {
    quote90 = await pool.quoteCreatePosition({
      strategy: { minBinId: minBinId90, maxBinId },
    });
  }
  const cost90 = nonRefundableCost(quote90);

  if (!exceedsNonRefundable(cost90, maxNonRefundableSol)) {
    return {
      ok: true,
      minBinId: minBinId90,
      maxBinId,
      depositMinBinId: minBinId90,
      depositMaxBinId: activeBinId,
      lowerPctUsed: lowerPctFallback,
      upperPctUsed: upperPct,
      usedFallback: true,
      nonRefundableSol: cost90,
      costPrimarySol: cost95,
      quote: quote90,
    };
  }

  const reason = `non-refundable rent masih muncul pada ${lowerPctPrimary}% (${cost95.toFixed(6)} SOL) dan fallback ${lowerPctFallback}% (${cost90.toFixed(6)} SOL) > batas ${maxNonRefundableSol} SOL`;
  return {
    ok: false,
    redflagNonRefundable: true,
    costPrimarySol: cost95,
    costFallbackSol: cost90,
    minBinId95,
    minBinId90,
    maxBinId,
    reason,
  };
}

/**
 * Buka posisi Spot SOL satu sisi:
 *  - Rentang posisi on-chain penuh: [minBinId .. maxBinId] (-95% atau -90% s/d +15%)
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
