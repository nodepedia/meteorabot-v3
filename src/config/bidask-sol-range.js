// Rentang bidask:sol per baris: "bawah/atas", contoh -30/15.
// Bawah negatif -99..-1, atas 0..100. Kosong = null (pakai strat.conf).
// Teks yang tidak masuk aturan itu = { ok:false }.

export const DEFAULT_BIDASK_SOL_ENTRY_PRESETS = "-50/15,-30/15,-20/15";

export function bidaskSolRangePair(lowerPct, upperPct) {
  const lower = Number(lowerPct);
  const upper = Number(upperPct);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  if (lower < -99 || lower > -1 || upper < 0 || upper > 100) return null;
  return { lowerPct: lower, upperPct: upper };
}

export function parseBidaskSolRange(raw) {
  if (raw == null) return null;
  const body = String(raw).split("#")[0].trim();
  if (!body) return null;
  const compact = body.replace(/\s+/g, "");
  const match = /^([+-]?\d+(?:\.\d+)?)%?\/([+-]?\d+(?:\.\d+)?)%?$/.exec(compact);
  if (!match) return { ok: false, reason: "invalid" };
  const pair = bidaskSolRangePair(match[1], match[2]);
  if (!pair) return { ok: false, reason: "invalid" };
  return { ok: true, ...pair };
}

export function formatBidaskSolRangeToken(lowerPct, upperPct) {
  const pair = bidaskSolRangePair(lowerPct, upperPct);
  if (!pair) return "";
  const fmt = (n) => (Object.is(n, -0) ? "0" : String(n));
  return `${fmt(pair.lowerPct)}/${fmt(pair.upperPct)}`;
}

export function formatBidaskSolRangeLabel(lowerPct, upperPct) {
  const pair = bidaskSolRangePair(lowerPct, upperPct);
  if (!pair) return null;
  const num = (n) => String(n);
  const upper = pair.upperPct > 0 ? `+${num(pair.upperPct)}` : num(pair.upperPct);
  return `${num(pair.lowerPct)}% / ${upper}%`;
}

export function parseBidaskSolPresets(raw, fallback = DEFAULT_BIDASK_SOL_ENTRY_PRESETS) {
  const text = raw == null || String(raw).trim() === "" ? fallback : String(raw);
  const out = [];
  for (const part of text.split(",")) {
    const parsed = parseBidaskSolRange(part);
    if (parsed?.ok) out.push({ lowerPct: parsed.lowerPct, upperPct: parsed.upperPct });
  }
  if (out.length > 0) return out;
  if (text === fallback) return [];
  return parseBidaskSolPresets(fallback, fallback);
}
