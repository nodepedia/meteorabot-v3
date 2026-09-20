import https from "https";
import config from "../config/index.js";
import log from "../core/logger.js";
import { getOORState, getTrackedPosition } from "../state/positions.js";

const TOKEN = config.telegramBotToken;
const CHAT_ID = config.telegramChatId;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function send(text) {
  if (!BASE || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text: String(text).slice(0, 4096) });
  const url = new URL(`${BASE}/sendMessage`);
  const req = https.request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      family: 4,
      timeout: 15000,
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          log.warn(`Telegram send failed: ${res.statusCode} ${data.slice(0, 200)}`);
        }
      });
    }
  );
  req.on("error", (err) => log.warn(`Telegram error: ${err.message}`));
  req.write(body);
  req.end();
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

export function notifyEntry({ pair, pool }) {
  send(`🚀 ENTRY ${pair || pool?.slice(0, 8) || ""}\nPool: ${pool || "?"}`);
}

export function notifyDca({ pair, pool, pnlPct, sizeSol }) {
  const pnlStr = pnlPct != null ? `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "?";
  send(
    `📉 DCA ${pair || pool?.slice(0, 8) || ""}\nEntry baru: ${sizeSol} SOL\nPool: ${pool || "?"}\nTrigger PnL: ${pnlStr}`
  );
}

export function notifyClose(pair, reason, pnlPct, swapInfo, _peakPnl = null) {
  const label = reason?.startsWith("trailing_tp") ? "Trailing TP" : reason;
  const pnlStr = pnlPct != null ? ` | PnL: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "";
  let swapStr = " | Swap: -";
  if (swapInfo) {
    swapStr = ` | Swap: ${swapInfo.success ? "✅" : "❌"}`;
  }
  send(`🔒 Closed ${pair}: ${label}${pnlStr}${swapStr}`);
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

function fmtNum(v) {
  if (v == null) return "?";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(2);
}

function emoji(v) {
  if (v == null || v === 0) return "";
  return v > 0 ? "🟢" : "🔴";
}

export function notifyStatus(positions) {
  if (!positions || positions.length === 0) return;
  let msg = "🚨 Meteora DLMM Position Status:\n";
  for (const p of positions) {
    const label = p.pair || p.position?.slice(0, 8) || "?";
    const age = p.ageMinutes != null ? `${p.ageMinutes}m` : "?m";

    msg += `\n${label}\n`;
    msg += `Age : ${age}\n`;

    // PnL
    if (p.pnlPct != null) {
      const prefix = p.pnlPct > 0 ? "+" : "";
      msg += `PnL: ${prefix}${p.pnlPct.toFixed(2)}%${emoji(p.pnlPct)}\n`;
    }

    // Yield + OOR (1 line)
    const yieldPct = p.feePct24h != null && p.feePct24h > 0 ? `${p.feePct24h.toFixed(2)}%` : null;
    let oorLabel = null;
    if (p.activeBin != null && p.lowerBin != null && p.upperBin != null) {
      const state = getOORState(p.position);
      if (state) {
        oorLabel = state.arah === "kanan" ? "OOR 🟢" : "OOR 🔴";
      } else if (p.activeBin > p.upperBin) {
        oorLabel = "OOR 🟢";
      } else if (p.activeBin < p.lowerBin) {
        oorLabel = "OOR 🔴";
      } else {
        oorLabel = "In Range";
      }
    }
    const yieldLine = [yieldPct, oorLabel].filter(Boolean).join(" | ");
    if (yieldLine) msg += `Yield: ${yieldLine}\n`;

    const trailing = getTrackedPosition(p.position);
    if (trailing?.trailingActive) {
      const isIndicator = trailing.trailingArmedBy != null;
      const ref = isIndicator ? trailing.trailingAnchor : trailing.lastPnlPeak;
      const refStr = ref != null ? ` (${isIndicator ? "anchor" : "peak"}: +${ref.toFixed(2)}%)` : "";
      msg += `Trailing: 🔁${refStr}\n`;
    }

    // Market Cap
    if (p.marketCap != null && p.marketCap > 0) msg += `MC: ${fmtNum(p.marketCap)}\n`;

    // Volumes
    const v1m = p.volume1m != null && p.volume1m > 0 ? `Vol 5m: $${fmtNum(p.volume1m)}` : null;
    const v1h = p.volume1h != null && p.volume1h > 0 ? `Vol 1h: $${fmtNum(p.volume1h)}` : null;
    const volLine = [v1m, v1h].filter(Boolean).join(" | ");
    if (volLine) msg += `${volLine}\n`;
  }
  send(msg.trim());
}
