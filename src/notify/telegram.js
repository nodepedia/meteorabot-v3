import https from "https";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getOORState, getTrackedPosition } from "../state/positions.js";
import { resolveTrailingReference } from "../exit/trailing.js";
import { trailingDropThreshold } from "../state/trailing.js";
import { buildStatusKeyboard, publishButtonCatalog } from "./telegram-buttons.js";

const TOKEN = config.telegramBotToken;
const CHAT_ID = config.telegramChatId;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

export function buildSendPayload(text, extra = {}, chatId = CHAT_ID) {
  const payload = { chat_id: chatId, text: String(text).slice(0, 4096) };
  if (extra.reply_markup) payload.reply_markup = extra.reply_markup;
  return payload;
}

function telegramRequest(method, payload, { timeout = 15000 } = {}) {
  if (!BASE) return Promise.resolve(null);
  const body = payload == null ? null : JSON.stringify(payload);
  const url = new URL(`${BASE}/${String(method).replace(/^\//, "")}`);
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
        family: 4,
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = { ok: false, description: data.slice(0, 200) };
          }
          if (res.statusCode !== 200 || parsed?.ok === false) {
            log.warn(`Telegram ${method.split("?")[0]} failed: ${res.statusCode} ${data.slice(0, 200)}`);
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", (err) => {
      log.warn(`Telegram error: ${err.message}`);
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      log.warn(`Telegram ${method.split("?")[0]} timeout`);
      resolve(null);
    });
    if (body) req.write(body);
    req.end();
  });
}

function send(text, extra = {}) {
  if (!BASE || !CHAT_ID) return;
  void telegramRequest("sendMessage", buildSendPayload(text, extra));
}

export function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  if (!BASE || chatId == null || messageId == null) return Promise.resolve(null);
  return telegramRequest("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  });
}

export function answerCallbackQuery(callbackQueryId, text) {
  if (!BASE || !callbackQueryId) return Promise.resolve(null);
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = String(text).slice(0, 200);
  return telegramRequest("answerCallbackQuery", payload);
}

// Long-poll. timeoutSec adalah lama Telegram menahan koneksi, bukan socket timeout.
export function getUpdates({ offset, timeoutSec = 30 } = {}) {
  const qs = new URLSearchParams();
  if (offset != null) qs.set("offset", String(offset));
  qs.set("timeout", String(timeoutSec));
  qs.set("allowed_updates", JSON.stringify(["callback_query"]));
  return telegramRequest(`getUpdates?${qs}`, null, { timeout: (Number(timeoutSec) + 15) * 1000 });
}

export function notifyStartup(info = {}) {
  const lines = ["🤖 Meteora Bot — AKTIF", "━━━━━━━━━━━━━━━━━━"];

  if (info.mode) lines.push(`Mode     : ${info.mode}`);

  if (info.strategy) {
    const bins =
      info.binsBelow != null && info.binsAbove != null ? ` (bins -${info.binsBelow}/+${info.binsAbove})` : "";
    lines.push(`Strategy : ${info.strategy}${bins}`);
  }

  const entryParts = [];
  if (info.sizeSplit != null) entryParts.push(`split ${info.sizeSplit} SOL`);
  if (info.scanIntervalSec != null) entryParts.push(`refresh ${info.scanIntervalSec}s`);
  if (info.jupiterPollIntervalSec != null) entryParts.push(`Jupiter poll ${info.jupiterPollIntervalSec}s`);
  if (info.timeframe) entryParts.push(`TF ${info.timeframe}`);
  if (entryParts.length) lines.push(`Entry    : ${entryParts.join(" | ")}`);

  if (info.expiryHours != null) lines.push(`Expiry   : ${info.expiryHours} jam`);

  if (info.poolNames?.length) lines.push(`Pools    : ${info.poolNames.join(", ")}`);

  send(lines.join("\n"));
}

function fmtEntryUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function fmtEntryTvl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  return `$${Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function notifyEntry({
  pair,
  pool,
  feeMode,
  feeSol,
  modeLabel,
  binStep,
  tvlUsd,
  binCount,
  priceFrom,
  priceTo,
  priceRangeLabel,
}) {
  const mode = feeMode || config.entry.fees.mode;
  const lines = [`🚀 ENTRY ${pair || pool?.slice(0, 8) || ""}`, `Pool: ${pool || "?"}`];
  if (modeLabel) lines.push(`Mode: ${modeLabel}`);
  if (Number.isFinite(Number(binStep))) lines.push(`Bin step: ${binStep}`);
  if (Number.isFinite(Number(tvlUsd))) lines.push(`TVL: ${fmtEntryTvl(tvlUsd)}`);
  if (Number.isFinite(Number(binCount))) {
    lines.push(`Bin: ${binCount}${priceRangeLabel ? ` (${priceRangeLabel})` : ""}`);
  }
  if (priceFrom != null && priceTo != null) {
    lines.push(`Range harga: ${fmtEntryUsd(priceFrom)} – ${fmtEntryUsd(priceTo)} USD`);
  }
  if (mode && mode !== "none") {
    lines.push(`Fee: ${mode}${feeSol > 0 ? ` (~${feeSol.toFixed(6)} SOL)` : ""}`);
  }
  send(lines.join("\n"));
}

export function notifyDca({ pair, pool, pnlPct, sizeSol, trigger = "PnL" }) {
  const pnlStr = pnlPct != null ? `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "?";
  send(
    `📉 DCA ${pair || pool?.slice(0, 8) || ""}\nEntry baru: ${sizeSol} SOL\nPool: ${pool || "?"}\nTrigger ${trigger}: ${pnlStr}`
  );
}

// Fallback OOR kiri spot: beri tahu hasil konversi ke posisi token-only.
export function notifyFallback({ pair, pool, success, amount, error }) {
  const label = pair || pool?.slice(0, 8) || "";
  if (success) {
    send(`↩️ FALLBACK ${label}\nOOR kiri → posisi token-only dibuka\nToken: ${amount}\nPool: ${pool || "?"}`);
  } else {
    send(
      `⚠️ FALLBACK ${label} GAGAL\nPosisi token-only tidak jadi dibuka${error ? `: ${error}` : ""}\nToken dibiarkan di wallet.\nPool: ${pool || "?"}`
    );
  }
}

// Rebalance sisi SOL posisi bidask:double ke BidAsk, saat harga pulih satu step.
export function notifyBidaskDoubleSolRebalance({ pair, pool, lastPct, stepPct, fromBinId, toBinId, success, error }) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  if (success) {
    send(`🔄 ${label} rebalance SOL jadi BidAsk — pulih ${lastPct ?? "?"}% → ${stepPct ?? 0}% (bin ${rangeStr})`);
  } else {
    send(
      `⚠️ BIDASK SOL REBALANCE ${label} GAGAL (pulih ${lastPct ?? "?"}% → ${stepPct ?? 0}%)\n${error ? `Alasan: ${error}\n` : ""}Range SOL: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

// Rebalance sisi token posisi bidask:sol ke BidAsk, tiap kelipatan porsi bin token.
// Jalur otomatis tidak menyentuh sisi SOL. Sisi SOL hanya dari tombol Telegram.
export function notifyBidaskSolTokenRebalance({
  pair,
  pool,
  stepPct,
  tokenBinPct,
  fromBinId,
  toBinId,
  success,
  error,
}) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  const tokenStr = Number.isFinite(Number(tokenBinPct)) ? `${Number(tokenBinPct).toFixed(1)}%` : "?";
  if (success) {
    send(`✅ BIDASK SOL TOKEN REBALANCE ${label} — step ${stepPct ?? 0}% (${tokenStr} bin token, bin ${rangeStr})`);
  } else {
    send(
      `⚠️ BIDASK SOL TOKEN REBALANCE ${label} GAGAL (step ${stepPct}%)\n${error ? `Alasan: ${error}\n` : ""}Range token: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

export const REBALANCE_SIDE_EMPTY_TEXT = "Tidak ada yang bisa di-rebalance di sisi itu";

export function notifyRebalanceSideEmpty() {
  send(REBALANCE_SIDE_EMPTY_TEXT);
}

// Rebalance manual sisi SOL posisi bidask:sol jadi kurva BidAsk. Bukan jalur otomatis.
export function notifyBidaskSolSolSideRebalance({ pair, pool, fromBinId, toBinId, success, error }) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  if (success) {
    send(`🔄 ${label} rebalance sisi SOL jadi BidAsk (bin ${rangeStr})`);
  } else {
    send(
      `⚠️ BIDASK SOL SISI SOL ${label} GAGAL\n${error ? `Alasan: ${error}\n` : ""}Range SOL: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

// Rebalance sisi token posisi bidask:double ke BidAsk, tiap kelipatan turun harga.
export function notifyBidaskDoubleRebalance({
  pair,
  pool,
  stepPct,
  priceChangePct,
  fromBinId,
  toBinId,
  success,
  error,
}) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  const harga = Number.isFinite(Number(priceChangePct)) ? `${Number(priceChangePct).toFixed(1)}%` : "?";
  if (success) {
    send(`🔄 ${label} BidAsk rebalance — step ${stepPct}% (harga ${harga}, bin ${rangeStr})`);
  } else {
    send(
      `⚠️ BIDASK REBALANCE ${label} GAGAL (step ${stepPct}%)\n${error ? `Alasan: ${error}\n` : ""}Range token: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

// Re-entry spot OOR kanan: beri tahu hasil membuka posisi spot baru.
// Rebalance sisi token posisi spot ke distribusi BidAsk (tiap kelipatan step % bin).
export function notifySpotTokenBidask({
  pair,
  pool,
  stepPct,
  fromBinId,
  toBinId,
  tokenPct,
  solPct,
  feePct24h,
  success,
  error,
}) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  if (success) {
    const tokenPctStr = Number.isFinite(Number(tokenPct)) ? `${Number(tokenPct).toFixed(1)}%` : "?";
    const solPctStr = Number.isFinite(Number(solPct)) ? `${Number(solPct).toFixed(1)}%` : "?";
    const yieldStr = Number.isFinite(Number(feePct24h)) ? `${Number(feePct24h).toFixed(2)}%` : "-";
    send(`🔄 ${label} Rebalance : ${tokenPctStr} - ${solPctStr}\nYield = ${yieldStr}`);
  } else {
    send(
      `⚠️ SPOT TOKEN BIDASK ${label} GAGAL (step ${stepPct}%)\n${error ? `Alasan: ${error}\n` : ""}Range token: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

// Rebalance sisi SOL posisi spot kembali ke distribusi Spot murni saat harga naik +step%.
export function notifySpotSolRebalance({
  pair,
  pool,
  lastPct,
  stepPct,
  fromBinId,
  toBinId,
  tokenPct,
  solPct,
  feePct24h,
  success,
  error,
}) {
  const label = pair || pool?.slice(0, 8) || "";
  const rangeStr = fromBinId != null && toBinId != null ? `${fromBinId}→${toBinId}` : "?";
  if (success) {
    const tokenPctStr = Number.isFinite(Number(tokenPct)) ? `${Number(tokenPct).toFixed(1)}%` : "?";
    const solPctStr = Number.isFinite(Number(solPct)) ? `${Number(solPct).toFixed(1)}%` : "?";
    const yieldStr = Number.isFinite(Number(feePct24h)) ? `${Number(feePct24h).toFixed(2)}%` : "-";
    send(`🔄 ${label} Rebalance : ${tokenPctStr} - ${solPctStr}\nYield = ${yieldStr}`);
  } else {
    send(
      `⚠️ SPOT SOL REBALANCE ${label} GAGAL (recover ${lastPct ?? "?"}% → ${stepPct ?? 0}%)\n${error ? `Alasan: ${error}\n` : ""}Range SOL: ${rangeStr}\nPool: ${pool || "?"}`
    );
  }
}

function reentryProgress(count, attempt, max) {
  return `(${count ?? attempt ?? "?"}/${max ?? "?"})`;
}

function reentryRangeText({ minBin, maxBin, span, bins }) {
  if (minBin != null && maxBin != null) {
    const spanNum = span != null ? span : Number(maxBin) - Number(minBin);
    const spanText = Number.isFinite(Number(spanNum)) ? ` (span ${spanNum})` : "";
    return `${minBin}..${maxBin}${spanText}`;
  }
  if (bins != null) return `${bins} bin ke bawah`;
  return "?";
}

// Sukses bila pemanggil menandai success:true, atau mengirim newPosition
// (alamat posisi baru, atau "dry-run"). Tanpa keduanya ini bukan re-entry yang terbuka.
function spotReentrySucceeded(payload = {}) {
  if (payload.success === true) return true;
  if (payload.success === false) return false;
  return payload.newPosition != null && String(payload.newPosition).length > 0;
}

export function buildSpotReentryMessage({
  pair,
  pool,
  sizeSol,
  count,
  attempt,
  max,
  minBin,
  maxBin,
  span,
  bins,
  dryRun,
  txSig,
  switchedPool,
  previousPool,
} = {}) {
  const label = pair || pool?.slice(0, 8) || "";
  const lines = [
    `🔁 RE-ENTRY ${label} ${reentryProgress(count, attempt, max)}${dryRun ? " [DRY RUN]" : ""}`,
    `Size: ${sizeSol == null || sizeSol === "" ? "?" : sizeSol} SOL`,
    `Range: ${reentryRangeText({ minBin, maxBin, span, bins })}`,
    `Pool: ${pool || "?"}`,
  ];
  if (switchedPool && previousPool && previousPool !== pool) {
    lines.push(`Pindah pool: ${previousPool} → ${pool || "?"}`);
  }
  const sig = txSig == null ? "" : String(txSig).trim();
  if (sig) lines.push(`Tx: https://solscan.io/tx/${sig}`);
  return lines.join("\n");
}

export function buildSpotReentryFailedMessage({ pair, pool, count, attempt, max, reason, error } = {}) {
  const label = pair || pool?.slice(0, 8) || "";
  const detail = reason || error;
  const lines = [`⚠️ RE-ENTRY ${label} TIDAK dibuka ${reentryProgress(count, attempt, max)}`];
  if (detail) lines.push(`Alasan: ${detail}`);
  lines.push("Rantai re-entry dihentikan.");
  lines.push(`Pool: ${pool || "?"}`);
  return lines.join("\n");
}

export function buildSpotReentryAlert(payload = {}) {
  return spotReentrySucceeded(payload) ? buildSpotReentryMessage(payload) : buildSpotReentryFailedMessage(payload);
}

export function notifySpotReentry(payload = {}) {
  send(buildSpotReentryAlert(payload));
}

export function notifySpotReentryFailed(payload = {}) {
  send(buildSpotReentryFailedMessage(payload));
}

export function buildBidaskSolReentryMessage({
  pair,
  pool,
  sizeSol,
  count,
  attempt,
  max,
  minBin,
  maxBin,
  span,
  bins,
  dryRun,
  txSig,
} = {}) {
  const label = pair || pool?.slice(0, 8) || "";
  const lines = [
    `🔁 RE-ENTRY bidask:sol SOL-only ${label} ${reentryProgress(count, attempt, max)}${dryRun ? " [DRY RUN]" : ""}`,
    `Size: ${sizeSol == null || sizeSol === "" ? "?" : sizeSol} SOL`,
    `Range: ${reentryRangeText({ minBin, maxBin, span, bins })}`,
    `Pool: ${pool || "?"}`,
  ];
  const sig = txSig == null ? "" : String(txSig).trim();
  if (sig) lines.push(`Tx: https://solscan.io/tx/${sig}`);
  return lines.join("\n");
}

export function buildBidaskSolReentryFailedMessage({ pair, pool, count, attempt, max, reason, error } = {}) {
  const label = pair || pool?.slice(0, 8) || "";
  const detail = reason || error;
  const lines = [`⚠️ RE-ENTRY bidask:sol SOL-only ${label} TIDAK dibuka ${reentryProgress(count, attempt, max)}`];
  if (detail) lines.push(`Alasan: ${detail}`);
  lines.push("Rantai re-entry dihentikan.");
  lines.push(`Pool: ${pool || "?"}`);
  return lines.join("\n");
}

export function buildBidaskSolReentryAlert(payload = {}) {
  return spotReentrySucceeded(payload)
    ? buildBidaskSolReentryMessage(payload)
    : buildBidaskSolReentryFailedMessage(payload);
}

export function notifyBidaskSolReentry(payload = {}) {
  send(buildBidaskSolReentryAlert(payload));
}

export function notifyBidaskSolReentryFailed(payload = {}) {
  send(buildBidaskSolReentryFailedMessage(payload));
}

function signedPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Label pendek untuk alasan exit (bukan kalimat naratif).
export function exitLabel(reason) {
  if (!reason) return "?";
  const r = String(reason);
  if (r.startsWith("trailing_tp")) return "Trailing TP";
  if (r.startsWith("indicator_trailing")) return "Trailing Indikator";
  if (r === "indicator_rsi_macd") return "Indikator RSI+MACD";
  if (r.startsWith("indicator_rsi_bb")) return "Indikator RSI+BB";
  if (r === "stop_loss") return "Stop Loss";
  if (r === "oor_kanan") return "OOR Kanan";
  if (r === "oor_kiri") return "OOR Kiri";
  if (r === "low_yield") return "Yield Rendah";
  if (r === "high_yield") return "Yield Tinggi";
  if (r.startsWith("bounce_recovery")) return "Bounce Recovery";
  if (r === "not_detected") return "Tidak Terdeteksi";
  if (r === "manual_telegram") return "manual (Telegram)";
  return r;
}

function closeReentryLine(reason, reentry) {
  if (!reentry) return null;
  const solOnly = reentry.mode === "bidask:sol";
  const tag = solOnly ? "bidask:sol SOL-only " : "";
  if (reentry.willReenter) return `↪️ Akan re-entry ${tag}(${reentry.nextCount}/${reentry.max})`;
  if (reason !== "oor_kanan") return null;
  if (reentry.mode && reentry.mode !== "spot" && reentry.mode !== "bidask:sol") return null;
  if (!reentry.skipReason) return null;
  const skipTag = solOnly ? " bidask:sol SOL-only" : "";
  return `↪️ Tidak re-entry${skipTag}: ${reentry.skipReason}`;
}

export function buildCloseMessage(pair, reason, pnlPct, swapInfo, drawdownPnl = null, peakPnl = null, reentry = null) {
  const row = (label, value) => `${label.padEnd(16)}: ${value}`;
  const lines = [`🔒 Closed ${pair}`, "", row("Trigger Exit", exitLabel(reason))];
  if (peakPnl != null) lines.push(row("Peak", signedPct(peakPnl)));
  if (drawdownPnl != null) lines.push(row("Drawdown", signedPct(drawdownPnl)));
  lines.push("", row("Realized PnL", signedPct(pnlPct)));
  if (swapInfo?.pending) {
    lines.push(`⏳ Swap ke SOL TERTUNDA${swapInfo.error ? `: ${swapInfo.error}` : ""} — dicoba ulang otomatis`);
  } else if (swapInfo && swapInfo.success === false) {
    const detail = swapInfo.error ? `: ${swapInfo.error}` : " — perlu swap manual";
    lines.push(`⚠️ Swap GAGAL${detail}`);
  }
  const reentryLine = closeReentryLine(reason, reentry);
  if (reentryLine) lines.push(reentryLine);
  return lines.join("\n");
}

export function notifyClose(pair, reason, pnlPct, swapInfo, drawdownPnl = null, peakPnl = null, reentry = null) {
  send(buildCloseMessage(pair, reason, pnlPct, swapInfo, drawdownPnl, peakPnl, reentry));
}

export function notifySwapGiveUp({ mint, pair, attempts, reason, error }) {
  const short = mint ? `${mint.slice(0, 8)}…` : "?";
  send(
    `⚠️ Swap ${pair || short} → SOL DIHENTIKAN (${reason || `gagal ${attempts}x`}).\nMint: ${mint}\n${error ? `Error: ${error}\n` : ""}Token tertinggal di wallet — perlu swap manual.`
  );
}

export function notifyError(msg) {
  send(`❌ Error: ${msg}`);
}

export function notifyPositionMissing(position, pair, cycles) {
  const short = position?.slice(0, 8) || "?";
  send(`posisi ${short} dari pool ${pair || "?"} tidak terbaca ${cycles} cycle.`);
}

export function notifyPoolExpired({ pool, pair, expiryHours }) {
  const label = pair || pool;
  send(
    `⏰ Pool EXPIRED: ${label}\nPool: ${pool}\nTidak ada entry dalam ${expiryHours} jam — pool di-skip dari scan sampai bot restart.`
  );
}

// Entry bidask:double dilewati karena tidak ada pool X/SOL dengan bin step cukup.
// Baris pool.txt sengaja tidak dimatikan: pool baru bisa muncul nanti.
export function notifyBinStepSkip({ pair, pool, mint, minBinStep, binStep, reason }) {
  const label = pair || mint?.slice(0, 8) || pool?.slice(0, 8) || "";
  const have = Number.isFinite(Number(binStep)) ? String(binStep) : "tidak diketahui";
  send(
    `⏭ ${label} tidak di-entry (bidask:double)\nButuh bin step ≥ ${minBinStep}. Pool tercatat: ${have}.\n${reason ? `${reason}\n` : ""}Baris pool.txt tidak dimatikan.`
  );
}

export function notifyPoolUnsupported({ pool, pair, quoteMint }) {
  const label = pair || pool;
  send(
    `⛔ Pool DITOLAK: ${label}\nPool: ${pool}\nPair bukan SOL (quote: ${quoteMint || "?"}) — pool dilewati dari scan sampai bot restart.`
  );
}

export function notifyEntryFailed({ pool, pair, error, attempts, maxFailures, cooldownSec }) {
  const label = pair || pool;
  const lines = [
    `⚠️ ENTRY GAGAL: ${label}`,
    `Pool: ${pool}`,
    `Alasan: ${error || "unknown"}`,
    `Percobaan: ${attempts}${maxFailures != null ? `/${maxFailures}` : ""}`,
  ];
  if (config.entry.fees.mode !== "none") lines.push(`Fee: ${config.entry.fees.mode}`);
  if (cooldownSec > 0) lines.push(`Cooldown: ${cooldownSec}s`);
  send(lines.join("\n"));
}

export function notifyEntryRateLimited({ pool, pair, error, attempts, maxFailures, cooldownSec }) {
  const label = pair || pool;
  const lines = [
    `⚠️ ENTRY GAGAL (RATE LIMIT): ${label}`,
    `Pool: ${pool}`,
    `Alasan: ${error || "unknown"}`,
    `Percobaan: ${attempts}/${maxFailures}`,
  ];
  if (cooldownSec > 0) lines.push(`Cooldown: ${cooldownSec}s`);
  if (maxFailures != null && attempts >= maxFailures) lines.push("Pool di-skip sampai bot restart.");
  send(lines.join("\n"));
}

export function notifyEntryAborted({ pool, pair, attempts, error }) {
  const label = pair || pool;
  send(
    `⛔ ENTRY DIBATALKAN: ${label}\nPool: ${pool}\nGagal ${attempts}x berturut-turut — ${error || "unknown"}.\nPool di-skip sampai bot restart.`
  );
}

function emoji(v) {
  if (v == null || v === 0) return "";
  return v > 0 ? "🟢" : "🔴";
}

// OOR hanya dikembalikan saat posisi benar-benar keluar rentang.
function oorMarker(p) {
  if (p.activeBin == null || p.lowerBin == null || p.upperBin == null) return null;
  const state = getOORState(p.position);
  if (state) return state.arah === "kanan" ? "OOR 🟢" : "OOR 🔴";
  if (p.activeBin > p.upperBin) return "OOR 🟢";
  if (p.activeBin < p.lowerBin) return "OOR 🔴";
  return null;
}

// Level PnL exit hanya saat trailing TP sedang aktif (ada acuan trailing).
// Level stop loss tidak pernah ditampilkan di pesan status.
function computeExitAt(p, tracked) {
  const rules = config.rulesFor(p.mode || "bidask:double");
  if (tracked && p.pnlPct != null) {
    const resolved = resolveTrailingReference(tracked, p.pnlPct, rules);
    if (resolved) {
      const threshold = trailingDropThreshold(resolved.reference, rules.trailingDropRatioPct, rules.trailingDropPct);
      return resolved.reference - threshold;
    }
  }
  return null;
}

// Teks status tidak berubah. Keyboard hanya ikut bila tombol diaktifkan.
export function buildStatusDelivery(positions, opts = {}) {
  const text = buildStatusMessage(positions);
  if (!text) return null;
  const enabled = opts.enabled != null ? opts.enabled : config.telegramButtonsEnabled;
  if (!enabled) return { text };
  const reply_markup = buildStatusKeyboard(positions, { catalog: opts.catalog || null });
  if (!reply_markup.inline_keyboard.length) return { text };
  return { text, reply_markup };
}

export function buildStatusMessage(positions) {
  if (!positions || positions.length === 0) return "";
  let msg = "🚨 Meteora DLMM Position Status:\n";
  for (const p of positions) {
    const label = p.pair || p.position?.slice(0, 8) || "?";
    const age = p.ageMinutes != null ? `${p.ageMinutes}m` : "?m";
    const tracked = getTrackedPosition(p.position);

    msg += `\n${label}\n`;
    msg += `Age : ${age}\n`;

    if (p.pnlPct != null) {
      msg += `PnL: ${signedPct(p.pnlPct)}${emoji(p.pnlPct)}\n`;
    }

    // Yield selalu tampil; info OOR hanya muncul saat keluar rentang.
    const yieldPct = p.feePct24h != null && p.feePct24h > 0 ? `${p.feePct24h.toFixed(2)}%` : null;
    const yieldLine = [yieldPct, oorMarker(p)].filter(Boolean).join(" | ");
    if (yieldLine) msg += `Yield: ${yieldLine}\n`;

    if (tracked?.trailingActive) {
      msg += `Trailing: 🔁\n`;
      if (tracked.lastPnlPeak != null) msg += `Peak: ${signedPct(tracked.lastPnlPeak)}\n`;
    }
    const exitAt = computeExitAt(p, tracked);
    if (exitAt != null) msg += `Exit at : ${signedPct(exitAt)}\n`;
  }
  return msg.trim();
}

export function notifyStatus(positions) {
  const delivery = buildStatusDelivery(positions);
  if (!delivery) return;
  if (delivery.reply_markup) publishButtonCatalog(positions);
  send(delivery.text, delivery.reply_markup ? { reply_markup: delivery.reply_markup } : {});
}

export function plainTg(value, max = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function minListedRentSol(costsByPct) {
  if (!costsByPct || typeof costsByPct !== "object") return null;
  let min = null;
  for (const value of Object.values(costsByPct)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (min == null || n < min) min = n;
  }
  return min;
}

function shortTgId(value) {
  const text = plainTg(value, 64);
  if (!text) return "";
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

function listedPoolRentMin(item) {
  const fromCosts = minListedRentSol(item?.costsByPct);
  if (fromCosts != null) return fromCosts;
  if (item?.minNonRefundableSol == null || item.minNonRefundableSol === "") return null;
  const n = Number(item.minNonRefundableSol);
  return Number.isFinite(n) ? n : null;
}

function listedPoolRentIsFree(item, maxNonRefundableSol) {
  const min = listedPoolRentMin(item);
  const cap =
    Number.isFinite(Number(maxNonRefundableSol)) && Number(maxNonRefundableSol) >= 0 ? Number(maxNonRefundableSol) : 0;
  if (min != null) return min <= cap;
  return item?.rentOk === true;
}

function formatCheckedPoolLine(item) {
  const addr = shortTgId(item?.pool || item?.poolAddress) || "?";
  const step = Number(item?.binStep);
  const parts = [addr];
  if (Number.isFinite(step) && step > 0) parts.push(`binStep ${step}`);
  const min = listedPoolRentMin(item);
  if (min == null) parts.push(item?.rentOk === true ? "bebas sewa" : "tidak ada range bebas sewa");
  else parts.push(`min sewa ${min.toFixed(6)} SOL`);
  return parts.join(" | ");
}

// Alert entry spot setelah pencarian pool lain: satu baris ringkas per pool.
function buildSpotPoolsRentSkipMessage({
  pair,
  mint,
  sizeSol,
  maxNonRefundableSol,
  watchDisabled,
  fallbackEnabled,
  poolsChecked,
} = {}) {
  const pools = Array.isArray(poolsChecked) ? poolsChecked : [];
  const allFailed = pools.length > 0 && pools.every((item) => !listedPoolRentIsFree(item, maxNonRefundableSol));
  const lines = [];
  if (fallbackEnabled === false) {
    lines.push("🚨 Entry Spot dibatalkan");
    lines.push("Hanya pool asal yang dicek (fallback nonaktif).");
  } else if (allFailed) {
    lines.push("🚨 Entry Spot dibatalkan karena semua pool TOKEN/SOL untuk token ini terkena sewa non-refundable.");
  } else {
    lines.push("🚨 Entry Spot dibatalkan");
  }
  const pairText = plainTg(pair);
  if (pairText) lines.push(`Pair: ${pairText}`);
  const mintText = shortTgId(mint);
  if (mintText) lines.push(`Token: ${mintText}`);
  if (Number.isFinite(Number(sizeSol))) lines.push(`Modal: ${Number(sizeSol)} SOL`);
  lines.push(`Pool dicek: ${pools.length}`);
  for (const item of pools) lines.push(formatCheckedPoolLine(item));
  if (Number.isFinite(Number(maxNonRefundableSol))) {
    lines.push(`Batas sewa non-refundable: ${Number(maxNonRefundableSol)} SOL`);
  }
  if (watchDisabled === true) lines.push("Pool ditandai # dan tidak dipantau lagi.");
  return lines.join("\n");
}

// Teks alert bila seluruh tangga range Spot ditolak karena sewa tidak kembali.
// Payload dengan poolsChecked (entry spot instan) memakai ringkasan per pool.
// Payload lama (re-entry OOR kanan) tetap menulis tiap range. Status daftar
// pantau hanya bila penandaan # memang berhasil.
export function buildSpotNonRefundableSkipMessage({
  pool,
  pair,
  mint,
  sizeSol,
  costsByPct,
  upperPct,
  maxNonRefundableSol,
  reason,
  context,
  watchDisabled,
  fallbackEnabled,
  poolsChecked,
} = {}) {
  if (Array.isArray(poolsChecked)) {
    return buildSpotPoolsRentSkipMessage({
      pair,
      mint,
      sizeSol,
      maxNonRefundableSol,
      watchDisabled,
      fallbackEnabled,
      poolsChecked,
    });
  }
  const lines = ["🚨 Entry Spot dibatalkan"];
  const pairText = plainTg(pair);
  if (pairText) lines.push(`Pair: ${pairText}`);
  const poolText = plainTg(pool, 80);
  if (poolText) lines.push(`Pool: ${poolText}`);
  const ctx = plainTg(context);
  if (ctx) lines.push(`Tahap: ${ctx}`);
  if (Number.isFinite(Number(sizeSol))) lines.push(`Modal: ${Number(sizeSol)} SOL`);
  lines.push("Semua range yang dicoba ditolak karena sewa tidak kembali (non-refundable).");

  const upper = Number(upperPct);
  const upperLabel = Number.isFinite(upper) ? `..${upper > 0 ? "+" : ""}${upper}%` : "";
  if (costsByPct && typeof costsByPct === "object") {
    const keys = Object.keys(costsByPct)
      .filter((pct) => Number.isFinite(Number(costsByPct[pct])))
      .sort((a, b) => Number(a) - Number(b));
    for (const pct of keys) {
      lines.push(`${pct}%${upperLabel}: ${Number(costsByPct[pct]).toFixed(6)} SOL`);
    }
  }
  if (Number.isFinite(Number(maxNonRefundableSol))) {
    lines.push(`Batas sewa non-refundable: ${Number(maxNonRefundableSol)} SOL`);
  }
  const why = plainTg(reason, 300);
  if (why) lines.push(`Catatan: ${why}`);
  if (watchDisabled === true) lines.push("Pool ditandai # dan tidak dipantau lagi.");
  return lines.join("\n");
}

export function notifySpotNonRefundableSkipped(payload) {
  try {
    send(buildSpotNonRefundableSkipMessage(payload));
  } catch (err) {
    log.warn(`Alert sewa non-refundable gagal disusun: ${err.message}`);
  }
}

export function notifySpotRentPoolSwitch({ fromPool, toPool, text } = {}) {
  try {
    send(text || `pindah pool karena rent: ${fromPool} -> ${toPool}`);
  } catch (err) {
    log.warn(`Info pindah pool karena rent gagal dikirim: ${err.message}`);
  }
}
