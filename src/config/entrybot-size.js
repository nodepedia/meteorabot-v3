// Tombol ukuran tetap di entry bot. Default = kolom size kosong (ENTRY_DEFAULT_SIZE_SOL).
export const DEFAULT_ENTRYBOT_SIZE_OPTIONS = "0.5,1,2";

export function formatEntrybotSizeToken(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return "";
  let text = n.toFixed(8);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text;
}

export function parseEntrybotSizeOptions(raw, fallback = DEFAULT_ENTRYBOT_SIZE_OPTIONS) {
  const text = raw == null || String(raw).trim() === "" ? fallback : String(raw);
  const out = [];
  const seen = new Set();
  for (const part of text.split(",")) {
    const token = formatEntrybotSizeToken(part);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(Number(token));
  }
  if (out.length > 0) return out;
  if (String(text) === String(fallback)) return [0.5, 1, 2];
  return parseEntrybotSizeOptions(fallback, fallback);
}
