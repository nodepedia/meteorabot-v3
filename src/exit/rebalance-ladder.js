// Tangga rebalance sisi token untuk bidask:double dan bidask:sol.
// Anak tangga pertama di `first`, lalu tiap `next`: 20, 25, 30, 35, ...
// Bila first === next, ini tangga seragam lama (10, 20, 30, ...).
// Spot tidak memakai modul ini.

function finitePct(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampStep(value, fallback) {
  const n = finitePct(value);
  return Math.max(1, n == null ? fallback : n);
}

// cfg tanpa first/next tetapi stepPct terisi = tangga seragam sebesar stepPct
// (kunci lama). cfg kosong = default 20 lalu 5.
export function normalizeRebalanceLadder(cfg, fallback = { firstStepPct: 20, nextStepPct: 5 }) {
  const fallbackFirst = clampStep(fallback.firstStepPct, 20);
  const fallbackNext = clampStep(fallback.nextStepPct, 5);
  if (cfg == null || typeof cfg !== "object") {
    const step = clampStep(cfg, fallbackFirst);
    return { firstStepPct: step, nextStepPct: step, uniform: true };
  }
  const first = finitePct(cfg.firstStepPct);
  const next = finitePct(cfg.nextStepPct);
  if (first == null && next == null) {
    const legacy = finitePct(cfg.stepPct);
    if (legacy != null) {
      const step = Math.max(1, legacy);
      return { firstStepPct: step, nextStepPct: step, uniform: true };
    }
    return {
      firstStepPct: fallbackFirst,
      nextStepPct: fallbackNext,
      uniform: fallbackFirst === fallbackNext,
    };
  }
  const firstStepPct = Math.max(1, first == null ? fallbackFirst : first);
  const nextStepPct = Math.max(1, next == null ? fallbackNext : next);
  return { firstStepPct, nextStepPct, uniform: firstStepPct === nextStepPct };
}

// Besaran positif (turun harga, atau porsi bin token). Di bawah anak tangga
// pertama → 0. 19.9 → 0, 20 → 20, 24.9 → 20, 25 → 25, 37 → 35 (first 20, next 5).
export function rebalanceLadderLevel(magnitudePct, firstStepPct = 20, nextStepPct = 5) {
  const drop = Number(magnitudePct);
  const first = clampStep(firstStepPct, 20);
  const next = clampStep(nextStepPct, first);
  if (!Number.isFinite(drop) || drop + 1e-9 < first) return 0;
  const stepsAfter = Math.floor((drop - first + 1e-9) / next);
  return first + stepsAfter * next;
}

// Level tangga tepat di bawah `level`. 20 → 0, 25 → 20, 35 → 30.
// Nilai yang bukan anak tangga (state lama, mis. 10) jatuh ke level di bawahnya.
export function previousRebalanceLadderLevel(level, firstStepPct = 20, nextStepPct = 5) {
  const current = Number(level);
  const first = clampStep(firstStepPct, 20);
  const next = clampStep(nextStepPct, first);
  if (!Number.isFinite(current) || current <= 1e-9) return 0;
  if (current <= first + 1e-9) return 0;
  const stepsBelow = Math.floor((current - first - 1e-9) / next);
  return first + Math.max(0, stepsBelow) * next;
}

// "Satu step" = jarak dari level tercatat ke anak tangga sebelumnya.
export function rebalanceLadderGap(level, firstStepPct = 20, nextStepPct = 5) {
  const current = Number(level);
  if (!Number.isFinite(current) || current <= 1e-9) return 0;
  return current - previousRebalanceLadderLevel(current, firstStepPct, nextStepPct);
}

function formatStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

// Kalimat startup. legacyUniform = kunci lama STEP_PCT yang masih menang.
export function formatRebalanceLadder(cfg) {
  const ladder = normalizeRebalanceLadder(cfg);
  const first = formatStep(ladder.firstStepPct);
  const next = formatStep(ladder.nextStepPct);
  if (cfg?.legacyUniform) {
    return `seragam tiap ${first}% (STEP_PCT lama)`;
  }
  if (ladder.firstStepPct === ladder.nextStepPct) {
    return `seragam tiap ${first}%`;
  }
  const second = formatStep(ladder.firstStepPct + ladder.nextStepPct);
  const third = formatStep(ladder.firstStepPct + 2 * ladder.nextStepPct);
  return `${first}% lalu tiap ${next}% (${first}, ${second}, ${third}, ...)`;
}
