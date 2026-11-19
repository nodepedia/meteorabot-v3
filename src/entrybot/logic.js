// Parser, teks, dan keputusan antrean entry bot. Tanpa jaringan dan tanpa file.
import config from "../config/index.js";
import { LEGACY_MODE } from "../config/rules.js";
import { WSOL_MINT } from "../core/constants.js";
import { fmtQuote } from "../core/report.js";
import { addrOf, chooseBidaskDoublePool, isDlmmPool, pickBestPool } from "../entry/ca-resolve.js";
import { decideBidaskSolTouch, pickBidaskSolEntryPool } from "../entry/bidask-sol-entry.js";
import { parseEntryPrice } from "../entry/pool-list.js";
import { calcSpotPoolEfficiencyScore } from "../meteora/spot-position.js";
import { PublicKey } from "@solana/web3.js";

export const WIZARD_TTL_MS = 10 * 60 * 1000;
export const SKIP_THROTTLE_MS = 15 * 60 * 1000;
export const DONE_KEEP_MS = 6 * 60 * 60 * 1000;

export const STRATEGIES = {
  "bidask:sol": "Bidask SOL",
  "bidask:double": "Bidask Double",
  spot: "Spot",
};

export const CB = {
  sol: "eb:st:sol",
  dbl: "eb:st:dbl",
  spt: "eb:st:spt",
  cancel: "eb:x",
  ok: "eb:ok",
};

const B58 = "1-9A-HJ-NP-Za-km-z";

export function emptySession(now = 0) {
  return {
    step: "idle",
    strategy: null,
    mint: null,
    symbol: null,
    priceUsd: null,
    priceSol: null,
    targetRaw: null,
    target: null,
    targetUnit: null,
    preview: null,
    updatedAt: now,
  };
}

export function strategyLabel(strategy) {
  return STRATEGIES[strategy] || strategy || "?";
}

export function isSolanaMint(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length < 32 || raw.length > 44) return false;
  if (!new RegExp(`^[${B58}]+$`).test(raw)) return false;
  try {
    return new PublicKey(raw).toBase58() === raw;
  } catch {
    return false;
  }
}

// Sama dengan kolom harga pool.txt. token = teks yang ditulis ke baris (akhiran dipertahankan).
export function parseTargetPrice(raw) {
  const body = String(raw ?? "").trim();
  if (!body) return { ok: false, reason: "empty" };
  const parsed = parseEntryPrice(body);
  if (!parsed) return { ok: false, reason: "invalid" };
  if (!parsed.ok) return parsed;
  return { ...parsed, token: body.replace(/\s+/g, "") };
}

export function shortAddr(value) {
  const text = String(value || "");
  if (text.length <= 12) return text || "?";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function formatEntryLine({ strategy, mint, targetToken } = {}) {
  if (strategy === "bidask:sol") return `${mint},,,bidask:sol,ca,${targetToken}`;
  if (strategy === "spot") return `${mint},,,spot,ca`;
  return `${mint},,,bidask:double,ca`;
}

export function parseCommand(text) {
  const match = /^\/(entry|antrean|batal)(?:@\w+)?(?:\s|$)/i.exec(String(text ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

export function parseCallbackData(data) {
  const text = String(data ?? "");
  if (Buffer.byteLength(text) > 64) return null;
  if (text === CB.sol) return { type: "strategy", strategy: "bidask:sol" };
  if (text === CB.dbl) return { type: "strategy", strategy: "bidask:double" };
  if (text === CB.spt) return { type: "strategy", strategy: "spot" };
  if (text === CB.cancel) return { type: "cancel" };
  if (text === CB.ok) return { type: "confirm" };
  if (text.startsWith("eb:rm:")) {
    const address = text.slice("eb:rm:".length).trim();
    if (!address || address.length > 50) return null;
    return { type: "delete", address };
  }
  return null;
}

export function strategyKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Bidask SOL", callback_data: CB.sol },
        { text: "Bidask Double", callback_data: CB.dbl },
        { text: "Spot", callback_data: CB.spt },
      ],
      [{ text: "❌ Batal", callback_data: CB.cancel }],
    ],
  };
}

export function cancelKeyboard() {
  return { inline_keyboard: [[{ text: "❌ Batal", callback_data: CB.cancel }]] };
}

export function confirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Konfirmasi", callback_data: CB.ok },
        { text: "❌ Batal", callback_data: CB.cancel },
      ],
    ],
  };
}

export function deleteKeyboard(address) {
  return { inline_keyboard: [[{ text: "🗑 Hapus antrean", callback_data: `eb:rm:${address}` }]] };
}

export function sameChat(chatId, allowed) {
  if (allowed == null || String(allowed).trim() === "") return false;
  return String(chatId) === String(allowed);
}

export function sessionExpired(session, now, ttlMs = WIZARD_TTL_MS) {
  if (!session || session.step === "idle") return false;
  const at = Number(session.updatedAt);
  if (!Number.isFinite(at)) return false;
  return now - at > ttlMs;
}

export function symbolFromPools(pools, mint) {
  for (const pool of pools || []) {
    for (const side of [pool?.token_x, pool?.token_y, pool?.tokenX, pool?.tokenY]) {
      if (side?.address === mint && side.symbol) {
        const symbol = String(side.symbol)
          .replace(/[^\w.-]/g, "")
          .slice(0, 16);
        if (symbol) return symbol;
      }
    }
  }
  return null;
}

function fmtTvl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function fmtFee(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  let text = n.toFixed(4);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text;
}

function poolRow(pools, address) {
  return (pools || []).find((pool) => addrOf(pool) === address) || null;
}

function isTokenSolPool(pool, mint) {
  const mints = [pool?.token_x?.address, pool?.token_y?.address].filter(Boolean);
  return mints.includes(WSOL_MINT) && (!mint || mints.includes(mint));
}

// Preview baca-saja. Spot tidak memanggil quote sewa (butuh RPC); yang murah
// dipakai, sewa ditulis "dihitung saat entry".
export function previewEntryPool(strategy, pools, mint, opts = {}) {
  if (strategy === "bidask:sol") {
    const picked = pickBidaskSolEntryPool(pools, mint, opts.bidaskSol || {});
    if (!picked?.pool) return { ok: false, reason: picked?.reason || "tidak ada pool" };
    return {
      ok: true,
      pool: picked.pool,
      binStep: picked.binStep ?? null,
      tvl: picked.tvl ?? null,
      binCount: picked.binCount ?? null,
      feeRatio: picked.feeRatio ?? null,
      rentNote: null,
    };
  }

  if (strategy === "bidask:double") {
    const minBinStep = opts.minBinStep ?? config.entry.bidaskDoubleMinBinStep;
    const min = Math.max(0, Number(minBinStep) || 0);
    const picked =
      min > 0
        ? chooseBidaskDoublePool({ listedPool: null, listedBinStep: null, minBinStep: min, pools, mint })
        : pickBestPool(pools, mint, { minBinStep: 0 });
    if (!picked?.pool) return { ok: false, reason: picked?.reason || "tidak ada pool" };
    const row = poolRow(pools, picked.pool);
    const tvl = Number(row?.tvl ?? row?.tvlUsd);
    return {
      ok: true,
      pool: picked.pool,
      binStep: picked.binStep ?? null,
      tvl: Number.isFinite(tvl) ? tvl : null,
      binCount: null,
      feeRatio: picked.ratio ?? null,
      rentNote: null,
    };
  }

  const ranked = [];
  for (const pool of pools || []) {
    const address = addrOf(pool);
    if (!address || !isDlmmPool(pool) || pool?.is_blacklisted === true) continue;
    if (!isTokenSolPool(pool, mint)) continue;
    const tvl = Number(pool.tvl ?? pool.tvlUsd) || 0;
    const fees24h = Number(pool.fees?.["24h"] ?? pool.fees24hUsd) || 0;
    const cum = Number(pool.cumulative_metrics?.fees ?? pool.cumFeesUsd) || 0;
    const step = Number(pool.dlmm_params?.bin_step ?? pool.bin_step ?? pool.binStep);
    ranked.push({
      pool: address,
      binStep: Number.isFinite(step) ? step : null,
      tvl,
      feeRatio: Number(pool.fee_active_tvl_ratio),
      score: calcSpotPoolEfficiencyScore({ tvlUsd: tvl, fees24hUsd: fees24h, cumFeesUsd: cum }),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return { ok: false, reason: "tidak ada pool DLMM token/SOL" };
  const best = ranked[0];
  return {
    ok: true,
    pool: best.pool,
    binStep: best.binStep,
    tvl: best.tvl,
    binCount: null,
    feeRatio: Number.isFinite(best.feeRatio) ? best.feeRatio : null,
    rentNote: "Sewa: dihitung saat entry",
  };
}

export function formatPreview(preview) {
  const head = "Pool calon (bisa berubah saat entry)";
  if (!preview?.ok) {
    const why = preview?.reason ? ` (${preview.reason})` : "";
    return `${head}\nBelum ada yang lolos${why}. Tetap bisa diantre.`;
  }
  const bits = [shortAddr(preview.pool)];
  if (preview.binStep != null) bits.push(`bin step ${preview.binStep}`);
  const tvl = fmtTvl(preview.tvl);
  if (tvl) bits.push(`TVL ${tvl}`);
  if (preview.binCount != null) bits.push(`${preview.binCount} bin`);
  else bits.push("jumlah bin: dihitung saat entry");
  const fee = fmtFee(preview.feeRatio);
  if (fee != null) bits.push(`fee/TVL ${fee}`);
  const lines = [head, bits.join(" · ")];
  if (preview.rentNote) lines.push(preview.rentNote);
  return lines.join("\n");
}

export function currentForUnit(session) {
  if (session?.targetUnit === "sol") return session.priceSol;
  return session?.priceUsd;
}

export function pctApart(current, target) {
  const c = Number(current);
  const t = Number(target);
  if (!(c > 0) || !(t > 0)) return null;
  return ((t - c) / c) * 100;
}

export function triggerPhrase(strategy, current, target) {
  if (strategy === "bidask:double") return "tunggu sinyal Supertrend";
  if (strategy === "spot") return "entry langsung";
  if (!Number.isFinite(Number(current)) || !(Number(target) > 0)) {
    return "harga belum kebaca, arah menyusul saat entry";
  }
  const decision = decideBidaskSolTouch(current, target, null);
  if (decision.triggered && !decision.direction) return "entry sekarang";
  if (decision.direction === "up") return "tunggu harga naik sampai target";
  if (decision.direction === "down") return "tunggu harga turun sampai target";
  return "entry sekarang";
}

function fmtPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtSize(sizeSol) {
  const n = Number(sizeSol);
  if (!Number.isFinite(n)) return "? SOL (preset)";
  return `${n} SOL (preset)`;
}

export function formatPriceLine(priceSol, priceUsd) {
  const sol = Number.isFinite(Number(priceSol)) ? fmtQuote(priceSol, "sol") : "SOL ?";
  const usd = Number.isFinite(Number(priceUsd)) ? fmtQuote(priceUsd, "usd") : "USD ?";
  return `Harga sekarang: ${sol} · ${usd}`;
}

export function formatSummary(session, sizeSol) {
  const symbol = session.symbol || shortAddr(session.mint);
  const lines = [
    "📋 Konfirmasi entry",
    `Strategi : ${strategyLabel(session.strategy)}`,
    `Token    : ${symbol} (${shortAddr(session.mint)})`,
    `Size     : ${fmtSize(sizeSol)}`,
  ];
  lines.push(formatPriceLine(session.priceSol, session.priceUsd));
  if (session.strategy === "bidask:sol") {
    const unit = session.targetUnit === "sol" ? "sol" : "usd";
    const pct = fmtPct(pctApart(currentForUnit(session), session.target));
    const pctText = pct ? ` (${pct} vs harga sekarang)` : "";
    lines.push(`Target   : ${fmtQuote(session.target, unit)}${pctText}`);
  }
  lines.push(`Pemicu   : ${triggerPhrase(session.strategy, currentForUnit(session), session.target)}`);
  lines.push("");
  lines.push(formatPreview(session.preview));
  return lines.join("\n");
}

export function formatQuoteAsk(session) {
  const symbol = session.symbol || shortAddr(session.mint);
  return [
    `${symbol} · ${shortAddr(session.mint)}`,
    formatPriceLine(session.priceSol, session.priceUsd),
    "",
    "Kirim harga target (contoh 0.0000379sol atau 0.009usd):",
  ].join("\n");
}

export function priceErrorText(reason) {
  if (reason === "suffix") {
    return "Satuan nggak dikenal. Pakai angka, usd, atau sol. Contoh: 0.0000379sol atau 0.009usd";
  }
  return "Harga harus lebih dari 0. Contoh: 0.0000379sol atau 0.009usd";
}

export function listActiveLines(raw) {
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(",").map((part) => part.trim());
    const modeRaw = (parts[3] || "").toLowerCase();
    let mode = modeRaw;
    if (!mode && (parts[1] || "").toLowerCase() === "spot") mode = "spot";
    if (mode === "bidask") mode = "bidask:double";
    out.push({
      line: trimmed,
      address: parts[0],
      mode: mode || "bidask:double",
      ca: (parts[4] || "").toLowerCase() === "ca",
      price: parts[5] || "",
    });
  }
  return out;
}

export function formatQueueMessage(lines, items = []) {
  const active = lines || [];
  if (!active.length) return { text: "Antrean kosong. Ketik /entry buat nambah.", keyboard: null };
  const watching = new Map((items || []).filter((item) => item.status === "watching").map((item) => [item.mint, item]));
  const shown = active.slice(0, 20);
  const rows = [];
  const textLines = ["📋 Antrean", ""];
  shown.forEach((row, index) => {
    const owned = watching.get(row.address);
    const label = strategyLabel(row.mode);
    const who = owned ? "dari entrybot" : "manual";
    const name = owned?.symbol || shortAddr(row.address);
    textLines.push(`${index + 1}. ${label} · ${name} · ${who}`);
    textLines.push(`   ${row.line}`);
    const button = owned?.symbol ? `🗑 Hapus ${owned.symbol}` : `🗑 Hapus ${shortAddr(row.address)}`;
    rows.push([{ text: button.slice(0, 40), callback_data: `eb:rm:${row.address}` }]);
  });
  if (active.length > shown.length) textLines.push(`…dan ${active.length - shown.length} baris lagi`);
  return { text: textLines.join("\n"), keyboard: { inline_keyboard: rows } };
}

export function mentionsMint(text, mint) {
  if (!text || !mint) return false;
  const body = String(text);
  if (body.includes(mint)) return true;
  const short = String(mint).slice(0, 8);
  if (short.length < 8) return false;
  return new RegExp(`(^|[^${B58}])${short}([^${B58}]|$)`).test(body);
}

function mentionsItem(text, item) {
  if (mentionsMint(text, item?.mint)) return true;
  const symbol = item?.symbol;
  if (!symbol || symbol.length < 3 || symbol.toUpperCase() === "SOL") return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(String(text));
}

export function classifyEntrySkip(message) {
  const text = String(message || "");
  if (/\[DRY RUN\]\s*Would enter/i.test(text)) return { code: "dry_run", label: "dry-run, posisi tidak dibuka" };
  if (/non-refundable|nonrefundable/i.test(text)) return { code: "non_refundable", label: "sewa non-refundable" };
  if (/insufficient SOL|saldo SOL kurang|Wallet SOL rendah/i.test(text)) {
    return { code: "low_sol", label: "SOL di wallet kurang" };
  }
  if (/sudah punya posisi|posisi sudah ada|duplicate/i.test(text)) {
    return { code: "duplicate", label: "sudah ada posisi" };
  }
  if (/tidak ada pool|belum ada pool/i.test(text) || /\bskip:/i.test(text)) {
    const match = /skip:\s*(.+?)(?:\s*\(log berikutnya|$)/i.exec(text);
    const fromMenunggu = /menunggu:\s*(.+?)(?:\s*\(harga|$)/i.exec(text);
    const label = (match?.[1] || fromMenunggu?.[1] || "belum ada pool yang lolos").trim().slice(0, 160);
    return { code: "no_pool", label };
  }
  return null;
}

export function logLineTime(line) {
  const match = /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(String(line || ""));
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}

function skipApplies(item, line, hit) {
  if (hit.code === "low_sol") {
    if (mentionsItem(line, item)) return true;
    if (new RegExp(`[${B58}]{32,44}`).test(line) && !mentionsMint(line, item.mint)) return false;
    return true;
  }
  return mentionsItem(line, item);
}

export function findSkips(item, lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines || []) {
    const time = logLineTime(line);
    if (time != null && time + 2000 < Number(item.queuedAt)) continue;
    const hit = classifyEntrySkip(line);
    if (!hit || seen.has(hit.code)) continue;
    if (!skipApplies(item, line, hit)) continue;
    seen.add(hit.code);
    out.push(hit);
  }
  return out;
}

function modeOf(position) {
  const raw = position?.mode;
  return LEGACY_MODE[raw] || raw;
}

export function findOpenedPosition(item, positions) {
  const list = Array.isArray(positions) ? positions : Object.values(positions || {});
  let found = null;
  for (const position of list) {
    if (!position || position.closed === true || position.isDca === true) continue;
    if (position.baseMint !== item.mint) continue;
    if (modeOf(position) !== item.strategy) continue;
    const seen = Number(position.firstSeenAt) || 0;
    if (seen + 15000 < Number(item.queuedAt)) continue;
    if (!found || seen < Number(found.firstSeenAt || 0)) found = position;
  }
  return found;
}

export function extractOpenMeta(lines, position, item) {
  let tx = null;
  let binStep = null;
  const pos = position?.position || "";
  const pool = position?.pool || "";
  for (const line of lines || []) {
    const opened = /position opened:\s*([1-9A-HJ-NP-Za-km-z]+)\s*\(tx:\s*([1-9A-HJ-NP-Za-km-z]{32,})/.exec(line);
    if (opened && opened[1] === pos) tx = opened[2];
    const step = /(?:bin step|step)[= ](\d+)/i.exec(line);
    if (!step) continue;
    const about =
      (pos && line.includes(pos)) ||
      (pool && line.includes(String(pool).slice(0, 8))) ||
      mentionsMint(line, item?.mint) ||
      (item?.symbol && line.includes(item.symbol));
    if (about) binStep = Number(step[1]);
  }
  return { tx, binStep };
}

export function formatEntered(item, position, meta = {}) {
  const symbol = item.symbol || shortAddr(item.mint);
  const lines = [
    `✅ Entry ${symbol} berhasil`,
    `Strategi : ${strategyLabel(item.strategy)}`,
    `Posisi   : ${shortAddr(position?.position)}`,
    `Pool     : ${shortAddr(position?.pool)}`,
  ];
  lines.push(`Bin step : ${meta.binStep != null ? meta.binStep : "—"}`);
  const size = Number(position?.entrySizeSol ?? item.sizeSol);
  lines.push(`Size     : ${Number.isFinite(size) ? `${size} SOL` : "?"}`);
  if (meta.tx) lines.push(`Tx       : https://solscan.io/tx/${meta.tx}`);
  return lines.join("\n");
}

function displaySymbol(item) {
  return item.symbol || shortAddr(item.mint);
}

export function reviewQueue(items, view, now, opts = {}) {
  const throttle = opts.throttleMs ?? SKIP_THROTTLE_MS;
  const active = new Set(
    (view.activeAddresses || listActiveLines(view.poolText).map((row) => row.address)).filter(Boolean)
  );
  const lines = [
    ...(view.logLines || []),
    ...(view.actions || []).map((action) => (typeof action === "string" ? action : action?.text || "")),
  ];
  const notes = [];
  const next = [];
  for (const item of items || []) {
    if (!item || item.status !== "watching") {
      const doneAt = Number(item?.doneAt || item?.queuedAt) || 0;
      if (item && now - doneAt < DONE_KEEP_MS) next.push(item);
      continue;
    }
    const opened = findOpenedPosition(item, view.positions);
    if (opened) {
      const meta = extractOpenMeta(lines, opened, item);
      notes.push({ id: item.id, kind: "entered", text: formatEntered(item, opened, meta) });
      next.push({ ...item, status: "entered", doneAt: now });
      continue;
    }
    if (!active.has(item.mint)) {
      const skip = findSkips(item, lines)[0];
      const symbol = displaySymbol(item);
      const text = skip
        ? `⚠️ ${symbol} keluar dari antrean: ${skip.label}.`
        : `⚠️ ${symbol} barisnya sudah tidak aktif. Pantauan berhenti.`;
      notes.push({ id: item.id, kind: "removed", text });
      next.push({ ...item, status: "removed", doneAt: now });
      continue;
    }
    const fresh = findSkips(item, lines).find((skip) => {
      const last = Number(item.skips?.[skip.code]) || 0;
      return now - last >= throttle;
    });
    if (!fresh) {
      next.push(item);
      continue;
    }
    notes.push({
      id: item.id,
      kind: "skip",
      code: fresh.code,
      text: `⚠️ ${displaySymbol(item)} belum bisa entry: ${fresh.label}. Masih nunggu.`,
    });
    next.push({ ...item, skips: { ...(item.skips || {}), [fresh.code]: now } });
  }
  return { items: next, notes };
}

export function commitReview(previous, reviewed, deliveredIds) {
  const delivered = new Set(deliveredIds || []);
  const prev = new Map((previous || []).map((item) => [item.id, item]));
  const noted = new Set((reviewed?.notes || []).map((note) => note.id));
  return (reviewed?.items || []).map((item) => {
    if (noted.has(item.id) && !delivered.has(item.id)) return prev.get(item.id) || item;
    return item;
  });
}
