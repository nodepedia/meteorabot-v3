import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meteorabot-tgbtn-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.TELEGRAM_COMMANDS_FILE = path.join(TMP, "telegram-commands.json");
process.env.TELEGRAM_OFFSET_FILE = path.join(TMP, "telegram-offset.json");
process.env.TELEGRAM_BUTTONS_FILE = path.join(TMP, "telegram-buttons.json");
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));

const {
  buildStatusKeyboard,
  catalogFromPositions,
  decodeCallbackData,
  encodeCallbackData,
  isAllowedTelegramChat,
  modeSupportsRebalance,
  publishButtonCatalog,
  readButtonCatalog,
  scheduledToast,
  uniquePrefix,
} = await import("../src/notify/telegram-buttons.js");
const { buildSendPayload, buildStatusDelivery, buildStatusMessage } = await import("../src/notify/telegram.js");
const { handleCallbackQuery } = await import("../src/notify/telegram-callbacks.js");
const {
  enqueueTelegramCommand,
  listPendingCommands,
  readTelegramCommands,
  readTelegramOffset,
  writeTelegramOffset,
  TELEGRAM_COMMAND_TTL_MS,
} = await import("../src/notify/telegram-queue.js");
const { processTelegramUpdates } = await import("../src/worker-telegram.js");
const { consumeTelegramCommands } = await import("../src/exit/telegram-commands.js");
const { evaluateSpotTokenBidaskTrigger, handleSpotTokenBidask } = await import("../src/exit/spot-token-bidask.js");
const { evaluateBidaskDoubleRebalance, handleBidaskDoubleRebalance } =
  await import("../src/exit/bidask-double-rebalance.js");
const { evaluateBidaskSolRebalance, handleBidaskSolRebalance } = await import("../src/exit/bidask-sol-rebalance.js");
const { getTrackedPosition, setEntryPoolPrice, trackPosition, updateBidaskDoubleRebalanceState } =
  await import("../src/state/positions.js");
const { humanReason } = await import("../src/core/report.js");
const config = (await import("../src/config/index.js")).default;

const SPOT = "SpotPos111111111111111111111111111111111";
const SPOT2 = "Spot2Pos11111111111111111111111111111111";
const DBL = "DblPos1111111111111111111111111111111111";
const SOL = "SolPos1111111111111111111111111111111111";
const TOK = "TokPos1111111111111111111111111111111111";
const POOL = "Pool11111111111111111111111111111111111111";
const MINT = "Mint11111111111111111111111111111111111111";
const CHAT = "100";

function resetQueue() {
  fs.writeFileSync(process.env.TELEGRAM_COMMANDS_FILE, JSON.stringify({ commands: [] }));
  const lock = `${process.env.TELEGRAM_COMMANDS_FILE}.lock`;
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
}

function resetState() {
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ positions: {} }));
}

function ui() {
  const edits = [];
  const answers = [];
  return {
    edits,
    answers,
    editMessageReplyMarkup: async (chat, messageId, markup) => {
      edits.push({ chat, messageId, markup });
    },
    answerCallbackQuery: async (id, text) => {
      answers.push({ id, text });
    },
  };
}

test("callback_data pendek, unik, dan bisa dibaca kembali", () => {
  const a = "AAAAAAAA11111111111111111111111111111111";
  const b = "AAAAAAAA22222222222222222222222222222222";
  const keyA = uniquePrefix(a, [a, b]);
  const keyB = uniquePrefix(b, [a, b]);
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.length >= 8 && keyA.length < a.length);
  for (const code of ["r", "z", "R", "Z", "x", "t", "s"]) {
    const data = encodeCallbackData(code, keyA);
    assert.ok(Buffer.byteLength(data) < 64);
    const decoded = decodeCallbackData(data);
    assert.equal(decoded.key, keyA);
    assert.equal(decoded.code, code);
  }
  assert.equal(decodeCallbackData(encodeCallbackData("Z", keyA)).kind, "confirm");
  assert.equal(decodeCallbackData(encodeCallbackData("Z", keyA)).action, "zap_out");
  assert.equal(decodeCallbackData(encodeCallbackData("Z", keyA)).side, null);
  assert.equal(decodeCallbackData(encodeCallbackData("R", keyA)).kind, "ask");
  assert.equal(decodeCallbackData(encodeCallbackData("R", keyA)).action, "rebalance");
  assert.equal(decodeCallbackData(encodeCallbackData("R", keyA)).side, null);
  assert.equal(decodeCallbackData(encodeCallbackData("t", keyA)).side, "token");
  assert.equal(decodeCallbackData(encodeCallbackData("s", keyA)).side, "sol");
  assert.equal(decodeCallbackData(encodeCallbackData("x", keyA)).kind, "cancel");
  assert.equal(decodeCallbackData("nope"), null);
  assert.equal(decodeCallbackData(`z:${"a".repeat(80)}`), null);
  assert.throws(() => encodeCallbackData("Z", "a".repeat(80)));
  assert.equal(isAllowedTelegramChat(100, "100"), true);
  assert.equal(isAllowedTelegramChat("999", "100"), false);
  assert.equal(isAllowedTelegramChat("100", ""), false);
});

test("keyboard: rebalance disembunyikan untuk bidask:token, konfirmasi hanya mengganti baris itu", () => {
  const positions = [
    { position: SPOT, pair: "Macca-SOL", mode: "spot" },
    { position: TOK, pair: "Tok-SOL", mode: "bidask:token" },
    { position: SOL, pair: "Sol-SOL", mode: "bidask:sol" },
  ];
  assert.equal(modeSupportsRebalance("bidask:token"), false);
  assert.equal(modeSupportsRebalance("spot"), true);
  assert.equal(modeSupportsRebalance("bidask:double"), true);
  assert.equal(modeSupportsRebalance("bidask:sol"), true);

  const kb = buildStatusKeyboard(positions);
  assert.equal(kb.inline_keyboard.length, 3);
  assert.equal(kb.inline_keyboard[0][0].text, "♻️ Macca");
  assert.equal(kb.inline_keyboard[0][1].text, "⚡ Macca");
  assert.equal(decodeCallbackData(kb.inline_keyboard[0][0].callback_data).code, "r");
  assert.equal(decodeCallbackData(kb.inline_keyboard[0][1].callback_data).code, "z");
  assert.equal(kb.inline_keyboard[1].length, 1);
  assert.equal(kb.inline_keyboard[1][0].text, "⚡ Tok");
  assert.equal(kb.inline_keyboard[2][0].text, "♻️ Sol");
  for (const row of kb.inline_keyboard) {
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) < 64);
  }

  const zapKey = decodeCallbackData(kb.inline_keyboard[0][1].callback_data).key;
  const confirm = buildStatusKeyboard(positions, { pendingKey: zapKey, pendingAction: "zap_out" });
  assert.equal(confirm.inline_keyboard[0][0].text, "✅ Ya, zap out Macca");
  assert.equal(confirm.inline_keyboard[0][1].text, "✖️ Batal");
  assert.deepEqual(confirm.inline_keyboard[1], kb.inline_keyboard[1]);
  assert.deepEqual(confirm.inline_keyboard[2], kb.inline_keyboard[2]);
  assert.equal(decodeCallbackData(confirm.inline_keyboard[0][0].callback_data).action, "zap_out");
  assert.equal(decodeCallbackData(confirm.inline_keyboard[0][1].callback_data).kind, "cancel");

  const rebKey = decodeCallbackData(kb.inline_keyboard[0][0].callback_data).key;
  const reb = buildStatusKeyboard(positions, { pendingKey: rebKey, pendingAction: "rebalance" });
  assert.deepEqual(
    reb.inline_keyboard[0].map((button) => button.text),
    ["🪙 Sisi token Macca", "◎ Sisi SOL Macca", "✖️ Batal"]
  );
  assert.equal(decodeCallbackData(reb.inline_keyboard[0][0].callback_data).side, "token");
  assert.equal(decodeCallbackData(reb.inline_keyboard[0][1].callback_data).side, "sol");
  assert.equal(decodeCallbackData(reb.inline_keyboard[0][2].callback_data).kind, "cancel");
  assert.deepEqual(reb.inline_keyboard[1], kb.inline_keyboard[1]);
  assert.deepEqual(reb.inline_keyboard[2], kb.inline_keyboard[2]);

  assert.equal(scheduledToast("zap_out", "Macca"), "Zap Out Macca dijadwalkan");
  assert.equal(scheduledToast("rebalance", "Macca"), "Rebalance Macca dijadwalkan");
  assert.equal(humanReason("manual_telegram"), "manual (Telegram)");
});

test("keyboard: nama pair lebih dari 10 karakter satu tombol per baris", () => {
  const long = "VeryLongName-SOL";
  const symbol = "VeryLongName";
  const positions = [
    { position: SPOT, pair: long, mode: "spot" },
    { position: TOK, pair: "Tok-SOL", mode: "bidask:token" },
  ];
  const kb = buildStatusKeyboard(positions);
  assert.equal(symbol.length > 10, true);
  assert.equal(kb.inline_keyboard.length, 3);
  assert.deepEqual(
    kb.inline_keyboard[0].map((button) => button.text),
    [`♻️ ${symbol}`]
  );
  assert.deepEqual(
    kb.inline_keyboard[1].map((button) => button.text),
    [`⚡ ${symbol}`]
  );
  assert.equal(decodeCallbackData(kb.inline_keyboard[0][0].callback_data).code, "r");
  assert.equal(decodeCallbackData(kb.inline_keyboard[1][0].callback_data).code, "z");
  assert.equal(kb.inline_keyboard[2][0].text, "⚡ Tok");
  assert.equal(kb.inline_keyboard[2].length, 1);

  const key = decodeCallbackData(kb.inline_keyboard[0][0].callback_data).key;
  const reb = buildStatusKeyboard(positions, { pendingKey: key, pendingAction: "rebalance" });
  assert.equal(reb.inline_keyboard[0].length, 1);
  assert.equal(reb.inline_keyboard[0][0].text, `🪙 Sisi token ${symbol}`);
  assert.equal(decodeCallbackData(reb.inline_keyboard[0][0].callback_data).side, "token");
  assert.equal(reb.inline_keyboard[1].length, 1);
  assert.equal(reb.inline_keyboard[1][0].text, `◎ Sisi SOL ${symbol}`);
  assert.equal(decodeCallbackData(reb.inline_keyboard[1][0].callback_data).side, "sol");
  assert.equal(reb.inline_keyboard[2].length, 1);
  assert.equal(reb.inline_keyboard[2][0].text, "✖️ Batal");
  assert.equal(decodeCallbackData(reb.inline_keyboard[2][0].callback_data).code, "x");
  assert.deepEqual(reb.inline_keyboard[3], kb.inline_keyboard[2]);

  const zap = buildStatusKeyboard(positions, { pendingKey: key, pendingAction: "zap_out" });
  assert.equal(zap.inline_keyboard[0][0].text, `✅ Ya, zap out ${symbol}`);
  assert.equal(zap.inline_keyboard[0].length, 1);
  assert.equal(decodeCallbackData(zap.inline_keyboard[0][0].callback_data).code, "Z");
  assert.equal(zap.inline_keyboard[1][0].text, "✖️ Batal");
  assert.deepEqual(zap.inline_keyboard[2], kb.inline_keyboard[2]);

  const ten = "ABCDEFGHIJ";
  const atTen = buildStatusKeyboard([{ position: SPOT, pair: ten, mode: "spot" }]);
  assert.equal(ten.length, 10);
  assert.equal(atTen.inline_keyboard.length, 1);
  assert.deepEqual(
    atTen.inline_keyboard[0].map((button) => button.text),
    [`♻️ ${ten}`, `⚡ ${ten}`]
  );
  const tenKey = decodeCallbackData(atTen.inline_keyboard[0][0].callback_data).key;
  const tenConfirm = buildStatusKeyboard([{ position: SPOT, pair: ten, mode: "spot" }], {
    pendingKey: tenKey,
    pendingAction: "zap_out",
  });
  assert.equal(tenConfirm.inline_keyboard.length, 1);
  assert.deepEqual(
    tenConfirm.inline_keyboard[0].map((button) => button.text),
    [`✅ Ya, zap out ${ten}`, "✖️ Batal"]
  );
  const tenSides = buildStatusKeyboard([{ position: SPOT, pair: ten, mode: "spot" }], {
    pendingKey: tenKey,
    pendingAction: "rebalance",
  });
  assert.equal(tenSides.inline_keyboard.length, 1);
  assert.deepEqual(
    tenSides.inline_keyboard[0].map((button) => button.text),
    [`🪙 Sisi token ${ten}`, `◎ Sisi SOL ${ten}`, "✖️ Batal"]
  );

  const eleven = "ABCDEFGHIJK";
  const tokenLong = buildStatusKeyboard([{ position: TOK, pair: eleven, mode: "bidask:token" }]);
  assert.equal(eleven.length, 11);
  assert.equal(tokenLong.inline_keyboard.length, 1);
  assert.equal(tokenLong.inline_keyboard[0][0].text, `⚡ ${eleven}`);
  assert.equal(decodeCallbackData(tokenLong.inline_keyboard[0][0].callback_data).code, "z");
});

test("tombol mati: teks status sama, tanpa keyboard", () => {
  const positions = [
    {
      pair: "Macca-SOL",
      position: SPOT,
      ageMinutes: 4,
      pnlPct: 1.5,
      feePct24h: 8,
      activeBin: 10,
      lowerBin: 0,
      upperBin: 20,
      mode: "bidask:sol",
    },
  ];
  const text = buildStatusMessage(positions);
  const off = buildStatusDelivery(positions, { enabled: false });
  const on = buildStatusDelivery(positions, { enabled: true });
  assert.equal(off.text, text);
  assert.equal(on.text, text);
  assert.equal(off.reply_markup, undefined);
  assert.ok(on.reply_markup.inline_keyboard.length > 0);
  assert.doesNotMatch(text, /Zap Out|Rebalance|Exit at/);

  const plain = buildSendPayload("halo");
  assert.equal(plain.reply_markup, undefined);
  const markup = { inline_keyboard: [[{ text: "⚡ Zap Out X", callback_data: "z:abc" }]] };
  const withButtons = buildSendPayload("halo", { reply_markup: markup });
  assert.deepEqual(withButtons.reply_markup, markup);
  assert.equal(withButtons.text, "halo");
  assert.equal(config.telegramButtonsEnabled, true);
});

test("callback chat lain diabaikan; konfirmasi, batal, tutup, dan antrean idempoten", async () => {
  resetState();
  resetQueue();
  trackPosition(SPOT, POOL, "Macca-SOL", MINT, 0, "spot");
  trackPosition(TOK, POOL, "Tok-SOL", MINT, 0, "bidask:token");
  const before = fs.readFileSync(process.env.STATE_FILE, "utf8");
  const open = [
    { position: SPOT, pair: "Macca-SOL", mode: "spot" },
    { position: TOK, pair: "Tok-SOL", mode: "bidask:token" },
  ];
  const catalog = catalogFromPositions(open);
  publishButtonCatalog(open);
  assert.equal(readButtonCatalog()[uniquePrefix(SPOT, [SPOT, TOK])].position, SPOT);

  let enqueued = 0;
  const ignored = await handleCallbackQuery(
    {
      id: "foreign",
      data: encodeCallbackData("Z", uniquePrefix(SPOT, [SPOT, TOK])),
      message: { message_id: 7, chat: { id: 999 } },
    },
    {
      chatId: CHAT,
      enqueue: () => {
        enqueued += 1;
        return { enqueued: true };
      },
      answerCallbackQuery: async () => {
        enqueued += 1;
      },
      editMessageReplyMarkup: async () => {
        enqueued += 1;
      },
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
    }
  );
  assert.equal(ignored.reason, "chat");
  assert.equal(enqueued, 0);

  const answeredOther = [];
  await processTelegramUpdates(
    [
      { update_id: 4, message: { text: "bukan callback" } },
      {
        update_id: 5,
        callback_query: {
          id: "other",
          data: encodeCallbackData("z", "NopeNope"),
          message: { message_id: 1, chat: { id: "999" } },
        },
      },
    ],
    {
      chatId: CHAT,
      enqueue: () => {
        enqueued += 1;
        return { enqueued: true };
      },
      answerCallbackQuery: async () => {
        answeredOther.push(1);
      },
      editMessageReplyMarkup: async () => {
        answeredOther.push(1);
      },
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      writeOffset: (n) => writeTelegramOffset(n),
    }
  );
  assert.equal(enqueued, 0);
  assert.equal(answeredOther.length, 0);
  assert.equal(readTelegramOffset(), 6);

  const kb = buildStatusKeyboard(open, { catalog });
  const view = ui();
  await handleCallbackQuery(
    {
      id: "ask-zap",
      data: kb.inline_keyboard[0][1].callback_data,
      message: { message_id: 42, chat: { id: Number(CHAT) } },
    },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: () => {
        throw new Error("klik pertama tidak boleh mengantre");
      },
      ...view,
    }
  );
  assert.equal(view.edits[0].messageId, 42);
  assert.equal(view.edits[0].markup.inline_keyboard[0][0].text, "✅ Ya, zap out Macca");
  assert.equal(view.edits[0].markup.inline_keyboard[0][1].text, "✖️ Batal");
  assert.deepEqual(view.edits[0].markup.inline_keyboard[1], kb.inline_keyboard[1]);
  assert.equal(view.answers[0].text, "");

  const confirmData = view.edits[0].markup.inline_keyboard[0][0].callback_data;
  const cancelData = view.edits[0].markup.inline_keyboard[0][1].callback_data;
  view.edits.length = 0;
  view.answers.length = 0;
  const queued = [];
  const confirmed = await handleCallbackQuery(
    { id: "yes-zap", data: confirmData, message: { message_id: 42, chat: { id: CHAT } } },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: (cmd) => {
        queued.push(cmd);
        return enqueueTelegramCommand(cmd);
      },
      ...view,
    }
  );
  assert.equal(confirmed.enqueued, true);
  assert.equal(queued[0].action, "zap_out");
  assert.equal(queued[0].position, SPOT);
  assert.equal(view.answers[0].text, "Zap Out Macca dijadwalkan");
  assert.equal(queued[0].side, null);
  assert.equal(view.edits[0].markup.inline_keyboard[0][0].text, "♻️ Macca");
  assert.equal(view.edits[0].markup.inline_keyboard[0][1].text, "⚡ Macca");
  assert.equal(fs.readFileSync(process.env.STATE_FILE, "utf8"), before);

  const again = enqueueTelegramCommand({ action: "zap_out", position: SPOT, requestedAt: Date.now() });
  assert.equal(again.duplicate, true);
  assert.equal(again.enqueued, false);
  assert.equal(listPendingCommands().filter((cmd) => cmd.action === "zap_out" && cmd.position === SPOT).length, 1);

  view.edits.length = 0;
  view.answers.length = 0;
  await handleCallbackQuery(
    {
      id: "ask-reb",
      data: kb.inline_keyboard[0][0].callback_data,
      message: { message_id: 42, chat: { id: CHAT } },
    },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: () => {
        throw new Error("batal tidak lewat antrean");
      },
      ...view,
    }
  );
  assert.deepEqual(
    view.edits[0].markup.inline_keyboard[0].map((button) => button.text),
    ["🪙 Sisi token Macca", "◎ Sisi SOL Macca", "✖️ Batal"]
  );
  const rebCancel = view.edits[0].markup.inline_keyboard[0][2].callback_data;
  const sideTokenData = view.edits[0].markup.inline_keyboard[0][0].callback_data;
  assert.equal(rebCancel, cancelData);
  view.edits.length = 0;
  view.answers.length = 0;
  await handleCallbackQuery(
    { id: "cancel", data: rebCancel, message: { message_id: 42, chat: { id: CHAT } } },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: () => {
        throw new Error("batal tidak boleh mengantre");
      },
      ...view,
    }
  );
  assert.equal(view.answers[0].text, "Dibatalkan");
  assert.equal(view.edits[0].markup.inline_keyboard[0][1].text, "⚡ Macca");

  view.edits.length = 0;
  view.answers.length = 0;
  const sideQueued = [];
  const sided = await handleCallbackQuery(
    { id: "side-token", data: sideTokenData, message: { message_id: 42, chat: { id: CHAT } } },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: (cmd) => {
        sideQueued.push(cmd);
        return enqueueTelegramCommand(cmd);
      },
      ...view,
    }
  );
  assert.equal(sided.enqueued, true);
  assert.equal(sideQueued[0].action, "rebalance");
  assert.equal(sideQueued[0].side, "token");
  assert.equal(sideQueued[0].position, SPOT);
  assert.equal(view.answers[0].text, "Rebalance Macca dijadwalkan");
  assert.equal(view.edits[0].markup.inline_keyboard[0][0].text, "♻️ Macca");

  view.edits.length = 0;
  view.answers.length = 0;
  let oldConfirmEnqueue = 0;
  const oldConfirm = await handleCallbackQuery(
    {
      id: "old-r",
      data: encodeCallbackData("R", uniquePrefix(SPOT, [SPOT, TOK])),
      message: { message_id: 42, chat: { id: CHAT } },
    },
    {
      chatId: CHAT,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: () => {
        oldConfirmEnqueue += 1;
        return { enqueued: true };
      },
      ...view,
    }
  );
  assert.equal(oldConfirm.pending, "rebalance");
  assert.equal(oldConfirmEnqueue, 0);
  assert.equal(view.edits[0].markup.inline_keyboard[0][0].text, "🪙 Sisi token Macca");
  assert.equal(view.answers[0].text, "");

  view.edits.length = 0;
  view.answers.length = 0;
  const closed = await handleCallbackQuery(
    {
      id: "gone",
      data: kb.inline_keyboard[0][1].callback_data,
      message: { message_id: 42, chat: { id: CHAT } },
    },
    {
      chatId: CHAT,
      loadOpenPositions: () => open.filter((p) => p.position !== SPOT),
      loadCatalog: () => catalog,
      enqueue: () => {
        throw new Error("posisi tutup tidak boleh mengantre");
      },
      ...view,
    }
  );
  assert.equal(closed.closed, true);
  assert.equal(view.answers[0].text, "Posisi sudah tutup");
  assert.equal(view.edits[0].markup.inline_keyboard.length, 1);
  assert.equal(view.edits[0].markup.inline_keyboard[0][0].text, "⚡ Tok");

  view.edits.length = 0;
  view.answers.length = 0;
  let disabledEnqueue = 0;
  const disabled = await handleCallbackQuery(
    { id: "off", data: confirmData, message: { message_id: 42, chat: { id: CHAT } } },
    {
      chatId: CHAT,
      buttonsEnabled: false,
      loadOpenPositions: () => open,
      loadCatalog: () => catalog,
      enqueue: () => {
        disabledEnqueue += 1;
        return { enqueued: true };
      },
      ...view,
    }
  );
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabledEnqueue, 0);
  assert.equal(view.answers[0].text, "Dibatalkan");
  assert.deepEqual(view.edits[0].markup, { inline_keyboard: [] });
  assert.equal(fs.readFileSync(process.env.STATE_FILE, "utf8"), before);
});

test("antrean: duplikat, kedaluwarsa, dan exit menjalankan zap_out serta rebalance per mode", async () => {
  resetQueue();
  const now = Date.now();
  const first = enqueueTelegramCommand({ action: "rebalance", position: DBL, side: "token", requestedAt: now });
  const second = enqueueTelegramCommand({ action: "rebalance", position: DBL, side: "token", requestedAt: now + 1 });
  const otherSide = enqueueTelegramCommand({ action: "rebalance", position: DBL, side: "sol", requestedAt: now + 2 });
  assert.equal(first.enqueued, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.command.id, first.command.id);
  assert.equal(otherSide.enqueued, true);
  assert.notEqual(otherSide.command.id, first.command.id);
  const missingSide = enqueueTelegramCommand({ action: "rebalance", position: DBL, requestedAt: now });
  assert.equal(missingSide.error, "invalid_command");
  assert.equal(missingSide.enqueued, false);

  enqueueTelegramCommand({ action: "zap_out", position: SPOT, requestedAt: now });
  enqueueTelegramCommand({ action: "rebalance", position: SPOT2, side: "sol", requestedAt: now });
  enqueueTelegramCommand({ action: "rebalance", position: SOL, side: "token", requestedAt: now });
  enqueueTelegramCommand({ action: "rebalance", position: "SolSidePos", side: "sol", requestedAt: now });
  enqueueTelegramCommand({ action: "rebalance", position: TOK, side: "token", requestedAt: now });
  enqueueTelegramCommand({ action: "zap_out", position: "missing-position", requestedAt: now });
  enqueueTelegramCommand({
    action: "rebalance",
    position: "stale-position",
    side: "token",
    requestedAt: now - TELEGRAM_COMMAND_TTL_MS - 1000,
  });

  const calls = [];
  const consumed = await consumeTelegramCommands(
    [
      { position: SPOT, mode: "spot", pair: "Macca-SOL", pool: POOL, baseMint: MINT },
      { position: SPOT2, mode: "spot", pair: "Spot2-SOL", pool: POOL, baseMint: MINT },
      { position: DBL, mode: "bidask:double", pair: "Dbl-SOL", pool: POOL, baseMint: MINT },
      { position: SOL, mode: "bidask:sol", pair: "Sol-SOL", pool: POOL, baseMint: MINT },
      { position: "SolSidePos", mode: "bidask:sol", pair: "Side-SOL", pool: POOL, baseMint: MINT },
      { position: TOK, mode: "bidask:token", pair: "Tok-SOL", pool: POOL, baseMint: MINT },
    ],
    {
      now: () => now,
      handleClose: async (pos, reason, opts) => {
        calls.push({ fn: "close", position: pos.position, reason, opts });
        return { success: true };
      },
      handleSpotTokenBidask: async (pos, opts) => {
        calls.push({ fn: "spot", position: pos.position, opts });
        return { success: true, triggered: true, rebalanceType: "token_bidask" };
      },
      handleBidaskDoubleRebalance: async (pos, opts) => {
        calls.push({ fn: "double", position: pos.position, opts });
        return { success: true, triggered: true, rebalanceType: "token_bidask" };
      },
      handleBidaskSolRebalance: async (pos, opts) => {
        calls.push({ fn: "sol", position: pos.position, opts });
        return { success: true, triggered: true, rebalanceType: "token_bidask" };
      },
      handleBidaskSolSolSideRebalance: async (pos, opts) => {
        calls.push({ fn: "solside", position: pos.position, opts });
        return { success: true, triggered: true, rebalanceType: "sol_bidask" };
      },
    }
  );

  const close = calls.find((call) => call.fn === "close");
  assert.equal(close.position, SPOT);
  assert.equal(close.reason, "manual_telegram");
  assert.equal(close.opts.willReenter, false);
  assert.notEqual(close.opts.skipAutoSwap, true);
  assert.equal(calls.filter((call) => call.fn === "close").length, 1);
  assert.equal(consumed.closed.has(SPOT), true);

  const spot = calls.find((call) => call.fn === "spot");
  assert.equal(spot.position, SPOT2);
  assert.deepEqual(spot.opts, { force: true, side: "sol" });
  const doubleToken = calls.find((call) => call.fn === "double" && call.opts.side === "token");
  const doubleSol = calls.find((call) => call.fn === "double" && call.opts.side === "sol");
  assert.equal(doubleToken.position, DBL);
  assert.deepEqual(doubleToken.opts, { force: true, side: "token" });
  assert.equal(doubleSol.position, DBL);
  assert.deepEqual(doubleSol.opts, { force: true, side: "sol" });
  assert.deepEqual(calls.find((call) => call.fn === "sol").opts, { force: true, side: "token" });
  assert.equal(calls.find((call) => call.fn === "sol").position, SOL);
  assert.deepEqual(calls.find((call) => call.fn === "solside").opts, { force: true, side: "sol" });
  assert.equal(calls.find((call) => call.fn === "solside").position, "SolSidePos");
  assert.equal(
    calls.some((call) => call.position === TOK),
    false
  );

  const saved = readTelegramCommands().commands;
  const byPosition = (position, action) => saved.find((cmd) => cmd.position === position && cmd.action === action);
  assert.equal(byPosition(SPOT, "zap_out").status, "done");
  assert.equal(byPosition(SPOT2, "rebalance").status, "done");
  assert.equal(saved.filter((cmd) => cmd.position === DBL && cmd.status === "done").length, 2);
  assert.equal(byPosition(SOL, "rebalance").status, "done");
  assert.equal(byPosition("SolSidePos", "rebalance").status, "done");
  assert.equal(byPosition(TOK, "rebalance").status, "failed");
  assert.equal(byPosition(TOK, "rebalance").error, "rebalance_unavailable");
  assert.equal(byPosition("missing-position", "zap_out").status, "failed");
  assert.equal(byPosition("missing-position", "zap_out").error, "position_gone");
  assert.equal(byPosition("stale-position", "rebalance").status, "failed");
  assert.equal(byPosition("stale-position", "rebalance").error, "expired");
  assert.equal(saved.filter((cmd) => cmd.status === "pending").length, 0);
});

test("rebalance manual mengabaikan step, bidask:sol hanya sisi token, dan step terakhir menahan auto", async () => {
  resetState();
  const spot = {
    position: SPOT,
    pool: POOL,
    pair: "Macca-SOL",
    baseMint: MINT,
    mode: "spot",
    lowerBin: 100,
    upperBin: 300,
    activeBin: 280,
  };
  trackPosition(spot.position, spot.pool, spot.pair, spot.baseMint, 0, "spot");
  const tokenSide = await handleSpotTokenBidask(spot, { force: true, dryRun: true });
  assert.equal(tokenSide.success, true);
  assert.equal(tokenSide.rebalanceType, "token_bidask");
  const afterToken = evaluateSpotTokenBidaskTrigger({ pos: spot, tracked: getTrackedPosition(spot.position) });
  assert.equal(afterToken.action, "none");

  const solSpot = { ...spot, activeBin: 290 };
  const partial = evaluateSpotTokenBidaskTrigger({
    pos: solSpot,
    tracked: { ...getTrackedPosition(spot.position), lastSpotTokenBidaskPct: 10, lastSpotTokenBidaskBin: null },
    force: true,
  });
  assert.equal(partial.action, "rebalance_sol_spot");
  const autoPartial = evaluateSpotTokenBidaskTrigger({
    pos: solSpot,
    tracked: { lastSpotTokenBidaskPct: 10, lastSpotTokenBidaskAt: null, lastSpotTokenBidaskBin: null },
  });
  assert.equal(autoPartial.action, "none");

  const sol = { ...spot, position: SOL, mode: "bidask:sol", activeBin: 280 };
  trackPosition(sol.position, sol.pool, sol.pair, sol.baseMint, 0, "bidask:sol");
  const solDecision = evaluateBidaskSolRebalance({
    pos: { ...sol, activeBin: 290 },
    tracked: { lastBidaskSolRebalancePct: 30 },
    cfg: { enabled: true, stepPct: 10 },
    force: true,
  });
  assert.equal(solDecision.action, "rebalance");
  assert.notEqual(solDecision.action, "rebalance_sol");
  const noToken = evaluateBidaskSolRebalance({
    pos: { ...sol, activeBin: 300 },
    tracked: { lastBidaskSolRebalancePct: 20 },
    cfg: { enabled: true, stepPct: 10 },
    force: true,
  });
  assert.equal(noToken.reason, "no_token_bins");
  assert.equal(noToken.action, "none");
  const solRun = await handleBidaskSolRebalance(sol, { force: true, dryRun: true });
  assert.equal(solRun.rebalanceType, "token_bidask");
  assert.equal(solRun.success, true);
  const solAuto = evaluateBidaskSolRebalance({
    pos: sol,
    tracked: getTrackedPosition(sol.position),
    cfg: config.bidaskSolRebalance,
  });
  assert.equal(solAuto.action, "none");

  const dbl = {
    position: DBL,
    pool: POOL,
    pair: "Dbl-SOL",
    baseMint: MINT,
    mode: "bidask:double",
    activeBin: 40,
    lowerBin: 0,
    upperBin: 100,
  };
  trackPosition(dbl.position, dbl.pool, dbl.pair, dbl.baseMint, 0, "bidask:double");
  setEntryPoolPrice(dbl.position, 1);
  const dblRun = await handleBidaskDoubleRebalance(dbl, {
    force: true,
    dryRun: true,
    priceChangePct: -15,
    skipLiveGuard: true,
  });
  assert.equal(dblRun.rebalanceType, "token_bidask");
  assert.equal(dblRun.success, true);
  const dblAuto = evaluateBidaskDoubleRebalance({
    pos: dbl,
    tracked: getTrackedPosition(dbl.position),
    cfg: config.bidaskDoubleRebalance,
    priceChangePct: -15,
  });
  assert.equal(dblAuto.action, "none");

  updateBidaskDoubleRebalanceState(dbl.position, 10, Date.now() - 120_000, null);
  const dblSol = evaluateBidaskDoubleRebalance({
    pos: dbl,
    tracked: getTrackedPosition(dbl.position),
    cfg: config.bidaskDoubleRebalance,
    priceChangePct: -5,
    force: true,
  });
  assert.equal(dblSol.action, "rebalance_sol");
  const dblSolAuto = evaluateBidaskDoubleRebalance({
    pos: dbl,
    tracked: getTrackedPosition(dbl.position),
    cfg: config.bidaskDoubleRebalance,
    priceChangePct: -5,
  });
  assert.notEqual(dblSolAuto.action, "rebalance_sol");

  const tokenOnly = evaluateBidaskDoubleRebalance({
    pos: { position: TOK, mode: "bidask:token" },
    tracked: {},
    cfg: config.bidaskDoubleRebalance,
    priceChangePct: -40,
    force: true,
  });
  assert.equal(tokenOnly.reason, "not_bidask_double");

  const atTop = { ...spot, activeBin: 300 };
  const noTokenSide = evaluateSpotTokenBidaskTrigger({
    pos: atTop,
    tracked: getTrackedPosition(spot.position),
    side: "token",
  });
  assert.equal(noTokenSide.action, "none");
  assert.equal(noTokenSide.reason, "no_token_bins");
  const solAnyway = evaluateSpotTokenBidaskTrigger({
    pos: atTop,
    tracked: getTrackedPosition(spot.position),
    side: "sol",
  });
  assert.equal(solAnyway.action, "rebalance_sol_spot");
  const solRunManual = await handleSpotTokenBidask(atTop, { force: true, side: "sol", dryRun: true });
  assert.equal(solRunManual.success, true);
  assert.equal(solRunManual.rebalanceType, "sol_spot");

  const dblDownSol = evaluateBidaskDoubleRebalance({
    pos: dbl,
    tracked: getTrackedPosition(dbl.position),
    cfg: config.bidaskDoubleRebalance,
    priceChangePct: -15,
    side: "sol",
  });
  assert.equal(dblDownSol.action, "rebalance_sol");
});

test("sisi kosong ditandai selesai dan memberi tahu tidak ada yang bisa di-rebalance", async () => {
  resetQueue();
  const now = Date.now();
  enqueueTelegramCommand({ action: "rebalance", position: SPOT, side: "token", requestedAt: now });
  const notices = [];
  const consumed = await consumeTelegramCommands(
    [{ position: SPOT, mode: "spot", pair: "Macca-SOL", pool: POOL, baseMint: MINT }],
    {
      now: () => now,
      handleSpotTokenBidask: async () => ({ triggered: false, reason: "no_token_bins" }),
      notifyRebalanceSideEmpty: () => notices.push("Tidak ada yang bisa di-rebalance di sisi itu"),
    }
  );
  assert.deepEqual(notices, ["Tidak ada yang bisa di-rebalance di sisi itu"]);
  assert.equal(consumed.results[0].empty, true);
  assert.equal(consumed.results[0].ok, true);
  const saved = readTelegramCommands().commands[0];
  assert.equal(saved.status, "done");
  assert.equal(saved.error, null);
  assert.equal(saved.side, "token");
});
