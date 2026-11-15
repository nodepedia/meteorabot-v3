import log from "../core/logger.js";
import { getTrackedPosition } from "../state/positions.js";
import { classifyMode, isCompositeMode } from "./classify.js";
import { handleClose } from "./close.js";
import { handleSpotTokenBidask } from "./spot-token-bidask.js";
import { handleBidaskDoubleRebalance } from "./bidask-double-rebalance.js";
import { handleBidaskSolRebalance, handleBidaskSolSolSideRebalance } from "./bidask-sol-rebalance.js";
import { modeSupportsRebalance } from "../notify/telegram-buttons.js";
import { notifyRebalanceSideEmpty } from "../notify/telegram.js";
import { markTelegramCommand, takePendingCommands, TELEGRAM_COMMAND_TTL_MS } from "../notify/telegram-queue.js";

const EMPTY_REBALANCE_REASONS = new Set([
  "nothing_to_rebalance",
  "no_token_bins",
  "no_token_liquidity",
  "no_sol_bins",
  "no_sol_liquidity",
  "out_of_range",
]);

function resolveMode(pos, tracked) {
  if (isCompositeMode(pos?.mode)) return pos.mode;
  if (isCompositeMode(tracked?.mode)) return tracked.mode;
  return classifyMode(pos);
}

function rebalanceOk(res) {
  if (!res) return false;
  if (res.success === true) return true;
  return res.triggered === true && res.success !== false;
}

function emptyRebalanceReason(res) {
  if (!res || res.success === true) return null;
  const reason = res.reason || res.error;
  return EMPTY_REBALANCE_REASONS.has(reason) ? reason : null;
}

// Zap Out memakai close yang sudah ada (swap ikut AUTO_SWAP_AFTER_CLOSE).
// willReenter false: rantai re-entry OOR kanan tidak dilanjutkan.
// Rebalance memakai sisi yang dipilih (token / sol), force, jadi step diabaikan
// tetapi REBALANCE_MODE dan batas fee tetap di jalur yang sama.
// Setelah sukses, handler mencatat step terakhir sisi itu supaya auto tidak langsung menyusul.
// bidask:sol sisi SOL hanya fungsi manual; jalur otomatis tidak memanggilnya.
async function runCommand(cmd, pos, deps) {
  const label = pos.pair || pos.position?.slice(0, 8) || "?";
  if (cmd.action === "zap_out") {
    const res = await deps.handleClose(pos, "manual_telegram", { willReenter: false });
    if (res?.success) {
      log.info(`Telegram Zap Out ${label}: ditutup (manual Telegram)`);
      return { ok: true, closed: true };
    }
    return { ok: false, error: res?.error || (res?.skipped ? "close_in_progress" : "close_failed") };
  }

  if (cmd.action !== "rebalance") return { ok: false, error: "unknown_action" };
  const side = cmd.side === "token" || cmd.side === "sol" ? cmd.side : null;
  if (!side) return { ok: false, error: "side_required" };

  const tracked = deps.getTracked ? deps.getTracked(pos.position) : getTrackedPosition(pos.position);
  const mode = resolveMode(pos, tracked);
  pos.mode = mode;
  if (!modeSupportsRebalance(mode)) {
    return { ok: false, error: "rebalance_unavailable" };
  }

  const opts = { force: true, side };
  let res;
  if (mode === "spot") res = await deps.handleSpotTokenBidask(pos, opts);
  else if (mode === "bidask:double") res = await deps.handleBidaskDoubleRebalance(pos, opts);
  else if (side === "sol") res = await deps.handleBidaskSolSolSideRebalance(pos, opts);
  else res = await deps.handleBidaskSolRebalance(pos, opts);

  if (rebalanceOk(res)) {
    log.info(`Telegram Rebalance ${label} (${mode} ${side}): ${res.rebalanceType || res.reason || "selesai"}`);
    return { ok: true, closed: false, rebalanceType: res.rebalanceType || null };
  }
  const empty = emptyRebalanceReason(res);
  if (empty) {
    log.info(`Telegram Rebalance ${label} (${mode} ${side}): tidak ada yang bisa di-rebalance di sisi itu`);
    return { ok: false, empty: true, error: empty };
  }
  return { ok: false, error: res?.error || res?.reason || "rebalance_failed" };
}

export async function consumeTelegramCommands(positions, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const ttlMs = deps.ttlMs ?? TELEGRAM_COMMAND_TTL_MS;
  const take = deps.takePendingCommands || takePendingCommands;
  const mark = deps.markTelegramCommand || markTelegramCommand;
  const handlers = {
    handleClose: deps.handleClose || handleClose,
    handleSpotTokenBidask: deps.handleSpotTokenBidask || handleSpotTokenBidask,
    handleBidaskDoubleRebalance: deps.handleBidaskDoubleRebalance || handleBidaskDoubleRebalance,
    handleBidaskSolRebalance: deps.handleBidaskSolRebalance || handleBidaskSolRebalance,
    handleBidaskSolSolSideRebalance: deps.handleBidaskSolSolSideRebalance || handleBidaskSolSolSideRebalance,
    notifyRebalanceSideEmpty: deps.notifyRebalanceSideEmpty || notifyRebalanceSideEmpty,
    getTracked: deps.getTracked,
  };

  const pending = take(now, ttlMs);
  const open = new Map((positions || []).filter((p) => p?.position).map((p) => [p.position, p]));
  const closed = new Set();
  const results = [];

  for (const cmd of pending) {
    const pos = open.get(cmd.position);
    if (!pos) {
      mark(cmd.id, "failed", "position_gone", now);
      results.push({ id: cmd.id, action: cmd.action, position: cmd.position, ok: false, error: "position_gone" });
      continue;
    }
    try {
      const outcome = await runCommand(cmd, pos, handlers);
      if (outcome.ok) {
        mark(cmd.id, "done", null, now);
        if (outcome.closed) {
          closed.add(cmd.position);
          open.delete(cmd.position);
        }
      } else if (outcome.empty) {
        mark(cmd.id, "done", null, now);
        try {
          handlers.notifyRebalanceSideEmpty();
        } catch (err) {
          log.warn(`Pemberitahuan rebalance kosong gagal: ${err?.message || err}`);
        }
      } else {
        mark(cmd.id, "failed", outcome.error, now);
      }
      results.push({
        id: cmd.id,
        action: cmd.action,
        position: cmd.position,
        ...outcome,
        ok: outcome.ok || outcome.empty === true,
      });
    } catch (err) {
      const error = err?.message || "error";
      mark(cmd.id, "failed", error, now);
      log.warn(`Perintah Telegram ${cmd.action} gagal: ${error}`);
      results.push({ id: cmd.id, action: cmd.action, position: cmd.position, ok: false, error });
    }
  }

  return { closed, results };
}
