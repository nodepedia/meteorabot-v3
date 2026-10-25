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
import { trackPosition, setEntryPoolPrice, recordTrackedRange, setEntrySizeSol, getOpenPositionsForMint } from "../state/positions.js";
import { resolveSpotRangeWithRentCheck, openSpotSolPosition } from "../meteora/spot-position.js";
import { incrementEntryUsage, getEntryUsage, recordAction } from "./runtime.js";

const STRATEGY_ENUM = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk" };

export async function executeEntry(poolAddress, signal, sizeSol, opts = {}) {
  const { countUsage = true, isDca = false } = opts;
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
      onUnavailable: (guard) =>
        log.warn(`Entry ${label}: ${guard.reason} — lanjut tanpa cek deviasi harga`),
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
  setEntryPoolPrice(positionAddress, poolPriceSolPerToken(activeBin, baseIsX));
  const uses = countUsage ? incrementEntryUsage(poolAddress) : getEntryUsage(poolAddress);

  if (isDca) {
    // Naratif DCA ditangani pemanggil (entry/dca.js) agar tidak dobel.
    log.debug(`[detail] DCA entry ${pair}: position ${positionAddress} tx ${txHash?.slice(0, 16)} (use ${uses})`);
  } else if (recovered) {
    log.info(`📌 ENTRY ${pair} — posisi terbuka (dipulihkan dari tx yang konfirmasinya gagal) — ${sizeSol} SOL`);
    recordAction(`ENTRY ${pair} — ${sizeSol} SOL`);
    tg.notifyEntry({ pair, pool: poolAddress, feeMode: feePlan.mode, feeSol: feeCap.totalSol });
  } else {
    log.info(`📌 ENTRY ${pair} — harga menyentuh garis tren → beli ${sizeSol} SOL`);
    const feeLabel = feePlan.mode !== "none" ? ` | fee ~${feeCap.totalSol.toFixed(6)} SOL (${feePlan.mode})` : "";
    log.debug(
      `[detail] pool ${poolAddress} | position ${positionAddress} | tx ${txHash?.slice(0, 16)} | use ${uses}${feeLabel}`
    );
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

// Entry instan posisi Spot satu sisi SOL (-95%..+15%, fallback -90%..+15% bila kena non-refundable rent).
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

    if (!opts.allowDuplicateMint && getOpenPositionsForMint(baseMint).length > 0) {
      const pair = pairName || `${baseMint.slice(0, 4)}-SOL`;
      return {
        success: false,
        skipped: true,
        duplicateMint: true,
        reason: `token ${pair} (${baseMint.slice(0, 8)}) sudah memiliki posisi aktif`,
        baseMint,
        pair,
      };
    }

    const activeBin = await pool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const binStep = Number(pool.lbPair?.binStep) || 100;

    const rangeRes = await resolveSpotRangeWithRentCheck({
      pool,
      activeBinId,
      binStep,
      lowerPctPrimary: -95,
      lowerPctFallback: -90,
      upperPct: 15,
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
        reason: rangeRes.reason,
        baseMint,
        pair,
      };
    }

    const {
      minBinId,
      maxBinId,
      depositMinBinId,
      depositMaxBinId,
      lowerPctUsed,
      upperPctUsed,
      usedFallback,
    } = rangeRes;

    log.info(
      `Executing SPOT entry on pool ${poolAddress.slice(0, 8)}... | size=${sizeSol} SOL | range=${lowerPctUsed}%..+${upperPctUsed}% ([${minBinId}..${maxBinId}], deposit SOL [${depositMinBinId}..${depositMaxBinId}])${usedFallback ? " [fallback -90%]" : ""}`
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

    const openRes = await openSpotSolPosition({
      pool,
      connection: getConnectionFn(),
      wallet: getWalletFn(),
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
    });

    const positionAddress = openRes.positionPubkey;
    const lastSig = openRes.lastSig;

    log.info(
      `SPOT position opened: ${positionAddress} (tx: ${lastSig}) | bins [${minBinId}..${maxBinId}] (${lowerPctUsed}%..+${upperPctUsed}%), SOL [${depositMinBinId}..${depositMaxBinId}]`
    );

    trackPosition(positionAddress, poolAddress, pair, baseMint, collectFeeMode ?? null, "spot", false);
    recordTrackedRange(positionAddress, minBinId, maxBinId);
    setEntrySizeSol(positionAddress, sizeSol);
    const entryPoolPrice = poolPriceSolPerToken(activeBin, baseIsX);
    if (entryPoolPrice != null) setEntryPoolPrice(positionAddress, entryPoolPrice);
    incrementEntryUsage(poolAddress);

    recordAction(
      `ENTRY ${pair} — spot ${sizeSol} SOL (${lowerPctUsed}%..+${upperPctUsed}%, bin ${minBinId}..${maxBinId})`
    );

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
