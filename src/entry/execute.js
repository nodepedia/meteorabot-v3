import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import config, { BINS_BELOW, BINS_ABOVE, STRATEGY } from "../config/index.js";
import log from "../core/logger.js";
import * as tg from "../notify/telegram.js";
import { getConnection } from "../solana/connection.js";
import { getWallet } from "../solana/wallet.js";
import { getTokenBalance, getMintDecimals } from "../solana/balances.js";
import { swapSolToToken, swapToSol } from "../solana/swap.js";
import { buildFeePlan, checkFeeCap } from "../solana/fees.js";
import { sendAndConfirmRobust } from "../solana/send.js";
import { getDlmmSdk } from "../meteora/sdk.js";
import { getPoolInfo } from "./pool-info.js";
import { guardPoolPrice, poolPriceSolPerToken } from "./price-guard.js";
import {
  trackPosition,
  setEntryPoolPrice,
  recordTrackedRange,
  setEntrySizeSol,
  setInitialCapitalSol,
  getOpenPositionsForMint,
} from "../state/positions.js";
import {
  resolveSpotRangeWithRentCheck,
  openSpotSolPosition,
  nonRefundableCost,
  exceedsNonRefundable,
} from "../meteora/spot-position.js";
import { bidaskSolEntryBinPlan, coveredEntryPrices } from "./bidask-sol-entry.js";
import { recordAction, recordSpotEntryAttempt, consumeSpotEntryAttempt } from "./runtime.js";
import { mintBlocksEntry } from "./candidates.js";

const STRATEGY_ENUM = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

export async function executeEntry(poolAddress, signal, sizeSol, opts = {}) {
  const { isDca = false } = opts;
  const { StrategyType } = await getDlmmSdk();
  const connection = getConnection();
  const wallet = getWallet();

  const { pool, baseMint, baseIsX, quoteMint, unsupported, collectFeeMode, pairName } = await getPoolInfo(poolAddress);

  if (unsupported || !baseMint) {
    return { success: false, error: `unsupported pool: pair bukan SOL (quote ${quoteMint || "?"})`, baseMint };
  }

  const split = Math.min(1, Math.max(0, Number(config.entry.sizeSplit)));
  const solSideSol = sizeSol * split;
  const tokenSideSol = sizeSol - solSideSol;

  if (sizeSol <= 0 || tokenSideSol <= 0) {
    return { success: false, error: `entry size/split invalid: size=${sizeSol}, split=${split}` };
  }

  const strategyType = StrategyType?.[STRATEGY_ENUM[STRATEGY] || "BidAsk"] ?? StrategyType?.BidAsk;
  if (strategyType === undefined) {
    return { success: false, error: `Unsupported strategy: ${STRATEGY}` };
  }

  // Baca bin aktif + rem harga. Saat deviasi di atas ambang, coba ulang beberapa
  // kali (baca ulang harga pool & pasar) sebelum menyerah. Dilakukan sebelum ada
  // SOL yang keluar. Gagal ambil harga pasar = lanjut (fail-open).
  let activeBin = null;
  if (config.entry.poolPriceCheck) {
    const label = pairName || poolAddress.slice(0, 8);
    const limit = config.entry.maxPoolPriceDeviationPct;
    const delayMs = Math.max(0, Number(config.entry.poolPriceRetryDelaySec) || 0) * 1000;
    const result = await guardPoolPrice({
      getActiveBin: () => pool.getActiveBin(),
      baseMint,
      baseIsX,
      thresholdPct: limit,
      signalTokenUsd: signal?.price,
      signalSolUsd: signal?.solPrice,
      lineUsd: signal?.line,
      lineTolerancePct: config.entry.poolLineTolerancePct,
      attempts: config.entry.poolPriceMaxAttempts,
      delayMs,
      onUnavailable: (guard) => log.warn(`Entry ${label}: ${guard.reason} — lanjut tanpa cek deviasi harga`),
      onRetry: ({ attempt, attempts, deviationPct }) =>
        log.warn(
          `Entry ${label}: harga pool ${deviationPct.toFixed(1)}% dari pasar (batas ${limit}%) — coba lagi ${attempt}/${attempts} dalam ${delayMs / 1000}s`
        ),
    });
    activeBin = result.activeBin;
    if (result.lineMiss) {
      const poolUsd = Number(result.guard.poolPriceUsd);
      const lineUsd = Number(result.guard.lineLimitUsd);
      return {
        success: false,
        skipped: true,
        lineMiss: true,
        reason: `harga pool ${poolUsd.toFixed(8)} > garis ${lineUsd.toFixed(8)} (hanya harga Jupiter yang turun)`,
        baseMint,
      };
    }
    if (result.exhausted) {
      const dev = result.guard.deviationPct.toFixed(1);
      log.warn(
        `Entry ${label} dibatalkan: harga pool ${dev}% dari pasar setelah ${result.attempts}x percobaan (batas ${limit}%)`
      );
      return {
        success: false,
        skipped: true,
        exhausted: true,
        attempts: result.attempts,
        deviationPct: result.guard.deviationPct,
        reason: `harga pool ${dev}% dari pasar (${result.attempts}x)`,
        baseMint,
      };
    }
  } else {
    activeBin = await pool.getActiveBin();
  }

  const activeBinId = activeBin.binId;
  const minBinId = activeBinId - BINS_BELOW;
  const maxBinId = activeBinId + BINS_ABOVE;

  log.debug(
    `[detail] Entry ${pairName || poolAddress.slice(0, 8)}: ${sizeSol} SOL (SOL ${solSideSol} | token ${tokenSideSol}) bins ${minBinId}→${maxBinId} active ${activeBinId}`
  );

  if (config.dryRun) {
    return {
      success: true,
      dryRun: true,
      pool: poolAddress,
      pair: pairName,
      baseMint,
      activeBinId,
      minBinId,
      maxBinId,
      solSideSol,
      tokenSideSol,
    };
  }

  // 1. Acquire the token side via Jupiter (SOL -> base token)
  const balanceSol = (await getConnection().getBalance(wallet.publicKey)) / 1e9;
  if (balanceSol < sizeSol + Number(config.entry.gasReserve)) {
    return {
      success: false,
      error: `insufficient SOL: have ${balanceSol.toFixed(4)}, need ${(sizeSol + config.entry.gasReserve).toFixed(4)}`,
    };
  }

  // Rencana fee (priority/Jito) + cek batas biaya sebelum membeli token.
  const feePlan = buildFeePlan();
  const feeCap = checkFeeCap(feePlan);
  if (!feeCap.ok) {
    log.error(
      `Entry ${poolAddress.slice(0, 8)} dibatalkan: estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`
    );
    return {
      success: false,
      error: `estimasi fee ${feeCap.totalSol.toFixed(6)} SOL > cap ${feeCap.cap} SOL (mode ${feePlan.mode})`,
      feeCap: true,
      baseMint,
    };
  }

  const swap = await swapSolToToken(baseMint, tokenSideSol);
  if (!swap.success) {
    return {
      success: false,
      error: `token-side swap failed: ${swap.error}`,
      rateLimited: !!swap.rateLimited,
      baseMint,
    };
  }
  const baseAmountUi = swap.amountOut ?? (await getTokenBalance(baseMint));
  if (!baseAmountUi || baseAmountUi <= 0) {
    return { success: false, error: "token-side swap produced zero tokens" };
  }

  const decimals = await getMintDecimals(baseMint);
  const baseAmountRaw = new BN(Math.floor(baseAmountUi * Math.pow(10, decimals)));
  const solLamports = new BN(Math.floor(solSideSol * 1e9));

  const totalXAmount = baseIsX ? baseAmountRaw : solLamports;
  const totalYAmount = baseIsX ? solLamports : baseAmountRaw;

  // 2. Initialize position + add liquidity (double-sided, BidAsk)
  const newPosition = Keypair.generate();
  let txHash = null;
  let recovered = false;
  try {
    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: config.entry.activeBinSlippagePct,
    });
    const sent = await sendAndConfirmRobust({
      connection,
      tx,
      signers: [wallet, newPosition],
      feePlan,
      wallet,
    });
    txHash = sent.signature;
  } catch (err) {
    log.error(`Entry tx failed for ${poolAddress.slice(0, 8)}: ${err.message}`);
    // Konfirmasi gagal bukan berarti tx tidak mendarat (mis. blockhash expired
    // padahal sudah masuk). Cek akun posisi sebelum me-revert token.
    let landed = false;
    try {
      landed = !!(await connection.getAccountInfo(newPosition.publicKey));
    } catch {
      landed = false;
    }
    if (landed) {
      recovered = true;
      txHash = err.signature || null;
      log.warn(
        `Entry ${pairName || poolAddress.slice(0, 8)}: konfirmasi gagal (${err.message}) tapi posisi ada on-chain — dianggap sukses`
      );
    } else {
      const orphaned = await getTokenBalance(baseMint);
      if (orphaned > 0) {
        const revert = await swapToSol(baseMint, orphaned);
        if (revert.success) {
          log.info(`Reverted ${orphaned} ${baseMint.slice(0, 8)} → SOL after failed entry`);
        } else {
          log.error(`Failed to revert ${orphaned} ${baseMint.slice(0, 8)} → SOL: ${revert.error}`);
        }
      }
      return { success: false, error: err.message, baseMint };
    }
  }

  const positionAddress = newPosition.publicKey.toString();
  const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;

  trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode, "bidask:double", isDca);
  setInitialCapitalSol(positionAddress, sizeSol);
  setEntryPoolPrice(positionAddress, poolPriceSolPerToken(activeBin, baseIsX));

  if (isDca) {
    // Naratif DCA ditangani pemanggil (entry/dca.js) agar tidak dobel.
    log.debug(`[detail] DCA entry ${pair}: position ${positionAddress} tx ${txHash?.slice(0, 16)}`);
  } else if (recovered) {
    log.info(`📌 ENTRY ${pair} — posisi terbuka (dipulihkan dari tx yang konfirmasinya gagal) — ${sizeSol} SOL`);
    recordAction(`ENTRY ${pair} — ${sizeSol} SOL`);
    tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });
  } else {
    log.info(`📌 ENTRY ${pair} — harga menyentuh garis tren → beli ${sizeSol} SOL`);
    const feeLabel = feePlan.mode !== "none" ? ` | fee ~${feeCap.totalSol.toFixed(6)} SOL (${feePlan.mode})` : "";
    log.debug(`[detail] pool ${poolAddress} | position ${positionAddress} | tx ${txHash?.slice(0, 16)}${feeLabel}`);
    recordAction(`ENTRY ${pair} — ${sizeSol} SOL`);
    tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });
  }

  return {
    success: true,
    position: positionAddress,
    pool: poolAddress,
    pair,
    tx: txHash,
    recovered,
    feeMode: feePlan.mode,
    feeSol: feeCap.totalSol,
  };
}

// Entry instan posisi Spot satu sisi SOL (tangga -95/-90/-85/-80%..+15% bila kena non-refundable rent).
// Deposit SOL hanya masuk ke [minBinId .. activeBinId], bin (activeBinId+1 .. maxBinId] dibiarkan kosong.
export async function executeSpotEntry(poolAddress, sizeSol, opts = {}) {
  const getPoolInfoFn = opts.getPoolInfo || getPoolInfo;
  const getDlmmSdkFn = opts.getDlmmSdk || getDlmmSdk;
  const getConnectionFn = opts.getConnection || getConnection;
  const getWalletFn = opts.getWallet || getWallet;
  const getSolBalanceFn = opts.getSolBalance || (() => getTokenBalance("SOL"));
  const buildFeePlanFn = opts.buildFeePlan || buildFeePlan;
  const checkFeeCapFn = opts.checkFeeCap || checkFeeCap;
  const sendAndConfirmFn = opts.sendAndConfirmRobust || sendAndConfirmRobust;
  const dryRun = opts.dryRun ?? config.dryRun;
  const skipNonRefundable = opts.skipNonRefundable ?? config.spotReentry?.skipNonRefundable ?? true;
  const maxNonRefundableSol = opts.maxNonRefundableSol ?? config.spotReentry?.maxNonRefundableSol ?? 0;

  try {
    if (!(sizeSol > 0)) {
      return { success: false, error: `spot entry size invalid: size=${sizeSol}` };
    }

    const { pool, baseMint, baseIsX, quoteMint, unsupported, collectFeeMode, pairName } =
      await getPoolInfoFn(poolAddress);
    if (unsupported || !baseMint) {
      return {
        success: false,
        error: `unsupported pool: pair bukan SOL (quote ${quoteMint || "?"})`,
        baseMint,
      };
    }

    if (!opts.allowDuplicateMint) {
      const block = mintBlocksEntry(getOpenPositionsForMint(baseMint), {
        pool: poolAddress,
        mint: baseMint,
        strategy: "spot",
      });
      if (block.block) {
        const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;
        return {
          success: false,
          skipped: true,
          duplicateMint: true,
          reason: block.otherPool
            ? `token ${pair} (${baseMint.slice(0, 8)}) sudah memiliki posisi aktif di pool lain`
            : `token ${pair} (${baseMint.slice(0, 8)}) sudah memiliki posisi spot aktif di pool ini`,
          baseMint,
          pair,
        };
      }
    }

    const activeBin = await pool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const binStep = Number(pool.lbPair?.binStep) || 100;

    const rangeRes = await resolveSpotRangeWithRentCheck({
      pool,
      activeBinId,
      binStep,
      skipNonRefundable,
      maxNonRefundableSol,
    });

    const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;

    if (!rangeRes.ok) {
      return {
        success: false,
        skipped: true,
        redflagNonRefundable: Boolean(rangeRes.redflagNonRefundable),
        cost95Sol: rangeRes.costPrimarySol,
        cost90Sol: rangeRes.costFallbackSol,
        costsByPct: rangeRes.costsByPct,
        upperPct: rangeRes.upperPct,
        maxNonRefundableSol: rangeRes.maxNonRefundableSol,
        binStep,
        reason: rangeRes.reason,
        baseMint,
        pair,
      };
    }

    const { minBinId, maxBinId, depositMinBinId, depositMaxBinId, lowerPctUsed, upperPctUsed, usedFallback } = rangeRes;

    log.info(
      `Executing SPOT entry on pool ${poolAddress.slice(0, 8)}... | size=${sizeSol} SOL | range=${lowerPctUsed}%..+${upperPctUsed}% ([${minBinId}..${maxBinId}], deposit SOL [${depositMinBinId}..${depositMaxBinId}])${usedFallback ? ` [fallback ${lowerPctUsed}%]` : ""}`
    );

    if (dryRun) {
      log.info(
        `[DRY RUN] Would open SPOT position (${lowerPctUsed}%..+${upperPctUsed}%, bins ${minBinId}..${maxBinId}, deposit ${depositMinBinId}..${depositMaxBinId}) with ${sizeSol} SOL single-sided`
      );
      return {
        success: true,
        dryRun: true,
        mode: "spot",
        minBinId,
        maxBinId,
        depositMinBinId,
        depositMaxBinId,
        lowerPctUsed,
        upperPctUsed,
        usedFallback,
      };
    }

    const solBalance = await getSolBalanceFn();
    const required = sizeSol + config.entry.gasReserve;
    if (solBalance < required) {
      return {
        success: false,
        error: `insufficient SOL: have ${solBalance.toFixed(4)}, need ${required.toFixed(4)}`,
      };
    }

    const feePlan = buildFeePlanFn();
    const feeCheck = checkFeeCapFn(feePlan);
    if (!feeCheck.ok) {
      return {
        success: false,
        error: `entry fee cap exceeded: est ${feeCheck.estimatedSol.toFixed(6)} SOL > max ${feeCheck.maxSol} SOL (mode=${feePlan.mode})`,
      };
    }

    const { StrategyType } = await getDlmmSdkFn();
    const strategyType = StrategyType?.Spot ?? 0;
    const solLamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const newPosition = Keypair.generate();

    // Catat attempt sebelum kirim tx supaya exit worker bisa reconcile size
    // bila proses crash / error padahal posisi sudah mendarat on-chain.
    recordSpotEntryAttempt({
      pool: poolAddress,
      mint: baseMint,
      sizeSol,
      minBinId,
      maxBinId,
      positionPubkey: newPosition.publicKey.toString(),
    });

    let openRes;
    let recovered = false;
    try {
      openRes = await openSpotSolPosition({
        pool,
        connection,
        wallet,
        feePlan,
        baseIsX,
        solLamports,
        minBinId,
        maxBinId,
        depositMinBinId,
        depositMaxBinId,
        strategyType,
        slippage: config.entry.activeBinSlippagePct,
        sendAndConfirmFn,
        newPositionKeypair: newPosition,
      });
    } catch (txErr) {
      // Konfirmasi gagal / Custom error bukan berarti akun posisi tidak ada
      // (mis. createExtendedEmptyPosition sukses, chunk deposit gagal; atau
      // timeout padahal tx sudah land). Baca ulang on-chain sebelum menyerah.
      let landed = false;
      try {
        const info = await connection.getAccountInfo(newPosition.publicKey, "confirmed");
        landed = Boolean(info);
      } catch {
        landed = false;
      }
      if (!landed) {
        consumeSpotEntryAttempt({ positionPubkey: newPosition.publicKey.toString(), pool: poolAddress });
        throw txErr;
      }
      recovered = true;
      openRes = {
        positionPubkey: newPosition.publicKey.toString(),
        txSigs: [],
        lastSig: txErr.signature || "",
      };
      log.warn(
        `Spot entry ${pair}: konfirmasi/tx gagal (${txErr.message}) tapi posisi ${openRes.positionPubkey.slice(0, 8)} ada on-chain — anggap sukses & simpan size ${sizeSol} SOL`
      );
    }

    const positionAddress = openRes.positionPubkey;
    const lastSig = openRes.lastSig;

    log.info(
      `SPOT position opened: ${positionAddress} (tx: ${lastSig || "?"})${recovered ? " [recovered]" : ""} | bins [${minBinId}..${maxBinId}] (${lowerPctUsed}%..+${upperPctUsed}%), SOL [${depositMinBinId}..${depositMaxBinId}]`
    );

    trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode ?? null, "spot", false);
    recordTrackedRange(positionAddress, minBinId, maxBinId);
    setEntrySizeSol(positionAddress, sizeSol);
    setInitialCapitalSol(positionAddress, sizeSol);
    consumeSpotEntryAttempt({
      positionPubkey: positionAddress,
      pool: poolAddress,
      lowerBin: minBinId,
      upperBin: maxBinId,
    });
    const entryPoolPrice = poolPriceSolPerToken(activeBin, baseIsX);
    if (entryPoolPrice != null) setEntryPoolPrice(positionAddress, entryPoolPrice);

    if (recovered) {
      recordAction(`ENTRY ${pair} — spot ${sizeSol} SOL (dipulihkan dari tx gagal, bin ${minBinId}..${maxBinId})`);
    } else {
      recordAction(
        `ENTRY ${pair} — spot ${sizeSol} SOL (${lowerPctUsed}%..+${upperPctUsed}%, bin ${minBinId}..${maxBinId})`
      );
    }

    await tg.notifyEntry({
      pool: poolAddress,
      pair,
      position: positionAddress,
      sizeSol,
      solAmount: sizeSol,
      tokenAmountSol: 0,
      strategy: `spot (${lowerPctUsed}%..+${upperPctUsed}%, SOL 1-sisi)`,
      txSig: lastSig,
      dryRun: false,
    });

    return {
      success: true,
      mode: "spot",
      position: positionAddress,
      txSig: lastSig,
      recovered,
      minBinId,
      maxBinId,
      depositMinBinId,
      depositMaxBinId,
      lowerPctUsed,
      upperPctUsed,
      usedFallback,
    };
  } catch (err) {
    log.error(`Spot entry execution failed on ${poolAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Entry bidask:sol dari harga Jupiter. Satu posisi [min..max], SOL BidAsk hanya
// di [min..bin aktif], bin di atasnya kosong. Lebar >70 bin atau bin atas kosong
// memakai createExtendedEmptyPosition (lihat openSpotSolPosition).
export async function executeBidaskSolEntry(poolAddress, sizeSol, opts = {}) {
  const getPoolInfoFn = opts.getPoolInfo || getPoolInfo;
  const getDlmmSdkFn = opts.getDlmmSdk || getDlmmSdk;
  const getConnectionFn = opts.getConnection || getConnection;
  const getWalletFn = opts.getWallet || getWallet;
  const getSolBalanceFn = opts.getSolBalance || (() => getTokenBalance("SOL"));
  const buildFeePlanFn = opts.buildFeePlan || buildFeePlan;
  const checkFeeCapFn = opts.checkFeeCap || checkFeeCap;
  const sendAndConfirmFn = opts.sendAndConfirmRobust || sendAndConfirmRobust;
  const notifyFn = opts.notifyEntry || tg.notifyEntry;
  const dryRun = opts.dryRun ?? config.dryRun;
  const skipNonRefundable = opts.skipNonRefundable ?? config.spotReentry?.skipNonRefundable ?? true;
  const maxNonRefundableSol = opts.maxNonRefundableSol ?? config.spotReentry?.maxNonRefundableSol ?? 0;
  const maxBins = Math.max(1, Math.floor(Number(opts.maxBins ?? config.entry.bidaskSolMaxBins) || 169));
  const lowerPct = opts.lowerPct ?? config.entry.bidaskSolLowerPct;
  const upperPct = opts.upperPct ?? config.entry.bidaskSolUpperPct;

  try {
    if (!(sizeSol > 0)) {
      return { success: false, error: `bidask:sol entry size invalid: size=${sizeSol}` };
    }

    let info;
    try {
      info = opts.poolInfo || (await getPoolInfoFn(poolAddress));
    } catch (err) {
      return { success: false, skipped: true, tryNext: true, invalidPool: true, reason: err.message };
    }
    const { pool, baseMint, baseIsX, quoteMint, unsupported, collectFeeMode, pairName } = info;
    if (unsupported || !baseMint || !pool) {
      return {
        success: false,
        skipped: true,
        tryNext: true,
        invalidPool: true,
        reason: `pair bukan SOL (quote ${quoteMint || "?"})`,
        baseMint,
      };
    }

    if (!opts.allowDuplicateMint) {
      const block = mintBlocksEntry(getOpenPositionsForMint(baseMint), {
        pool: poolAddress,
        mint: baseMint,
        strategy: "bidask",
      });
      if (block.block) {
        const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;
        return {
          success: false,
          skipped: true,
          duplicateMint: true,
          reason: block.otherPool
            ? `token ${pair} (${baseMint.slice(0, 8)}) sudah memiliki posisi aktif di pool lain`
            : `token ${pair} (${baseMint.slice(0, 8)}) sudah memiliki posisi bidask aktif di pool ini`,
          baseMint,
          pair,
        };
      }
    }

    const activeBin = await pool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const binStep = Number(pool.lbPair?.binStep) || Number(opts.binStepHint) || 0;
    const plan = bidaskSolEntryBinPlan({ binStep, activeBinId, lowerPct, upperPct });
    const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;
    if (!plan) {
      return { success: false, skipped: true, tryNext: true, reason: `bin step tidak valid (${binStep})`, pair };
    }
    if (plan.binCount > maxBins) {
      return {
        success: false,
        skipped: true,
        tryNext: true,
        reason: `butuh ${plan.binCount} bin > ${maxBins} (step ${binStep})`,
        pair,
        binCount: plan.binCount,
      };
    }

    // SDK quoteCreatePosition (dlmm 1.9.x) menghitung bin array di seluruh
    // [minBinId..maxBinId], termasuk posisi lebih lebar dari 70 bin.
    // Tanpa fungsi itu, dan cek sewa nyala, jangan lanjut diam-diam.
    if (skipNonRefundable && typeof pool.quoteCreatePosition !== "function") {
      return {
        success: false,
        skipped: true,
        tryNext: true,
        reason: "quote non-refundable tidak tersedia",
        pair,
      };
    }
    if (typeof pool.quoteCreatePosition === "function") {
      try {
        const quote = await pool.quoteCreatePosition({
          strategy: { minBinId: plan.minBinId, maxBinId: plan.maxBinId },
        });
        const nonRef = nonRefundableCost(quote);
        if (skipNonRefundable && exceedsNonRefundable(nonRef, maxNonRefundableSol)) {
          return {
            success: false,
            skipped: true,
            tryNext: true,
            reason: `sewa non-refundable ${nonRef.toFixed(6)} SOL > batas ${maxNonRefundableSol} (step ${binStep})`,
            pair,
          };
        }
      } catch (err) {
        return { success: false, skipped: true, tryNext: true, reason: `quote gagal: ${err.message}`, pair };
      }
    }

    const needsExtended = plan.binCount > 70 || plan.maxBinId > plan.depositMaxBinId;
    if (needsExtended && typeof pool.createExtendedEmptyPosition !== "function") {
      return {
        success: false,
        error: "SDK tidak mendukung createExtendedEmptyPosition untuk posisi lebar / bin atas kosong",
        pair,
      };
    }

    log.info(
      `Executing bidask:sol entry on pool ${poolAddress.slice(0, 8)}... | size=${sizeSol} SOL | step=${binStep} | ${plan.binCount} bin [${plan.minBinId}..${plan.maxBinId}], deposit SOL [${plan.depositMinBinId}..${plan.depositMaxBinId}]`
    );

    if (dryRun) {
      return { success: true, dryRun: true, mode: "bidask:sol", pair, ...plan };
    }

    const solBalance = await getSolBalanceFn();
    const required = sizeSol + config.entry.gasReserve;
    if (solBalance < required) {
      return {
        success: false,
        error: `insufficient SOL: have ${solBalance.toFixed(4)}, need ${required.toFixed(4)}`,
        pair,
      };
    }

    const feePlan = buildFeePlanFn();
    const feeCheck = checkFeeCapFn(feePlan);
    if (!feeCheck.ok) {
      const est = Number(feeCheck.totalSol ?? feeCheck.estimatedSol);
      const cap = feeCheck.cap ?? feeCheck.maxSol;
      return {
        success: false,
        error: `entry fee cap exceeded: est ${Number.isFinite(est) ? est.toFixed(6) : "?"} SOL > max ${cap} SOL (mode=${feePlan.mode})`,
        pair,
      };
    }

    const { StrategyType } = await getDlmmSdkFn();
    const strategyType = StrategyType?.BidAsk;
    if (strategyType === undefined) {
      return { success: false, error: "strategi BidAsk tidak tersedia", pair };
    }

    const solLamports = new BN(Math.floor(sizeSol * LAMPORTS_PER_SOL));
    const connection = getConnectionFn();
    const wallet = getWalletFn();
    const newPosition = Keypair.generate();

    let openRes;
    let recovered = false;
    try {
      openRes = await openSpotSolPosition({
        pool,
        connection,
        wallet,
        feePlan,
        baseIsX,
        solLamports,
        minBinId: plan.minBinId,
        maxBinId: plan.maxBinId,
        depositMinBinId: plan.depositMinBinId,
        depositMaxBinId: plan.depositMaxBinId,
        strategyType,
        slippage: config.entry.activeBinSlippagePct,
        sendAndConfirmFn,
        newPositionKeypair: newPosition,
      });
    } catch (txErr) {
      let landed = false;
      try {
        const infoOnChain = await connection.getAccountInfo(newPosition.publicKey, "confirmed");
        landed = Boolean(infoOnChain);
      } catch {
        landed = false;
      }
      if (!landed) throw txErr;
      recovered = true;
      openRes = {
        positionPubkey: newPosition.publicKey.toString(),
        txSigs: [],
        lastSig: txErr.signature || "",
      };
      log.warn(
        `bidask:sol ${pair}: konfirmasi/tx gagal (${txErr.message}) tapi posisi ${openRes.positionPubkey.slice(0, 8)} ada on-chain — anggap sukses`
      );
    }

    const positionAddress = openRes.positionPubkey;
    const lastSig = openRes.lastSig;
    log.info(
      `bidask:sol position opened: ${positionAddress} (tx: ${lastSig || "?"})${recovered ? " [recovered]" : ""} | bins [${plan.minBinId}..${plan.maxBinId}], SOL [${plan.depositMinBinId}..${plan.depositMaxBinId}]`
    );

    trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode ?? null, "bidask:sol", false, {
      initialCapitalSol: sizeSol,
      openBinsBelow: plan.binsBelow,
      openBinsAbove: plan.binsAbove,
    });
    recordTrackedRange(positionAddress, plan.minBinId, plan.maxBinId);
    setEntrySizeSol(positionAddress, sizeSol);
    setInitialCapitalSol(positionAddress, sizeSol);
    const entryPoolPrice = poolPriceSolPerToken(activeBin, baseIsX);
    if (entryPoolPrice != null) setEntryPoolPrice(positionAddress, entryPoolPrice);

    const covered = coveredEntryPrices({
      entryPriceUnit: opts.entryPriceUnit,
      solPerToken: poolPriceSolPerToken(activeBin, baseIsX),
      solUsd: opts.solPrice,
      triggerPrice: opts.triggerPrice,
      priceUsd: opts.priceUsd,
      binStep,
      binsBelow: plan.binsBelow,
      binsAbove: plan.binsAbove,
    });

    recordAction(
      `ENTRY ${pair} — bidask:sol ${sizeSol} SOL (step ${binStep}, ${plan.binCount} bin, ${plan.minBinId}..${plan.maxBinId})`
    );
    await notifyFn({
      pool: poolAddress,
      pair,
      position: positionAddress,
      sizeSol,
      feeMode: feePlan.mode,
      feeSol: feeCheck.totalSol,
      modeLabel: "bidask:sol",
      binStep,
      tvlUsd: opts.tvlUsd,
      binCount: plan.binCount,
      priceFrom: covered.priceFrom,
      priceTo: covered.priceTo,
      priceUnit: covered.unit,
      priceRangeLabel: `${lowerPct}%..+${upperPct}%`,
    });

    return {
      success: true,
      mode: "bidask:sol",
      position: positionAddress,
      pair,
      txSig: lastSig,
      recovered,
      tvlUsd: opts.tvlUsd,
      ...plan,
      priceFrom: covered.priceFrom,
      priceTo: covered.priceTo,
      priceUnit: covered.unit,
    };
  } catch (err) {
    log.error(`bidask:sol entry execution failed on ${poolAddress}: ${err.message}`);
    return { success: false, error: err.message };
  }
}
