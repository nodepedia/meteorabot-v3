import config from "../config/index.js";
import { getOpenTrackedPositions } from "../state/positions.js";
import { answerCallbackQuery, editMessageReplyMarkup } from "./telegram.js";
import {
  buildStatusKeyboard,
  buttonLabel,
  decodeCallbackData,
  isAllowedTelegramChat,
  readButtonCatalog,
  resolvePositionKey,
  scheduledToast,
} from "./telegram-buttons.js";
import { enqueueTelegramCommand } from "./telegram-queue.js";

function loadOpenPositions() {
  return getOpenTrackedPositions().map((p) => ({
    position: p.position,
    pair: p.pair,
    mode: p.mode,
    closed: false,
  }));
}

function isStillOpen(address, openPositions) {
  return (openPositions || []).some((p) => p && p.closed !== true && p.position === address);
}

// Klik hanya mengubah keyboard pesan itu dan (saat ya) menulis antrean.
// Tidak mengirim pesan baru.
export async function handleCallbackQuery(query, deps = {}) {
  const allowed = deps.chatId != null ? deps.chatId : config.telegramChatId;
  const chatId = query?.message?.chat?.id;
  if (!isAllowedTelegramChat(chatId, allowed)) {
    return { ignored: true, reason: "chat" };
  }

  const buttonsEnabled = deps.buttonsEnabled != null ? deps.buttonsEnabled : config.telegramButtonsEnabled;
  const answer = deps.answerCallbackQuery || answerCallbackQuery;
  const edit = deps.editMessageReplyMarkup || editMessageReplyMarkup;
  const messageId = query?.message?.message_id;
  const open = (deps.loadOpenPositions || loadOpenPositions)();
  const catalog = (deps.loadCatalog || readButtonCatalog)();

  const restore = (pendingKey = null, pendingAction = null) =>
    buildStatusKeyboard(open, { pendingKey, pendingAction, catalog });

  if (buttonsEnabled === false) {
    if (messageId != null) await edit(chatId, messageId, { inline_keyboard: [] });
    await answer(query.id, "Dibatalkan");
    return { ignored: true, reason: "disabled" };
  }

  const decoded = decodeCallbackData(query?.data);
  if (!decoded) {
    await answer(query.id, "Dibatalkan");
    return { ignored: true, reason: "callback_data" };
  }

  const resolved = resolvePositionKey(decoded.key, catalog, open);
  if (!resolved || !isStillOpen(resolved.position, open)) {
    if (messageId != null) await edit(chatId, messageId, restore());
    await answer(query.id, "Posisi sudah tutup");
    return { ok: true, closed: true };
  }

  if (decoded.kind === "ask") {
    if (decoded.action === "rebalance" && resolved.rebalance === false) {
      if (messageId != null) await edit(chatId, messageId, restore());
      await answer(query.id, "Dibatalkan");
      return { ok: true, cancelled: true, reason: "rebalance_unavailable" };
    }
    if (messageId != null) await edit(chatId, messageId, restore(decoded.key, decoded.action));
    await answer(query.id, "");
    return { ok: true, pending: decoded.action };
  }

  if (decoded.kind === "cancel") {
    if (messageId != null) await edit(chatId, messageId, restore());
    await answer(query.id, "Dibatalkan");
    return { ok: true, cancelled: true };
  }

  const enqueue = deps.enqueue || enqueueTelegramCommand;
  const result = enqueue({
    action: decoded.action,
    position: resolved.position,
    side: decoded.side || null,
    requestedAt: deps.now ? deps.now() : Date.now(),
  });
  if (messageId != null) await edit(chatId, messageId, restore());
  const toast = result?.error ? "Dibatalkan" : scheduledToast(decoded.action, buttonLabel(resolved.label));
  await answer(query.id, toast);
  return {
    ok: !result?.error,
    enqueued: result?.enqueued === true,
    duplicate: result?.duplicate === true,
    command: result?.command || null,
  };
}
