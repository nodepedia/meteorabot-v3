import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "entrybot-"));
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.DECISION_LOG_FILE = path.join(TMP, "decision-log.json");
process.env.PNL_HISTORY_FILE = path.join(TMP, "pnl-history.json");
process.env.RUNTIME_STATE_FILE = path.join(TMP, "runtime-state.json");
process.env.ENTRYBOT_STATE_FILE = path.join(TMP, "entrybot.json");
process.env.TELEGRAM_BOT_TOKEN = "";

const MINT = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const SOL = "So11111111111111111111111111111111111111112";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const POS = "9fR3kP2mQ8vL5sT1aY6bN4cD7eH2wJ8uX3pM6qR1sT4u";
const TX = "5Kq7mN2pR8sT4vW6xY1zA3bC5dE7fG9hJ2kL4mN6pQ8rS1tU3vW5xY7zA9bC1dE";

const {
  classifyEntrySkip,
  commitReview,
  emptySession,
  findOpenedPosition,
  formatEntryLine,
  isSolanaMint,
  parseTargetPrice,
  pctApart,
  reviewQueue,
  SKIP_THROTTLE_MS,
  triggerPhrase,
} = await import("../src/entrybot/logic.js");
const { handleEntrybotTurn } = await import("../src/entrybot/flow.js");
const { takeNewActions, takeNewLogLines } = await import("../src/entrybot/logs.js");
const { createTelegramApi } = await import("../src/entrybot/api.js");
const { loadEntrybotState, saveEntrybotState, emptyEntrybotState } = await import("../src/entrybot/store.js");
const { runEntrybot } = await import("../src/worker-entrybot.js");
const { appendCaEntryLine, commentPoolInList, parsePoolList } = await import("../src/entry/pool-list.js");

function discoveryPool() {
  return {
    pool_address: POOL,
    token_x: { address: MINT, symbol: "BONK" },
    token_y: { address: SOL, symbol: "SOL" },
    pool_type: "dlmm",
    tvl: 50000,
    fee_active_tvl_ratio: 1.5,
    fees: { "24h": 100 },
    dlmm_params: { bin_step: 100 },
    is_blacklisted: false,
  };
}

function harness() {
  let now = 1_700_000_000_000;
  const lines = [];
  const deps = {
    now: () => now,
    allowedChatId: "42",
    defaultSizeSol: 0.1,
    newId: () => "q1",
    quoteMint: async () => ({ symbol: "BONK", priceUsd: 0.004, priceSol: 0.00002, pools: [discoveryPool()] }),
    appendLine: async (line) => {
      const mint = line.split(",")[0];
      if (lines.some((row) => !row.startsWith("#") && row.split(",")[0] === mint))
        return { ok: false, duplicate: true };
      lines.push(line);
      return { ok: true, line };
    },
    readPoolText: () => lines.join("\n"),
    commentAddress: (address) => {
      let changed = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith("#") && lines[i].split(",")[0] === address) {
          lines[i] = `#${lines[i]}`;
          changed = true;
        }
      }
      return changed;
    },
  };
  return {
    deps,
    lines,
    setNow(value) {
      now = value;
    },
    now: () => now,
  };
}

async function turn(state, event, box) {
  return handleEntrybotTurn(state, { chatId: "42", ...event }, box.deps);
}

test("mint dan harga target mengikuti aturan pool.txt", () => {
  assert.equal(isSolanaMint(MINT), true);
  assert.equal(isSolanaMint("bonk"), false);
  assert.equal(isSolanaMint(`${MINT}x`), false);
  assert.equal(parseTargetPrice("0.0000379sol").ok, true);
  assert.equal(parseTargetPrice("0.0000379SOL").entryPriceUnit, "sol");
  assert.equal(parseTargetPrice("0.009usd").entryPriceUnit, "usd");
  assert.equal(parseTargetPrice("0.009").entryPriceUnit, "usd");
  assert.equal(parseTargetPrice("0.0000379 sol").token, "0.0000379sol");
  assert.equal(parseTargetPrice("0").ok, false);
  assert.equal(parseTargetPrice("-1sol").ok, false);
  assert.equal(parseTargetPrice("0.1btc").reason, "suffix");
  assert.equal(
    formatEntryLine({ strategy: "bidask:sol", mint: MINT, targetToken: "0.0000379sol" }),
    `${MINT},,,bidask:sol,ca,0.0000379sol`
  );
  assert.equal(formatEntryLine({ strategy: "bidask:double", mint: MINT }), `${MINT},,,bidask:double,ca`);
  assert.equal(formatEntryLine({ strategy: "spot", mint: MINT }), `${MINT},,,spot,ca`);
  const parsed = parsePoolList(`${MINT},,,bidask:sol,ca,0.0000379sol\n${MINT}2,,,spot,ca`.replace("2", ""));
  assert.equal(parsed[0].mode, "bidask:sol");
  assert.equal(parsed[0].entryPriceUnit, "sol");
  assert.equal(parsed[0].sizeSol > 0, true);
});

test("pemicu bidask sol sama dengan decideBidaskSolTouch", () => {
  assert.equal(triggerPhrase("bidask:sol", 0.00002, 0.0000379), "tunggu harga naik sampai target");
  assert.equal(triggerPhrase("bidask:sol", 0.001, 0.0000379), "tunggu harga turun sampai target");
  assert.equal(triggerPhrase("bidask:sol", 0.009, 0.009), "entry sekarang");
  assert.equal(triggerPhrase("bidask:double"), "tunggu sinyal Supertrend");
  assert.equal(triggerPhrase("spot"), "entry langsung");
  assert.ok(pctApart(0.00002, 0.0000379) > 0);
});

test("wizard bidask sol sampai antrean, tolak harga buruk dan duplikat", async () => {
  const box = harness();
  let state = emptyEntrybotState();
  let ignored = await handleEntrybotTurn(state, { type: "text", chatId: "7", text: "/entry" }, box.deps);
  assert.equal(ignored.ignored, true);

  let res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /🎯 Entry baru \/ Pilih strategi:/);
  assert.equal(res.replies[0].keyboard.inline_keyboard[0][0].text, "Bidask SOL");

  res = await turn(state, { type: "callback", data: "eb:st:sol" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /Bidask SOL dipilih\. Kirim CA token:/);

  res = await turn(state, { type: "text", text: "bukan-ca" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /nggak valid/);
  assert.equal(state.session.step, "ca");

  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  assert.match(res.replies[0].text, /BONK/);
  assert.match(res.replies[0].text, /Kirim harga target/);
  assert.equal(state.session.step, "price");

  res = await turn(state, { type: "text", text: "0sol" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /lebih dari 0/);
  res = await turn(state, { type: "text", text: "1eth" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /Satuan nggak dikenal/);

  res = await turn(state, { type: "text", text: "0.0000379sol" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /📋 Konfirmasi entry/);
  assert.match(res.replies[0].text, /0\.1 SOL \(preset\)/);
  assert.match(res.replies[0].text, /tunggu harga naik sampai target/);
  assert.match(res.replies[0].text, /bin step 100/);
  assert.match(res.replies[0].text, /Pool calon/);

  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.equal(box.lines[0], `${MINT},,,bidask:sol,ca,0.0000379sol`);
  assert.match(res.replies[0].text, /⏳ Masuk antrean, dipantau/);
  assert.equal(state.items[0].status, "watching");
  assert.equal(state.session.step, "idle");

  res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:st:sol" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: "0.01" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /sudah ada di antrean/);
  assert.equal(box.lines.length, 1);
});

test("spot dan bidask double tidak minta harga; batal dan timeout", async () => {
  const box = harness();
  let state = emptyEntrybotState();
  let res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:st:spt" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  assert.match(res.replies[0].text, /entry langsung/);
  assert.match(res.replies[0].text, /dihitung saat entry/);
  assert.doesNotMatch(res.replies[0].text, /Kirim harga target/);

  res = await turn(state, { type: "text", text: "/batal" }, box);
  state = res.state;
  assert.equal(state.session.step, "idle");
  assert.match(res.replies[0].text, /dibatalin/);

  state = {
    ...emptyEntrybotState(),
    session: {
      ...emptySession(box.now() - 11 * 60 * 1000),
      step: "ca",
      strategy: "spot",
      updatedAt: box.now() - 11 * 60 * 1000,
    },
  };
  res = await turn(state, { type: "text", text: MINT }, box);
  assert.match(res.replies[0].text, /kedaluwarsa/);
  assert.equal(res.state.session.step, "idle");
});

test("bidask double ringkasannya nunggu supertrend", async () => {
  const box = harness();
  let state = emptyEntrybotState();
  let res = await turn(state, { type: "callback", data: "eb:st:dbl" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  assert.match(res.replies[0].text, /tunggu sinyal Supertrend/);
  assert.match(res.replies[0].text, /Bidask Double/);
});

test("/antrean menandai entrybot dan hapus mengomentari baris", async () => {
  const box = harness();
  box.lines.push("KEEPME,1x,,spot", `${MINT},,,bidask:sol,ca,0.0000379sol`);
  let state = emptyEntrybotState();
  state.items = [
    {
      id: "q1",
      mint: MINT,
      symbol: "BONK",
      strategy: "bidask:sol",
      status: "watching",
      queuedAt: 1,
      skips: {},
      fromEntrybot: true,
    },
  ];
  let res = await turn(state, { type: "text", text: "/antrean" }, box);
  assert.match(res.replies[0].text, /dari entrybot/);
  assert.match(res.replies[0].text, /manual/);
  res = await turn(state, { type: "callback", data: `eb:rm:${MINT}` }, box);
  assert.match(res.replies[0].text, /di-#/);
  assert.equal(box.lines[1].startsWith("#"), true);
  assert.equal(box.lines[0].startsWith("#"), false);
  assert.equal(res.state.items[0].status, "removed");
});

test("pantau posisi terbuka, skip yang ditahan, dan baris hilang", () => {
  const queuedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const item = {
    id: "q1",
    mint: MINT,
    symbol: "BONK",
    strategy: "spot",
    sizeSol: 0.1,
    status: "watching",
    queuedAt,
    skips: {},
  };
  const poolText = `${MINT},,,spot,ca\n`;
  const skipLine = `[2026-01-01T00:00:02.000Z] [INFO] CA ${MINT.slice(0, 8)} skip: tidak ada pool DLMM`;
  const once = reviewQueue([item], { poolText, positions: {}, logLines: [skipLine] }, queuedAt + 5000);
  assert.match(once.notes[0].text, /⚠️ BONK belum bisa entry: tidak ada pool DLMM\. Masih nunggu\./);
  const again = reviewQueue(once.items, { poolText, positions: {}, logLines: [skipLine] }, queuedAt + 6000);
  assert.equal(again.notes.length, 0);
  const later = reviewQueue(
    once.items,
    { poolText, positions: {}, logLines: [skipLine] },
    queuedAt + SKIP_THROTTLE_MS + 10_000
  );
  assert.equal(later.notes.length, 1);

  const low = reviewQueue(
    [{ ...item, id: "q2", skips: {} }],
    { poolText, positions: {}, logLines: ["Entry failed for 3C6qVymT: insufficient SOL: have 0.0100, need 0.1500"] },
    queuedAt + 5000
  );
  assert.match(low.notes[0].text, /SOL di wallet kurang/);

  const opened = findOpenedPosition(item, {
    a: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt + 1000, position: POS, pool: POOL },
    old: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt - 60_000, position: "old" },
  });
  assert.equal(opened.position, POS);
  const done = reviewQueue(
    [item],
    {
      poolText: "",
      positions: { a: { ...opened, entrySizeSol: 0.1 } },
      logLines: [`SPOT position opened: ${POS} (tx: ${TX}) | bins [1..2] step 80`],
    },
    queuedAt + 2000
  );
  assert.match(done.notes[0].text, /✅ Entry BONK berhasil/);
  assert.match(done.notes[0].text, new RegExp(`https://solscan.io/tx/${TX}`));
  assert.match(done.notes[0].text, /Bin step : 80/);
  assert.equal(done.items[0].status, "entered");

  const gone = reviewQueue([item], { poolText: "", positions: {}, logLines: [] }, queuedAt + 2000);
  assert.match(gone.notes[0].text, /tidak aktif/);
  const kept = commitReview([item], gone, []);
  assert.equal(kept[0].status, "watching");
});

test("classify skip tidak menganggap log bin step sukses sebagai gagal", () => {
  assert.equal(classifyEntrySkip(`CA ${MINT.slice(0, 8)} → pool ${POOL.slice(0, 8)} (bin step 100, TVL 50000)`), null);
  assert.equal(classifyEntrySkip("[DRY RUN] Would enter bidask:sol CA 7EJqZHD4").code, "dry_run");
  assert.equal(classifyEntrySkip("REDFLAG non-refundable rent").code, "non_refundable");
});

test("append pool.txt atomik, header utuh, duplikat ditolak", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entrybot-pool-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, "KEEPME,1x,,spot\n");
  const line = `${MINT},,,spot,ca`;
  try {
    const first = appendCaEntryLine(line, file);
    assert.equal(first.ok, true);
    const raw = fs.readFileSync(file, "utf8");
    assert.match(raw, /# === FORMAT \(dikelola bot\) ===/);
    assert.match(raw, /KEEPME,1x,,spot\n/);
    assert.match(raw, new RegExp(`${line}\\n$`));
    assert.equal(
      parsePoolList(raw).some((row) => row.pool === MINT && row.mode === "spot" && row.ca),
      true
    );
    assert.equal(appendCaEntryLine(line, file).duplicate, true);
    assert.equal(commentPoolInList(MINT, null, file), true);
    const commented = fs.readFileSync(file, "utf8");
    assert.match(commented, new RegExp(`#${line}`));
    assert.equal(
      parsePoolList(commented).some((row) => row.pool === MINT),
      false
    );
    assert.equal(appendCaEntryLine(`${MINT},,,bidask:double,ca`, file).ok, true);
    assert.match(fs.readFileSync(file, "utf8"), /KEEPME,1x,,spot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("log dan state antrean tahan restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entrybot-log-"));
  const file = path.join(dir, "a.log");
  fs.writeFileSync(file, "lama\n");
  const first = takeNewLogLines([file], {});
  assert.deepEqual(first.lines, []);
  fs.appendFileSync(file, "setengah");
  const mid = takeNewLogLines([file], first.cursors);
  assert.deepEqual(mid.lines, []);
  fs.appendFileSync(file, " selesai\nbaru\n");
  const rest = takeNewLogLines([file], mid.cursors);
  assert.deepEqual(rest.lines, ["setengah selesai", "baru"]);

  const actions = takeNewActions([{ at: 10, text: "ENTRY lama" }], null, 20);
  assert.deepEqual(actions.lines, []);
  const next = takeNewActions(
    [
      { at: 10, text: "ENTRY lama" },
      { at: 30, text: "ENTRY baru" },
    ],
    actions.cursor,
    40
  );
  assert.deepEqual(next.lines, ["ENTRY baru"]);

  const stateFile = path.join(dir, "entrybot.json");
  saveEntrybotState(
    { ...emptyEntrybotState(), offset: 9, items: [{ id: "q", status: "watching", mint: MINT }] },
    stateFile
  );
  const loaded = loadEntrybotState(stateFile);
  assert.equal(loaded.offset, 9);
  assert.equal(loaded.items[0].mint, MINT);
  assert.equal(loaded.session.step, "idle");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("api telegram memakai token dan update message + callback", async () => {
  const calls = [];
  const api = createTelegramApi({
    token: "TOKEN",
    request: async (base, method, payload) => {
      calls.push({ base, method, payload });
      return { ok: true, result: [] };
    },
  });
  await api.getUpdates({ offset: 3, timeoutSec: 1 });
  await api.sendMessage("42", "halo", { inline_keyboard: [] });
  assert.match(calls[0].base, /botTOKEN$/);
  assert.match(calls[0].method, /message/);
  assert.match(calls[0].method, /callback_query/);
  assert.equal(calls[1].payload.chat_id, "42");
  assert.equal(calls[1].payload.text, "halo");
});

test("worker idle bila token atau chat kosong, dan mengabaikan chat lain", async () => {
  const errors = [];
  const quiet = { error: (msg) => errors.push(msg), info() {}, warn() {} };
  const idle = await runEntrybot({ token: "", chatId: "42", once: true, log: quiet });
  assert.equal(idle.idle, true);
  assert.match(errors[0], /ENTRYBOT_TELEGRAM_TOKEN kosong/);

  errors.length = 0;
  const noChat = await runEntrybot({ token: "t", chatId: "", once: true, log: quiet });
  assert.equal(noChat.idle, true);
  assert.match(errors[0], /Chat id kosong/);

  const sent = [];
  let saved = null;
  const res = await runEntrybot({
    token: "t",
    chatId: "42",
    once: true,
    log: quiet,
    loadState: () => emptyEntrybotState(),
    saveState: (state) => {
      saved = state;
    },
    getUpdates: async () => ({
      ok: true,
      result: [
        { update_id: 5, message: { chat: { id: 7 }, text: "/entry" } },
        { update_id: 6, message: { chat: { id: 42 }, text: "/entry" } },
      ],
    }),
    sendMessage: async (text, keyboard) => {
      sent.push({ text, keyboard });
      return { ok: true };
    },
    answerCallback: async () => ({ ok: true }),
    readPoolText: () => "",
    readPositions: () => ({}),
    readActions: () => [],
    readNewLogs: (cursors) => ({ lines: [], cursors }),
    quoteMint: async () => ({ pools: [] }),
    appendLine: async () => ({ ok: true }),
    commentAddress: () => true,
  });
  assert.equal(res.offset, 7);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Pilih strategi/);
  assert.equal(saved.offset, 7);
  assert.equal(saved.session.step, "strategy");
});
