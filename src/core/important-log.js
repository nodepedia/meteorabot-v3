import fs from "fs";
import os from "os";
import path from "path";
import { IMPORTANT_LOG_FILE, IMPORTANT_EVENTS_FILE } from "./paths.js";

export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DEDUP_WINDOW_MS = 5000;
export const MAX_IMPORTANT_EVENTS = 2000;

// In-memory ring buffer untuk deduplikasi pesan berurutan dalam jendela singkat.
const recentEvents = [];

function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatWibTimestamp(ts = Date.now()) {
  const n = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const d = new Date(n + WIB_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} WIB`;
}

export function getImportantLogFile() {
  const override = process.env.IMPORTANT_LOG_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.env.NODE_TEST_CONTEXT) {
    const stateOverride = process.env.STATE_FILE;
    if (stateOverride && stateOverride.trim()) {
      return path.join(path.dirname(path.resolve(stateOverride.trim())), "important.log");
    }
    return path.join(os.tmpdir(), `meteorabot-test-${process.pid}-important.log`);
  }
  return IMPORTANT_LOG_FILE;
}

export function getImportantEventsFile() {
  const override = process.env.IMPORTANT_EVENTS_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.env.NODE_TEST_CONTEXT) {
    const stateOverride = process.env.STATE_FILE;
    if (stateOverride && stateOverride.trim()) {
      return path.join(path.dirname(path.resolve(stateOverride.trim())), "important-events.jsonl");
    }
    return path.join(os.tmpdir(), `meteorabot-test-${process.pid}-important-events.jsonl`);
  }
  return IMPORTANT_EVENTS_FILE;
}

export function formatImportantLogLine(event) {
  const badge = event.type === "SUCCESS" ? "✅ SUKSES" : "❌ ERROR";
  const actionPart = event.type === "ERROR" && event.actionNeeded ? ` | Tindakan: ${event.actionNeeded}` : "";
  return `[${event.wib}] [${badge}] [${event.category}] ${event.message}${actionPart}`;
}

function cleanSingleLine(msg) {
  return String(msg ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferActionLogMeta(text) {
  const clean = cleanSingleLine(text);
  const isError =
    /\b(GAGAL|ERROR|ABORTED|FAILED)\b/i.test(clean) || /batas .* tercapai/i.test(clean);

  let category = "SYSTEM";
  if (/^SPOT\s+SOL\s+REBALANCE\b/i.test(clean)) {
    category = "REBALANCE_SOL_SPOT";
  } else if (/^SPOT\s+(TOKEN\s+)?BIDASK\b/i.test(clean) || /^SPOT\s+REBALANCE\b/i.test(clean)) {
    category = "REBALANCE_BIDASK";
  } else if (/^FALLBACK\b/i.test(clean)) {
    category = "FALLBACK";
  } else if (/^RE-ENTRY\b/i.test(clean)) {
    category = "REENTRY";
  } else if (/^DCA\b/i.test(clean)) {
    category = "DCA";
  } else if (/^CLOSE\b/i.test(clean)) {
    category = "CLOSE";
  } else if (/^SWEEP\b/i.test(clean)) {
    category = "SWEEP";
  } else if (/^ENTRY\b/i.test(clean)) {
    category = "ENTRY";
  } else if (/^WALLET\b/i.test(clean)) {
    category = "WALLET";
  } else if (/^POOL\b/i.test(clean)) {
    category = "POOL";
  }

  // CLOSE normal (bukan gagal) selalu dianggap SUCCESS walau karena stop_loss / oor.
  // Namun bila posisi hilang / ditutup manual di luar bot ("tidak terdeteksi"), tetap dianggap SUCCESS CLOSE.
  const isNormalClose = category === "CLOSE" && !/\b(GAGAL|ERROR|FAILED)\b/i.test(clean);
  const type = isError && !isNormalClose ? "ERROR" : "SUCCESS";

  let actionNeeded = null;
  if (type === "ERROR") {
    switch (category) {
      case "REBALANCE_SOL_SPOT":
        actionNeeded = "SOL hasil withdraw tetap aman di wallet; cek koneksi RPC atau saldo gas";
        break;
      case "REBALANCE_BIDASK":
        actionNeeded =
          "Token base yang ditarik dilepas dari lock dan akan di-sweep otomatis ke SOL oleh worker-wallet";
        break;
      case "FALLBACK":
        actionNeeded = "Token dilepas dari lock dan akan di-sweep otomatis ke SOL oleh worker-wallet";
        break;
      case "REENTRY":
        if (/batas .* tercapai/i.test(clean)) {
          actionNeeded = "Batas re-entry otomatis tercapai; cek pool.txt jika ingin membuka posisi lagi";
        } else if (/saldo SOL/i.test(clean)) {
          actionNeeded = "Cek saldo SOL di wallet untuk kebutuhan re-entry + cadangan gas";
        } else {
          actionNeeded = "Rantai re-entry dihentikan; cek saldo SOL atau biaya non-refundable pool";
        }
        break;
      case "DCA":
        actionNeeded = "Cek kondisi harga pool atau saldo SOL di wallet untuk DCA";
        break;
      case "ENTRY":
        actionNeeded = "Cek saldo SOL di wallet, kondisi harga pool, atau konfigurasi di pool.txt";
        break;
      case "CLOSE":
        actionNeeded = "Cek posisi di Meteora dan log meteorabot-exit";
        break;
      case "SWEEP":
        actionNeeded = "Token tertinggal di wallet, worker-wallet akan mencoba sweep otomatis";
        break;
      default:
        actionNeeded = "Cek log worker terkait untuk detail penanganan";
        break;
    }
  }

  return {
    type,
    category,
    message: clean,
    actionNeeded,
  };
}

export function inferLoggerMeta(level, rawMsg) {
  const clean = cleanSingleLine(rawMsg);
  if (!clean) return { shouldRecord: false };

  const upperLevel = String(level || "").toUpperCase();
  const isErrorLevel = upperLevel === "ERROR";
  const isWarnLevel = upperLevel === "WARN";

  if (!isErrorLevel && !isWarnLevel) {
    return { shouldRecord: false };
  }

  // Untuk WARN, hanya tangkap warning yang penting untuk maintenance bot (bukan transient retry).
  if (isWarnLevel) {
    const actionableWarn =
      /dinonaktifkan/i.test(clean) ||
      /rejected:\s*pair bukan SOL/i.test(clean) ||
      /gagal ditandai di/i.test(clean) ||
      /entry_size invalid/i.test(clean) ||
      /Wallet SOL rendah/i.test(clean) ||
      /token left unsold/i.test(clean) ||
      /Swap failed for/i.test(clean) ||
      /^DCA\s+.*\s+(dihentikan|failed|skip:\s*entry_size)/i.test(clean) ||
      /^Re-entry\s+.*\s+gagal/i.test(clean);

    if (!actionableWarn) {
      return { shouldRecord: false };
    }
  }

    if (/Wallet SOL rendah/i.test(clean) || /insufficient SOL/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "WALLET",
      message: clean,
      actionNeeded: "Cek saldo SOL di wallet (di bawah cadangan gas 0.05 SOL)",
    };
  }

  if (/WALLET_PRIVATE_KEY/i.test(clean) || /Wallet cycle error/i.test(clean) || /worker-wallet/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "WALLET",
      message: clean,
      actionNeeded: "Cek konfigurasi WALLET_PRIVATE_KEY di .env dan koneksi RPC Solana",
    };
  }

  if (/token left unsold/i.test(clean) || /sweepToSol failed/i.test(clean) || /^Sweep failed/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "SWEEP",
      message: clean,
      actionNeeded: "Token tertinggal di wallet, worker-wallet akan mencoba sweep otomatis",
    };
  }

  if (/Swap failed for/i.test(clean) || /Close (failed|error) for/i.test(clean)) {
    const isSwapAfterClose = /Swap failed for/i.test(clean);
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "CLOSE",
      message: clean,
      actionNeeded: isSwapAfterClose
        ? "Posisi sudah ditutup tetapi swap token ke SOL gagal; worker-wallet akan mencoba sweep otomatis"
        : "Gagal menutup posisi di Meteora; cek koneksi RPC atau tutup manual jika darurat",
    };
  }

  if (/Spot SOL Rebalance/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "REBALANCE_SOL_SPOT",
      message: clean,
      actionNeeded: "SOL hasil withdraw tetap aman di wallet; cek koneksi RPC atau saldo gas",
    };
  }

  if (/Spot (Token )?BidAsk/i.test(clean) || /Spot Rebalance/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "REBALANCE_BIDASK",
      message: clean,
      actionNeeded: "Token base yang ditarik dilepas dari lock dan akan di-sweep otomatis ke SOL oleh worker-wallet",
    };
  }

  if (/^Fallback\b/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "FALLBACK",
      message: clean,
      actionNeeded: "Token dilepas dari lock dan akan di-sweep otomatis ke SOL oleh worker-wallet",
    };
  }

  if (/^Re-entry\b/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "REENTRY",
      message: clean,
      actionNeeded: "Rantai re-entry dihentikan; cek saldo SOL atau biaya non-refundable pool",
    };
  }

  if (/^DCA\b/i.test(clean) || /DCA watcher error/i.test(clean)) {
    const isMissingSize = /entry_size tidak ditemukan/i.test(clean);
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "DCA",
      message: clean,
      actionNeeded: isMissingSize
        ? "Pastikan alamat pool dan ukuran SOL masih terdaftar di pool.txt"
        : "Cek kondisi harga pool atau saldo SOL di wallet untuk DCA",
    };
  }

  if (
    /Pool\s+\S+\s+(dibatalkan|aborted after)/i.test(clean) ||
    /^Entry\b/i.test(clean) ||
    /swapSolToToken failed/i.test(clean) ||
    /Failed to revert/i.test(clean) ||
    /watchAndEnter failed/i.test(clean) ||
    /refreshCandidates failed/i.test(clean) ||
    /candidate refresh failed/i.test(clean) ||
    /price watch failed/i.test(clean)
  ) {
    let hint = "Cek log meteorabot-entry, koneksi RPC/Jupiter, atau pool.txt";
    if (/dinonaktifkan/i.test(clean)) {
      hint = "Pool dinonaktifkan otomatis di pool.txt; cek pool.txt jika ingin mengaktifkan ulang";
    } else if (/estimasi fee/i.test(clean)) {
      hint = "Estimasi fee melampaui batas; cek pengaturan PRIORITY_FEE / JITO di strat.conf";
    } else if (/Failed to revert/i.test(clean)) {
      hint = "Token tertinggal di wallet pasca gagal entry, worker-wallet akan mencoba sweep otomatis";
    }
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "ENTRY",
      message: clean,
      actionNeeded: hint,
    };
  }

  if (
    /Pool\s+\S+\s+(expired|rejected|skipped|gagal ditandai)/i.test(clean) ||
    /entry_size invalid/i.test(clean) ||
    /dinonaktifkan/i.test(clean)
  ) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "POOL",
      message: clean,
      actionNeeded: "Pool dinonaktifkan / dilewati; cek pool.txt jika ingin memperbaiki atau mengaktifkan ulang",
    };
  }

  if (/swapToSol failed/i.test(clean)) {
    return {
      shouldRecord: true,
      type: "ERROR",
      category: "SWEEP",
      message: clean,
      actionNeeded: "Token tertinggal di wallet, worker-wallet akan mencoba sweep otomatis",
    };
  }

  return {
    shouldRecord: true,
    type: "ERROR",
    category: "SYSTEM",
    message: clean,
    actionNeeded: "Cek koneksi RPC Helius/Solana dan status worker PM2",
  };
}

function isDuplicateRecent(candidate, now, windowMs = DEDUP_WINDOW_MS) {
  // Bersihkan entri kadaluarsa
  while (recentEvents.length > 0 && now - recentEvents[0].ts > windowMs) {
    recentEvents.shift();
  }

  const normMsg = candidate.message.toLowerCase();
  const logFile = getImportantLogFile();

  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const prev = recentEvents[i];
    if (prev.logFile !== logFile) continue;
    if (now - prev.ts > windowMs) continue;
    if (prev.type !== candidate.type) continue;

    // 1. Pesan identik dalam jendela waktu
    if (prev.normMsg === normMsg) return true;

    // 2. Error dari kategori yang sama (mis. log.error diikuti recordAction pada baris berikutnya dalam <1.5 detik)
    if (
      candidate.type === "ERROR" &&
      prev.category === candidate.category &&
      ["REBALANCE_BIDASK", "REBALANCE_SOL_SPOT", "FALLBACK", "REENTRY"].includes(candidate.category) &&
      now - prev.ts <= 1500
    ) {
      return true;
    }
  }
  return false;
}

function trimEventsFileIfNeeded(eventsFile, maxLines = MAX_IMPORTANT_EVENTS) {
  try {
    if (!fs.existsSync(eventsFile)) return;
    const stat = fs.statSync(eventsFile);
    // Hanya cek jumlah baris bila ukuran file > 512 KB agar hemat I/O
    if (stat.size < 512 * 1024) return;
    const lines = fs
      .readFileSync(eventsFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (lines.length > maxLines) {
      const kept = lines.slice(-maxLines).join("\n") + "\n";
      fs.writeFileSync(eventsFile, kept);
    }
  } catch {}
}

export function recordImportantEvent({
  ts = Date.now(),
  type = "SUCCESS",
  category = "SYSTEM",
  message = "",
  actionNeeded = null,
  id = null,
  skipDedup = false,
} = {}) {
  const cleanMsg = cleanSingleLine(message);
  if (!cleanMsg) return null;

  const eventTs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const normType = String(type).toUpperCase() === "ERROR" ? "ERROR" : "SUCCESS";
  const normCategory = String(category || "SYSTEM").toUpperCase();
  const normAction = normType === "ERROR" && actionNeeded ? cleanSingleLine(actionNeeded) : null;

  const candidate = {
    ts: eventTs,
    wib: formatWibTimestamp(eventTs),
    type: normType,
    category: normCategory,
    message: cleanMsg,
    actionNeeded: normAction,
  };
  if (id) candidate.id = String(id);

  if (!skipDedup && isDuplicateRecent(candidate, eventTs)) {
    return null;
  }

  const logFile = getImportantLogFile();
  const eventsFile = getImportantEventsFile();

  recentEvents.push({
    ts: eventTs,
    type: normType,
    category: normCategory,
    normMsg: cleanMsg.toLowerCase(),
    logFile,
  });
  if (recentEvents.length > 100) {
    recentEvents.splice(0, recentEvents.length - 100);
  }

  const line = formatImportantLogLine(candidate);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + "\n");
  } catch {}

  try {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify(candidate) + "\n");
    trimEventsFileIfNeeded(eventsFile);
  } catch {}

  return candidate;
}

export function recordImportantFromAction(text, ts = Date.now()) {
  if (!text) return null;
  const meta = inferActionLogMeta(text);
  return recordImportantEvent({
    ts,
    type: meta.type,
    category: meta.category,
    message: meta.message,
    actionNeeded: meta.actionNeeded,
  });
}

export function recordImportantFromLogger(level, msg, ts = Date.now()) {
  const meta = inferLoggerMeta(level, msg);
  if (!meta.shouldRecord) return null;
  return recordImportantEvent({
    ts,
    type: meta.type,
    category: meta.category,
    message: meta.message,
    actionNeeded: meta.actionNeeded,
  });
}

export function readImportantEvents({ limit = 0, type = null, eventsFile = getImportantEventsFile() } = {}) {
  if (!fs.existsSync(eventsFile)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return [];
  }

  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.message === "string") {
        if (!type || parsed.type === type) {
          out.push(parsed);
        }
      }
    } catch {}
  }

  if (limit > 0 && out.length > limit) {
    return out.slice(-limit);
  }
  return out;
}

export function resetImportantLogs() {
  recentEvents.length = 0;
  const logFile = getImportantLogFile();
  const eventsFile = getImportantEventsFile();
  try {
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  } catch {}
  try {
    if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
  } catch {}
}
