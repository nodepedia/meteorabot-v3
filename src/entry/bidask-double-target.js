// Gerbang harga target opsional untuk entry bidask:double.
// Keputusan sentuh memakai decideBidaskSolTouch (sama dengan bidask:sol):
// di bawah target menunggu naik, di atas menunggu turun, tepat di target langsung,
// harga tidak terbaca tidak mengunci. Bedanya: sentuh hanya mengunci (armed),
// lalu Supertrend yang membuka posisi. Armed tidak lepas kalau harga menjauh.
import log from "../core/logger.js";
import { bidaskSolTouchPhrase } from "../core/report.js";
import { WSOL_MINT } from "../core/constants.js";
import { getPrices } from "../market/jupiter-price.js";
import { bidaskSolTouchKey } from "../state/bidask-sol-touch.js";
import { getBidaskDoubleTouch, setBidaskDoubleTouch } from "../state/bidask-double-touch.js";
import { bidaskSolQuotePrice, decideBidaskSolTouch } from "./bidask-sol-entry.js";
import { forgetPrice, rememberPrices } from "./price-watch.js";

export function bidaskDoubleTargetKey(lineId, target, unit = "usd") {
  return bidaskSolTouchKey(lineId, target, unit);
}

export function hasBidaskDoubleTarget(row) {
  return row?.mode === "bidask:double" && Number(row.entryPrice) > 0;
}

// true = Supertrend boleh dipakai. Baris tanpa target selalu true.
export function bidaskDoubleSupertrendOpen(row, touch) {
  if (!hasBidaskDoubleTarget(row)) return true;
  return touch?.armed === true;
}

// Satu langkah dari harga yang sudah terbaca. Tidak menulis state.
export function stepBidaskDoubleTarget(price, target, stored) {
  const direction = stored?.direction === "up" || stored?.direction === "down" ? stored.direction : null;
  if (stored?.armed === true) {
    return { direction, armed: true, newlyArmed: false, record: false };
  }
  const decision = decideBidaskSolTouch(price, target, direction);
  if (decision.triggered) {
    return {
      direction: decision.direction === "up" || decision.direction === "down" ? decision.direction : direction,
      armed: true,
      newlyArmed: true,
      record: false,
    };
  }
  return {
    direction: decision.direction === "up" || decision.direction === "down" ? decision.direction : null,
    armed: false,
    newlyArmed: false,
    record: Boolean(decision.record && decision.direction),
  };
}

export function supertrendHitsToEnter(hits, getTouch) {
  const read = typeof getTouch === "function" ? getTouch : () => null;
  return (hits || []).filter((hit) => {
    const touch = hit?.targetKey ? read(hit.targetKey) : null;
    return bidaskDoubleSupertrendOpen(hit, touch);
  });
}

let missingSolLogAt = 0;

function noteMissingSolPrice(count, now = Date.now()) {
  if (now - missingSolLogAt < 60_000) return;
  missingSolLogAt = now;
  log.warn(`bidask:double: harga SOL tidak tersedia atau tidak valid — ${count} baris target satuan SOL belum di-arm`);
}

function watchLabel(watch) {
  const id = String(watch?.lineKey || watch?.mint || "");
  if (watch?.ca) return `CA ${id}`;
  return `Pool ${id.slice(0, 8)}`;
}

// Poll harga Jupiter untuk baris yang belum armed. Tidak membuka posisi.
export async function pollBidaskDoubleTargets(watches = [], deps = {}) {
  const fetchPrices = deps.getPrices || getPrices;
  const readTouch = deps.getTouch || getBidaskDoubleTouch;
  const writeTouch = deps.setTouch || setBidaskDoubleTouch;
  const list = (watches || []).filter((w) => w?.mint && Number(w.entryPrice) > 0);
  if (list.length === 0) return { armed: [] };

  const prices = deps.prices instanceof Map ? deps.prices : await fetchPrices([...list.map((w) => w.mint), WSOL_MINT]);
  rememberPrices(prices, deps.now);
  const solUsd = prices.get(WSOL_MINT);
  const solNum = Number(solUsd);
  if (!(Number.isFinite(solNum) && solNum > 0)) forgetPrice(WSOL_MINT);

  const armed = [];
  let missingSol = 0;
  for (const w of list) {
    const cmp = bidaskSolQuotePrice({
      tokenUsd: prices.get(w.mint),
      solUsd,
      entryPriceUnit: w.entryPriceUnit,
    });
    if (cmp.price == null) {
      if (cmp.reason === "sol") missingSol += 1;
      continue;
    }
    const key = w.targetKey || bidaskDoubleTargetKey(w.lineKey || w.mint, w.entryPrice, cmp.unit);
    const stored = readTouch(key);
    const step = stepBidaskDoubleTarget(cmp.price, w.entryPrice, stored);
    if (step.newlyArmed) {
      writeTouch(key, { direction: step.direction, armed: true });
      log.info(`${watchLabel(w)} bidask:double target tersentuh, menunggu Supertrend (${w.mint})`);
      armed.push({ ...w, targetKey: key, price: cmp.price, entryPriceUnit: cmp.unit, touchDirection: step.direction });
    } else if (step.record && step.direction) {
      writeTouch(key, { direction: step.direction, armed: false });
      log.info(
        `${watchLabel(w)} bidask:double ${bidaskSolTouchPhrase({
          entryPrice: w.entryPrice,
          entryPriceUnit: cmp.unit,
          price: cmp.price,
          touchDirection: step.direction,
        })}`
      );
    }
    if (step.direction) w.touchDirection = step.direction;
    if (step.armed) w.armed = true;
  }
  if (missingSol > 0) noteMissingSolPrice(missingSol, deps.now);
  return { armed };
}
