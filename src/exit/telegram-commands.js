import log from "../core/logger.js";
import { getTrackedPosition } from "../state/positions.js";
import { classifyMode, isCompositeMode } from "./classify.js";
import { handleClose } from "./close.js";
import { handleSpotTokenBidask } from "./spot-token-bidask.js";
import { handleBidaskDoubleRebalance } from "./bidask-double-rebalance.js";
import { handleBidaskSolRebalance } from "./bidask-sol-rebalance.js";
import { modeSupportsRebalance } from "../notify/telegram-buttons.js";
import { markTelegramCommand, takePendingCommands, TELEGRAM_COMMAND_TTL_MS } from "../notify/telegram-queue.js";

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

// Zap Out memakai close yang sudah ada (swap ikut AUTO_SWAP_AFTER_CLOSE).
// willReenter false: rantai re-entry OOR kanan tidak dilanjutkan.
// Rebalance memakai handler mode itu dengan force, jadi step diabaikan
// tetapi REBALANCE_MODE dan batas fee tetap di jalur yang sama.
// Setelah sukses, handler mencatat step terakhir supaya auto tidak langsung menyusul.
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

  const tracked = deps.getTracked ? deps.getTracked(pos.position) : getTrackedPosition(pos.position);
  const mode = resolveMode(pos, tracked);
  pos.mode = mode;
  if (!modeSupportsRebalance(mode)) {
    return { ok: false, error: "rebalance_unavailable" };
  }

  const opts = { force: true };
  let res;
  if (mode === "spot") res = await deps.handleSpotTokenBidask(pos, opts);
  else if (mode === "bidask:double") res = await deps.handleBidaskDoubleRebalance(pos, opts);
  else res = await deps.handleBidaskSolRebalance(pos, opts);

  if (rebalanceOk(res)) {
    log.info(`Telegram Rebalance ${label} (${mode}): ${res.rebalanceType || res.reason || "selesai"}`);
    return { ok: true, closed: false, rebalanceType: res.rebalanceType || null };
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
      } else {
        mark(cmd.id, "failed", outcome.error, now);
      }
      results.push({ id: cmd.id, action: cmd.action, position: cmd.position, ...outcome });
    } catch (err) {
      const error = err?.message || "error";
      mark(cmd.id, "failed", error, now);
      log.warn(`Perintah Telegram ${cmd.action} gagal: ${error}`);
      results.push({ id: cmd.id, action: cmd.action, position: cmd.position, ok: false, error });
    }
  }

  return { closed, results };
}
