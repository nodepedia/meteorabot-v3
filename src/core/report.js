// Pembentuk log naratif (bahasa manusia) untuk PM2. Baris teknis tetap
// dipisah lewat log.debug("[detail] ...").
import config from "../config/index.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// Bot menampilkan waktu dalam WIB (UTC+7).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function clock(ts = Date.now()) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} WIB`;
}

export function fmtNum(v) {
  if (v == null) return "?";
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return n.toFixed(n < 1 ? 4 : 2);
}

function trimFixed(text) {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

// Harga bidask:sol: `$0.0012` untuk USD, `0.0000123 SOL` untuk SOL per token.
export function fmtQuote(v, unit = "usd") {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  let text;
  if (abs === 0) text = "0";
  else if (abs >= 1) text = trimFixed(n.toFixed(4));
  else {
    const digits = Math.min(16, Math.max(4, Math.ceil(-Math.log10(abs)) + 3));
    text = trimFixed(n.toFixed(digits));
    if (text === "0" || text === "-0") text = n.toPrecision(4);
  }
  return unit === "sol" ? `${text} SOL` : `$${text}`;
}

function quoteNumber(v, unit) {
  const full = fmtQuote(v, unit);
  if (full === "?") return "?";
  if (unit === "sol") return full.replace(/ SOL$/, "");
  if (full.startsWith("$")) return full.slice(1);
  return full;
}

// Kalimat arah sentuh bidask:sol, misalnya
// `menunggu naik ke 0.0000379 SOL (sekarang 0.00002953)`.
export function bidaskSolTouchPhrase({ entryPrice, entryPriceUnit, price, touchDirection, direction } = {}) {
  if (
    entryPriceUnit === "now" ||
    String(entryPrice ?? "")
      .trim()
      .toLowerCase() === "now"
  ) {
    const hasPrice = price != null && price !== "" && Number.isFinite(Number(price)) && Number(price) > 0;
    if (!hasPrice) return "entry sekarang (harga pasar) | harga belum tersedia";
    return `entry sekarang (harga pasar) (sekarang ${quoteNumber(price, "usd")}) — siap entry`;
  }
  const unit = entryPriceUnit === "sol" ? "sol" : "usd";
  const dir = touchDirection || direction;
  const target = fmtQuote(entryPrice, unit);
  const hasPrice = price != null && price !== "" && Number.isFinite(Number(price));
  const now = hasPrice ? quoteNumber(price, unit) : null;
  const reached =
    hasPrice &&
    ((dir === "up" && Number(price) >= Number(entryPrice)) || (dir === "down" && Number(price) <= Number(entryPrice)));
  if (dir === "up" || dir === "down") {
    const verb = dir === "up" ? "naik" : "turun";
    if (now == null) return `menunggu ${verb} ke ${target} | harga belum tersedia`;
    const base = `menunggu ${verb} ke ${target} (sekarang ${now})`;
    return reached ? `${base} — siap entry` : base;
  }
  if (!hasPrice) return `menunggu harga ${target} | harga belum tersedia`;
  return `menunggu arah harga ${target} (sekarang ${now})`;
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Terjemahkan kode alasan exit ke bahasa manusia.
export function humanReason(reason) {
  if (!reason) return "alasan tidak diketahui";
  const r = String(reason);
  if (r.startsWith("trailing_tp")) return "profit turun dari puncak (trailing TP)";
  if (r.startsWith("indicator_trailing")) return "sinyal indikator, profit turun dari puncak";
  if (r === "stop_loss") return "batas rugi tersentuh";
  if (r === "oor_kanan") return "harga keluar dari rentang atas";
  if (r === "oor_kiri") return "harga keluar dari rentang bawah";
  if (r === "low_yield") return `24h Fee/TVL di bawah ambang selama ${config.spot.yieldCloseBelowSec} detik`;
  if (r === "high_yield") return "24h Fee/TVL posisi di atas ambang (aturan lama)";
  if (r.startsWith("bounce_recovery")) return "pemulihan gagal (turun dari pantulan)";
  if (r === "not_detected") return "posisi tidak terdeteksi (kemungkinan ditutup manual)";
  if (r === "manual_telegram") return "manual (Telegram)";
  if (r === "dca_close_safeguard") return "safeguard: DCA terakhir profit (trailing TP), posisi asli ikut ditutup";
  if (r.startsWith("indicator_rsi")) return `${humanReason(r.slice(10))} (exit langsung)`;
  if (r === "rsi_macd") return "sinyal indikator RSI+MACD";
  if (r === "rsi_bb") return "sinyal indikator RSI+Bollinger";
  if (r === "rsi_bb_wick") return "sinyal indikator RSI+Bollinger (wick)";
  return r;
}

function trendLabel(trend) {
  if (trend === "bullish") return "tren NAIK";
  if (trend === "bearish") return "tren TURUN";
  return "tren belum siap";
}

function priceAgeLabel(w) {
  const sec = Number(w.priceAgeSec);
  return Number.isFinite(sec) ? ` (${sec}s)` : "";
}

function watchLine(w) {
  const name = w.pairName || `${(w.pool || "").slice(0, 8)}…`;
  if (w.priceStale) {
    const age = priceAgeLabel(w);
    if (w.pendingBidaskSol) return `${name} | bidask:sol harga basi${age}`;
    if (w.pendingBidaskDouble) return `${name} | bidask:double harga basi${age}, lalu Supertrend`;
    return `${name} | ${trendLabel(w.trend)} | harga basi${age}`;
  }
  if (w.pendingBidaskSol) {
    return `${name} | bidask:sol ${bidaskSolTouchPhrase(w)}`;
  }
  if (w.pendingBidaskDouble) {
    return `${name} | bidask:double ${bidaskSolTouchPhrase(w)}, lalu Supertrend`;
  }
  if (w.line == null || w.price == null) {
    return `${name} | ${trendLabel(w.trend)} | harga belum tersedia untuk dibandingkan`;
  }
  if (w.trend !== "bullish") {
    return `${name} | ${trendLabel(w.trend)} | harga ${fmtNum(w.price)} vs garis ${fmtNum(w.line)} → tidak dipantau untuk entry`;
  }
  const above = w.price > w.line;
  return `${name} | ${trendLabel(w.trend)} | harga ${fmtNum(w.price)} vs garis ${fmtNum(w.line)} → ${
    above ? "masih DI ATAS garis (menunggu turun)" : "sudah menyentuh garis (siap entry)"
  }`;
}

// Bangun blok ringkasan multi-baris (satu string).
export function buildSummaryBlock({
  mode,
  now = Date.now(),
  watched = [],
  positions = [],
  dcaLines = [],
  dcaActive = dcaLines.length > 0,
  actionLines = [],
}) {
  const bar = "═".repeat(60);
  const L = [];
  L.push(bar);
  L.push(`  Meteora Bot — RINGKASAN   ${clock(now)}`);
  L.push(bar);
  L.push(`Mode    : ${mode} | PnL dihitung dalam SOL`);
  L.push(
    `Kerja   : pantau tren → cari titik masuk → atur exit${dcaActive ? " → DCA saat posisi turun lalu memantul" : ""}`
  );
  L.push("");

  L.push(`▸ SEDANG DIPANTAU (${watched.length} pool)`);
  if (watched.length === 0) {
    L.push("  (belum ada pool dipantau — kosong, atau semua sedang punya posisi)");
  } else {
    watched.forEach((w, i) => L.push(`  ${i + 1}. ${watchLine(w)}`));
  }
  L.push("");

  L.push(`▸ POSISI TERBUKA : ${positions.length === 0 ? "tidak ada" : positions.length}`);
  positions.forEach((p, i) => {
    const name = p.pair || (p.position ? `${p.position.slice(0, 8)}…` : "?");
    const parts = [`PnL ${fmtPct(p.pnlPct)}`];
    if (p.zone) parts.push(p.zone);
    if (p.trailing) parts.push(p.trailing);
    L.push(`  ${i + 1}. ${name} | ${parts.join(" | ")}`);
  });
  L.push("");

  // Section DCA hanya muncul kalau ada posisi yang memang bisa DCA (spot tidak pernah DCA).
  if (dcaLines.length > 0) {
    L.push("▸ DCA");
    dcaLines.forEach((line) => L.push(`  • ${line}`));
    L.push("");
  }

  L.push("▸ AKSI 5 MENIT TERAKHIR");
  if (actionLines.length === 0) L.push("  tidak ada entry / DCA / close");
  else actionLines.forEach((line) => L.push(`  • ${line}`));

  return L.join("\n");
}
