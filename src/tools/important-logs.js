import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  STATE_FILE,
  DECISION_LOG_FILE,
  PNL_HISTORY_FILE,
  RUNTIME_STATE_FILE,
  LOG_DIR,
} from "../core/paths.js";
import {
  formatWibTimestamp,
  formatImportantLogLine,
  getImportantLogFile,
  getImportantEventsFile,
  inferActionLogMeta,
  inferLoggerMeta,
  readImportantEvents,
} from "../core/important-log.js";
import { clock, fmtPct, fmtNum, humanReason } from "../core/report.js";

function isDirectRun(metaUrl) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const self = fileURLToPath(metaUrl);
  const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return arg1 === self;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getActiveStateFile() {
  return process.env.STATE_FILE && process.env.STATE_FILE.trim()
    ? path.resolve(process.env.STATE_FILE.trim())
    : STATE_FILE;
}

function getActiveDecisionFile() {
  return process.env.DECISION_LOG_FILE && process.env.DECISION_LOG_FILE.trim()
    ? path.resolve(process.env.DECISION_LOG_FILE.trim())
    : DECISION_LOG_FILE;
}

function getActivePnlHistoryFile() {
  return process.env.PNL_HISTORY_FILE && process.env.PNL_HISTORY_FILE.trim()
    ? path.resolve(process.env.PNL_HISTORY_FILE.trim())
    : PNL_HISTORY_FILE;
}

function getActiveRuntimeFile() {
  if (process.env.RUNTIME_STATE_FILE && process.env.RUNTIME_STATE_FILE.trim()) {
    return path.resolve(process.env.RUNTIME_STATE_FILE.trim());
  }
  if (process.env.STATE_FILE && process.env.STATE_FILE.trim()) {
    return path.join(path.dirname(path.resolve(process.env.STATE_FILE.trim())), "runtime-state.json");
  }
  return RUNTIME_STATE_FILE;
}

function buildLastPnlMap(pnlHistory = []) {
  const map = new Map();
  if (!Array.isArray(pnlHistory)) return map;
  for (const row of pnlHistory) {
    const pos = row?.pos || row?.position;
    if (!pos) continue;
    map.set(pos, row);
  }
  return map;
}

function parseWorkerOutLogs(logDir = LOG_DIR) {
  const outFiles = ["entry-out.log", "exit-out.log", "wallet-out.log"];
  const events = [];
  const lineRegex = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]\s+\[(ERROR|WARN)\]\s+(.+)$/;

  for (const name of outFiles) {
    const full = path.join(logDir, name);
    if (!fs.existsSync(full)) continue;
    let content = "";
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of content.split("\n")) {
      const m = lineRegex.exec(rawLine.trim());
      if (!m) continue;
      const iso = m[1];
      const level = m[2];
      const msg = m[3];
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) continue;

      // Abaikan warning posisi ditutup manual karena sudah diwakili oleh decision-log CLOSE
      if (/dianggap ditutup manual/i.test(msg)) continue;
      // Abaikan warning 0.0000 SOL saat inisialisasi RPC awal jika hanya transient
      if (/Wallet SOL rendah:\s*0\.0000 SOL/i.test(msg)) continue;

      const meta = inferLoggerMeta(level, msg);
      if (!meta.shouldRecord) continue;

      events.push({
        id: `log:${level}:${ts}:${meta.message}`,
        ts,
        wib: formatWibTimestamp(ts),
        type: meta.type,
        category: meta.category,
        message: meta.message,
        actionNeeded: meta.actionNeeded,
      });
    }
  }

  return events;
}

// Backfill idempoten dari state.json, decision-log.json, pnl-history.json,
// runtime-state.json, dan log worker PM2 ke logs/important-events.jsonl & logs/important.log.
export function backfillImportantLogs({
  stateFile = getActiveStateFile(),
  decisionFile = getActiveDecisionFile(),
  pnlHistoryFile = getActivePnlHistoryFile(),
  runtimeFile = getActiveRuntimeFile(),
  logDir = LOG_DIR,
  importantLogFile = getImportantLogFile(),
  importantEventsFile = getImportantEventsFile(),
} = {}) {
  const existing = readImportantEvents({ eventsFile: importantEventsFile });
  const existingIds = new Set(existing.map((e) => e.id).filter(Boolean));
  const existingKeys = new Set(existing.map((e) => `${e.type}|${e.category}|${e.message.toLowerCase()}`));

  const candidates = [];

  const state = readJsonSafe(stateFile, { positions: {} });
  const decisions = readJsonSafe(decisionFile, []);
  const pnlHistory = readJsonSafe(pnlHistoryFile, []);
  const runtime = readJsonSafe(runtimeFile, {});
  const lastPnlMap = buildLastPnlMap(pnlHistory);

  // 1. Posisi yang terdeteksi / dibuka di state.json
  for (const pos of Object.values(state?.positions || {})) {
    if (!pos || !pos.position || !Number.isFinite(Number(pos.firstSeenAt))) continue;
    const ts = Number(pos.firstSeenAt);
    const pair = pos.pair || pos.position.slice(0, 8);
    const mode = pos.mode || "spot";
    const spanTxt = Number.isFinite(Number(pos.binSpan)) ? `${pos.binSpan} bin, ` : "";
    const dcaTag = pos.isDca ? "DCA " : "";
    const id = `pos-open:${pos.position}`;
    const message = `${dcaTag}ENTRY ${pair} — posisi ${mode} aktif (${spanTxt}pos ${pos.position.slice(0, 8)})`;

    candidates.push({
      id,
      ts,
      wib: formatWibTimestamp(ts),
      type: "SUCCESS",
      category: pos.isDca ? "DCA" : "ENTRY",
      message,
      actionNeeded: null,
    });

    if (Number(pos.lastSpotTokenBidaskPct) > 0 && Number.isFinite(Number(pos.lastSpotTokenBidaskAt))) {
      const rebTs = Number(pos.lastSpotTokenBidaskAt);
      const rebId = `rebalance:${pos.position}:${rebTs}`;
      candidates.push({
        id: rebId,
        ts: rebTs,
        wib: formatWibTimestamp(rebTs),
        type: "SUCCESS",
        category: "REBALANCE_BIDASK",
        message: `SPOT BIDASK ${pair} — step ${pos.lastSpotTokenBidaskPct}% (pos ${pos.position.slice(0, 8)})`,
        actionNeeded: null,
      });
    }
  }

  // 2. Riwayat penutupan posisi dari decision-log.json
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (!d || !d.position || !Number.isFinite(Number(d.ts))) continue;
      const ts = Number(d.ts);
      const pair = d.pair || d.position.slice(0, 8);
      const lastSnap = lastPnlMap.get(d.position);
      const realized = d.pnlPct != null ? Number(d.pnlPct) : lastSnap?.pnl != null ? Number(lastSnap.pnl) : null;
      const peak = d.lastPnlPeak != null ? Number(d.lastPnlPeak) : null;

      let pnlInfo = `PnL ${fmtPct(realized)}`;
      if (d.pnlPct == null && realized != null && peak != null) {
        pnlInfo = `PnL terakhir ${fmtPct(realized)} (puncak ${fmtPct(peak)})`;
      } else if (realized == null && peak != null) {
        pnlInfo = `PnL puncak ${fmtPct(peak)}`;
      }

      const id = `decision-close:${d.position}:${ts}`;
      const message = `CLOSE ${pair} — ${humanReason(d.closeReason)} | ${pnlInfo} (pos ${d.position.slice(0, 8)})`;

      candidates.push({
        id,
        ts,
        wib: formatWibTimestamp(ts),
        type: "SUCCESS",
        category: "CLOSE",
        message,
        actionNeeded: null,
      });
    }
  }

  // 3. Aksi terbaru dari runtime-state.json
  if (Array.isArray(runtime?.recentActions)) {
    for (const item of runtime.recentActions) {
      if (!item || !item.text || !Number.isFinite(Number(item.at))) continue;
      const ts = Number(item.at);
      const meta = inferActionLogMeta(item.text);
      const id = `runtime-action:${ts}:${meta.message}`;
      candidates.push({
        id,
        ts,
        wib: formatWibTimestamp(ts),
        type: meta.type,
        category: meta.category,
        message: meta.message,
        actionNeeded: meta.actionNeeded,
      });
    }
  }

  // 4. Error & warning penting dari log worker PM2
  for (const ev of parseWorkerOutLogs(logDir)) {
    candidates.push(ev);
  }

  let added = 0;
  const merged = [...existing];

  for (const c of candidates) {
    const key = `${c.type}|${c.category}|${c.message.toLowerCase()}`;
    if ((c.id && existingIds.has(c.id)) || existingKeys.has(key)) {
      continue;
    }
    if (c.id) existingIds.add(c.id);
    existingKeys.add(key);
    merged.push(c);
    added++;
  }

  if (added > 0 || !fs.existsSync(importantLogFile) || !fs.existsSync(importantEventsFile)) {
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    fs.mkdirSync(path.dirname(importantLogFile), { recursive: true });
    fs.mkdirSync(path.dirname(importantEventsFile), { recursive: true });

    const humanLines = merged.map((ev) => formatImportantLogLine(ev));
    const jsonLines = merged.map((ev) => JSON.stringify(ev));

    fs.writeFileSync(importantLogFile, humanLines.length > 0 ? humanLines.join("\n") + "\n" : "");
    fs.writeFileSync(importantEventsFile, jsonLines.length > 0 ? jsonLines.join("\n") + "\n" : "");
  }

  return { added, total: merged.length, events: merged };
}

export function buildImportantLogsReport({
  now = Date.now(),
  limitSuccess = 25,
  limitErrors = 20,
  stateFile = getActiveStateFile(),
  pnlHistoryFile = getActivePnlHistoryFile(),
  runtimeFile = getActiveRuntimeFile(),
  importantEventsFile = getImportantEventsFile(),
} = {}) {
  const state = readJsonSafe(stateFile, { positions: {} });
  const pnlHistory = readJsonSafe(pnlHistoryFile, []);
  const runtime = readJsonSafe(runtimeFile, {});
  const events = readImportantEvents({ eventsFile: importantEventsFile });
  const lastPnlMap = buildLastPnlMap(pnlHistory);

  const positions = Object.values(state?.positions || {});
  const openPositions = positions.filter((p) => p && !p.closed);
  const closedPositions = positions.filter((p) => p && p.closed);

  const wallet = runtime?.walletStatus || null;
  const watched = Array.isArray(runtime?.watchSnapshot) ? runtime.watchSnapshot : [];

  // Pisahkan error aktif vs sukses
  const allErrors = events.filter((e) => e.type === "ERROR");
  const activeErrors = allErrors.filter((e) => {
    // Bila error saldo SOL rendah sudah pulih di walletStatus terbaru, jangan tampilkan sebagai error aktif
    if (
      e.category === "WALLET" &&
      /Wallet SOL rendah/i.test(e.message) &&
      wallet &&
      wallet.lowGas === false &&
      Number(wallet.updatedAt) >= Number(e.ts)
    ) {
      return false;
    }
    return true;
  });

  const recentErrors = activeErrors.slice(-limitErrors);
  const recentSuccess = events.filter((e) => e.type === "SUCCESS").slice(-limitSuccess);

  const bar = "═".repeat(72);
  const subBar = "─".repeat(72);
  const lines = [
    bar,
    `  📋 METEORA BOT — LOG PENTING (SUKSES & ERROR)   ${clock(now)}`,
    bar,
    "",
    "1. STATUS WORKER & RINGKASAN SAAT INI",
    subBar,
  ];

  if (wallet) {
    const sol = Number(wallet.sol) || 0;
    const reserve = Number(wallet.gasReserve) || 0.05;
    const statusLabel = wallet.lowGas ? "⚠️ RENDAH (Perlu Isi SOL)" : "✅ AMAN";
    lines.push(
      `• Wallet SOL     : ${sol.toFixed(4)} SOL (cadangan gas ${reserve.toFixed(4)} SOL — ${statusLabel}) | Token non-SOL: ${wallet.tokenCount || 0}`
    );
  } else {
    lines.push("• Wallet SOL     : (menunggu update dari worker-wallet)");
  }

  if (watched.length === 0) {
    lines.push("• Pool Dipantau  : 0 pool aktif");
  } else {
    const poolSummaries = watched.map((w) => {
      const name = w.pairName || `${w.pool?.slice(0, 8)}…`;
      const trend = w.trend === "bullish" ? "NAIK" : w.trend === "bearish" ? "TURUN" : "?";
      return `${name} (${ w.sizeSol} SOL, tren ${trend}, harga ${fmtNum(w.price)} vs garis ${fmtNum(w.line)})`;
    });
    lines.push(`• Pool Dipantau  : ${watched.length} pool — ${poolSummaries.join(" | ")}`);
  }

  lines.push(`• Posisi Terbuka : ${openPositions.length} open (riwayat closed: ${closedPositions.length})`);
  for (const p of openPositions) {
    const snap = lastPnlMap.get(p.position);
    const livePnl = snap?.pnl != null ? fmtPct(snap.pnl) : "-";
    const peakPnl = p.lastPnlPeak != null ? fmtPct(p.lastPnlPeak) : "-";
    const lowPnl = p.lastPnlLowest != null ? fmtPct(p.lastPnlLowest) : "-";
    const rangeTxt =
      p.lowerBin != null && p.upperBin != null ? `bin ${p.lowerBin}→${p.upperBin} (${p.binSpan} bin)` : "bin ?";
    const rebPct = Number(p.lastSpotTokenBidaskPct) || 0;
    lines.push(
      `  ▸ ${p.pair || p.position.slice(0, 8)} [${p.mode || "spot"}] | ${rangeTxt} | PnL live ${livePnl} (puncak ${peakPnl}, terendah ${lowPnl}) | step BidAsk: ${rebPct}%`
    );
  }

  lines.push("");
  lines.push(`2. PERLU PERHATIAN / ERROR TERBARU (❌ ERROR: ${recentErrors.length})`);
  lines.push(subBar);
  if (recentErrors.length === 0) {
    lines.push("  ✅ Tidak ada error yang membutuhkan tindakan saat ini.");
  } else {
    for (const err of recentErrors) {
      lines.push(`  [${err.wib}] [❌ ERROR] [${err.category}] ${err.message}`);
      if (err.actionNeeded) {
        lines.push(`     👉 Tindakan: ${err.actionNeeded}`);
      }
    }
  }

  lines.push("");
  lines.push(`3. LOG SUKSES TERBARU (✅ SUKSES: ${recentSuccess.length})`);
  lines.push(subBar);
  if (recentSuccess.length === 0) {
    lines.push("  (Belum ada log aksi sukses yang tercatat)");
  } else {
    for (const ok of recentSuccess) {
      lines.push(`  [${ok.wib}] [✅ SUKSES] [${ok.category}] ${ok.message}`);
    }
  }

  lines.push(bar);
  return lines.join("\n");
}

if (isDirectRun(import.meta.url)) {
  backfillImportantLogs();
  console.log(buildImportantLogsReport());
}
