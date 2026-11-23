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
const { default: config } = await import("../src/config/index.js");

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
  assert.equal(parseTargetPrice("now").entryNow, true);
  assert.equal(parseTargetPrice("NOW").token, "now");
  assert.equal(
    formatEntryLine({ strategy: "bidask:sol", mint: MINT, targetToken: "now" }),
    `${MINT},,,bidask:sol,ca,now`
  );
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
  assert.equal(
    triggerPhrase("bidask:double", 0.00002, 0.0000379),
    "tunggu harga naik sampai target, lalu tunggu sinyal Supertrend"
  );
  assert.equal(
    triggerPhrase("bidask:double", 0.001, 0.0000379),
    "tunggu harga turun sampai target, lalu tunggu sinyal Supertrend"
  );
  assert.equal(
    triggerPhrase("bidask:double", Number.NaN, 0.01),
    "tunggu harga naik/turun sampai target, lalu tunggu sinyal Supertrend"
  );
  assert.equal(triggerPhrase("bidask:double", 0.009, 0.009), "tunggu sinyal Supertrend");
  assert.equal(triggerPhrase("spot"), "entry langsung");
  assert.equal(formatEntryLine({ strategy: "spot", mint: MINT, sizeToken: "0.5" }), `${MINT},0.5,,spot,ca`);
  assert.equal(
    formatEntryLine({ strategy: "bidask:double", mint: MINT, sizeToken: "2", targetToken: "0.0000379sol" }),
    `${MINT},2,,bidask:double,ca,0.0000379sol`
  );
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
  assert.match(res.replies[0].text, /Harga sekarang: 0\.00002 SOL · \$0\.004/);
  assert.equal(state.session.step, "solChoice");
  const choice = res.replies[0].keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(choice, ["⚡ Entry sekarang", "🎯 Harga target", "❌ Batal"]);

  res = await turn(state, { type: "text", text: "0.01" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /Pakai tombolnya ya/);
  assert.equal(state.session.step, "solChoice");

  res = await turn(state, { type: "callback", data: "eb:px" }, box);
  state = res.state;
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
  assert.match(res.replies[0].text, /Pilih rentang posisi:/);
  assert.equal(state.session.step, "range");
  const presets = res.replies[0].keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(presets, ["Preset 1: -50% / +15%", "Preset 2: -30% / +15%", "Preset 3: -20% / +15%", "❌ Batal"]);

  res = await turn(state, { type: "callback", data: "eb:rg:1" }, box);
  state = res.state;
  assert.equal(state.session.step, "size");
  assert.match(res.replies[0].text, /Pilih ukuran entry/);
  assert.deepEqual(
    res.replies[0].keyboard.inline_keyboard.flat().map((button) => button.text),
    ["Default (strat.conf: 0.1 SOL)", "0.5 SOL", "1 SOL", "2 SOL", "❌ Batal"]
  );

  res = await turn(state, { type: "callback", data: "eb:sz:d" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /📋 Konfirmasi entry/);
  assert.match(res.replies[0].text, /0\.1 SOL \(default\)/);
  assert.match(res.replies[0].text, /tunggu harga naik sampai target/);
  assert.match(res.replies[0].text, /Rentang {2}: -30% \/ \+15%/);
  assert.match(res.replies[0].text, /bin step 100/);
  assert.match(res.replies[0].text, /52 bin/);
  assert.match(res.replies[0].text, /TVL \$50,000/);
  assert.match(res.replies[0].text, /Pool calon/);

  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.equal(box.lines[0], `${MINT},,,bidask:sol,ca,0.0000379sol,-30/15`);
  assert.match(res.replies[0].text, /Rentang {2}: -30% \/ \+15%/);
  assert.match(res.replies[0].text, /⏳ Masuk antrean, dipantau/);
  assert.equal(state.items[0].status, "watching");
  assert.equal(state.session.step, "idle");

  res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:st:sol" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:px" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: "0.01" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:rg:0" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:sz:d" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /sudah ada di antrean/);
  assert.equal(box.lines.length, 1);
});

test("entry sekarang menulis now dan ringkasannya harga pasar", async () => {
  const box = harness();
  let state = emptyEntrybotState();
  let res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:st:sol" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:now" }, box);
  state = res.state;
  assert.equal(state.session.step, "range");
  assert.equal(state.session.entryNow, true);
  assert.match(res.replies[0].text, /Pilih rentang posisi:/);

  res = await turn(state, { type: "text", text: "halo" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /Pakai tombolnya ya/);

  res = await turn(state, { type: "callback", data: "eb:rg:2" }, box);
  state = res.state;
  assert.equal(state.session.step, "size");
  res = await turn(state, { type: "callback", data: "eb:sz:d" }, box);
  state = res.state;
  assert.equal(state.session.step, "confirm");
  assert.match(res.replies[0].text, /📋 Konfirmasi entry/);
  assert.match(res.replies[0].text, /Pemicu {3}: entry sekarang \(harga pasar\)/);
  assert.match(res.replies[0].text, /Rentang {2}: -20% \/ \+15%/);
  assert.match(res.replies[0].text, /39 bin/);
  assert.doesNotMatch(res.replies[0].text, /Target/);
  assert.equal(res.replies[0].keyboard.inline_keyboard[0][0].text, "✅ Konfirmasi");

  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.equal(box.lines[0], `${MINT},,,bidask:sol,ca,now,-20/15`);
  assert.equal(state.items[0].lowerPct, -20);
  assert.equal(state.items[0].upperPct, 15);
  assert.equal(state.items[0].status, "watching");
  assert.equal(state.items[0].targetRaw, "now");
  assert.equal(parsePoolList(box.lines[0])[0].entryNow, true);
  assert.equal(parsePoolList(box.lines[0])[0].entryPrice, null);
  assert.equal(parsePoolList(box.lines[0])[0].lowerPct, -20);
  assert.equal(parsePoolList(box.lines[0])[0].upperPct, 15);
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
  assert.equal(state.session.step, "size");
  assert.doesNotMatch(res.replies[0].text, /Kirim harga target/);
  res = await turn(state, { type: "callback", data: "eb:sz:d" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /entry langsung/);
  assert.match(res.replies[0].text, /dihitung saat entry/);
  assert.match(res.replies[0].text, /0\.1 SOL \(default\)/);
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

test("bidask double: supertrend langsung, harga target, lalu ukuran", async () => {
  const box = harness();
  let state = emptyEntrybotState();
  let res = await turn(state, { type: "callback", data: "eb:st:dbl" }, box);
  state = res.state;
  res = await turn(state, { type: "text", text: MINT }, box);
  state = res.state;
  assert.equal(state.session.step, "doubleChoice");
  assert.deepEqual(
    res.replies[0].keyboard.inline_keyboard.flat().map((button) => button.text),
    ["📈 Langsung pantau Supertrend", "🎯 Harga target", "❌ Batal"]
  );

  res = await turn(state, { type: "callback", data: "eb:dir" }, box);
  state = res.state;
  assert.equal(state.session.step, "size");
  res = await turn(state, { type: "callback", data: "eb:sz:1" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /tunggu sinyal Supertrend/);
  assert.match(res.replies[0].text, /Bidask Double/);
  assert.match(res.replies[0].text, /Size {5}: 1 SOL/);
  assert.doesNotMatch(res.replies[0].text, /lalu tunggu sinyal Supertrend/);
  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.equal(box.lines[0], `${MINT},1,,bidask:double,ca`);
  assert.equal(state.items[0].sizeSol, 1);
  assert.match(res.replies[0].text, /Size {5}: 1 SOL/);

  res = await turn(state, { type: "text", text: "/entry" }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:st:dbl" }, box);
  state = res.state;
  const other = "So11111111111111111111111111111111111111112";
  res = await turn(state, { type: "text", text: other }, box);
  state = res.state;
  res = await turn(state, { type: "callback", data: "eb:px" }, box);
  state = res.state;
  assert.equal(state.session.step, "price");
  res = await turn(state, { type: "text", text: "now" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /tidak pakai now/);
  res = await turn(state, { type: "text", text: "0.00001sol" }, box);
  state = res.state;
  assert.equal(state.session.step, "size");
  res = await turn(state, { type: "callback", data: "eb:sz:d" }, box);
  state = res.state;
  assert.match(res.replies[0].text, /tunggu harga turun sampai target, lalu tunggu sinyal Supertrend/);
  assert.match(res.replies[0].text, /0\.1 SOL \(default\)/);
  res = await turn(state, { type: "callback", data: "eb:ok" }, box);
  state = res.state;
  assert.equal(box.lines[1], `${other},,,bidask:double,ca,0.00001sol`);
  assert.equal(parsePoolList(box.lines[1])[0].entryPriceUnit, "sol");
  assert.equal(parsePoolList(box.lines[1])[0].entryPrice, 0.00001);
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

  const openLog = `SPOT position opened: ${POS} (tx: ${TX}) | bins [1..2] step 80`;
  const opened = findOpenedPosition(
    item,
    {
      a: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt + 1000, position: POS, pool: POOL },
      old: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt - 60_000, position: "old" },
    },
    [openLog]
  );
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

test("tombol ukuran mengikuti ENTRYBOT_SIZE_OPTIONS", async () => {
  const saved = config.entry.entrybotSizeOptions;
  config.entry.entrybotSizeOptions = [0.25, 3];
  try {
    const box = harness();
    let state = emptyEntrybotState();
    let res = await turn(state, { type: "text", text: "/entry" }, box);
    state = res.state;
    res = await turn(state, { type: "callback", data: "eb:st:spt" }, box);
    state = res.state;
    res = await turn(state, { type: "text", text: MINT }, box);
    state = res.state;
    assert.deepEqual(
      res.replies[0].keyboard.inline_keyboard.flat().map((button) => button.text),
      ["Default (strat.conf: 0.1 SOL)", "0.25 SOL", "3 SOL", "❌ Batal"]
    );
    res = await turn(state, { type: "callback", data: "eb:sz:0.25" }, box);
    state = res.state;
    assert.match(res.replies[0].text, /Size {5}: 0\.25 SOL/);
    assert.doesNotMatch(res.replies[0].text, /\(default\)/);
    res = await turn(state, { type: "callback", data: "eb:ok" }, box);
    assert.equal(box.lines[0], `${MINT},0.25,,spot,ca`);
    assert.equal(res.state.items[0].sizeSol, 0.25);
    assert.equal(res.state.items[0].sizeIsDefault, false);
  } finally {
    config.entry.entrybotSizeOptions = saved;
  }
});

test("entrybot memberitahu saat target bidask double tersentuh", () => {
  const queuedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const item = {
    id: "qarm",
    mint: MINT,
    symbol: "BONK",
    strategy: "bidask:double",
    status: "watching",
    queuedAt,
    skips: {},
    sizeSol: 0.5,
  };
  const poolText = `${MINT},0.5,,bidask:double,ca,0.0000379sol\n`;
  const arm = `[2026-01-01T00:00:03.000Z] [INFO] CA ${MINT} bidask:double target tersentuh, menunggu Supertrend (${MINT})`;
  const once = reviewQueue([item], { poolText, positions: {}, logLines: [arm] }, queuedAt + 5000);
  assert.match(once.notes[0].text, /🎯 BONK target tersentuh, menunggu Supertrend/);
  assert.equal(once.items[0].status, "watching");
  assert.equal(once.items[0].armedAt, queuedAt + 5000);
  const again = reviewQueue(once.items, { poolText, positions: {}, logLines: [arm] }, queuedAt + 8000);
  assert.equal(again.notes.length, 0);
});

test("pantauan baris now: peringatan skip dan entry berhasil", () => {
  const queuedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const item = {
    id: "qnow",
    mint: MINT,
    symbol: "BONK",
    strategy: "bidask:sol",
    line: `${MINT},,,bidask:sol,ca,now`,
    sizeSol: 0.1,
    status: "watching",
    queuedAt,
    skips: {},
    targetRaw: "now",
  };
  const poolText = `${MINT},,,bidask:sol,ca,now\n`;
  const skipLine = `[2026-01-01T00:00:02.000Z] [INFO] CA ${MINT.slice(0, 8)} bidask:sol menunggu: tidak ada pool (harga $0.004 (entry sekarang)) — baris tidak dimatikan`;
  const once = reviewQueue([item], { poolText, positions: {}, logLines: [skipLine] }, queuedAt + 5000);
  assert.match(once.notes[0].text, /⚠️ BONK belum bisa entry: tidak ada pool\. Masih nunggu\./);
  assert.equal(once.items[0].status, "watching");

  const done = reviewQueue(
    [item],
    {
      poolText: "",
      positions: {
        a: {
          baseMint: MINT,
          mode: "bidask:sol",
          closed: false,
          firstSeenAt: queuedAt + 1000,
          position: POS,
          pool: POOL,
          entrySizeSol: 0.1,
        },
      },
      logLines: [`bidask:sol position opened: ${POS} (tx: ${TX}) | bins [1..2] step 80`],
    },
    queuedAt + 2000
  );
  assert.match(done.notes[0].text, /✅ Entry BONK berhasil/);
  assert.match(done.notes[0].text, /Rentang {2}: -50% \/ \+15%/);
  assert.match(done.notes[0].text, new RegExp(`https://solscan.io/tx/${TX}`));
  assert.equal(done.items[0].status, "entered");

  const custom = reviewQueue(
    [{ ...item, id: "qrange", lowerPct: -30, upperPct: 15 }],
    {
      poolText: "",
      positions: {
        a: {
          baseMint: MINT,
          mode: "bidask:sol",
          closed: false,
          firstSeenAt: queuedAt + 1000,
          position: POS,
          pool: POOL,
          entrySizeSol: 0.1,
          entryLowerPct: -50,
          entryUpperPct: 15,
        },
      },
      logLines: [`bidask:sol position opened: ${POS} (tx: ${TX}) | bins [1..2] step 80`],
    },
    queuedAt + 2000
  );
  assert.match(custom.notes[0].text, /Rentang {2}: -30% \/ \+15%/);
});

test("classify skip tidak menganggap log bin step sukses sebagai gagal", () => {
  assert.equal(classifyEntrySkip(`CA ${MINT.slice(0, 8)} → pool ${POOL.slice(0, 8)} (bin step 100, TVL 50000)`), null);
  assert.equal(classifyEntrySkip("[DRY RUN] Would enter bidask:sol CA 7EJqZHD4").code, "dry_run");
  assert.equal(classifyEntrySkip("REDFLAG non-refundable rent").code, "non_refundable");
  assert.equal(classifyEntrySkip("posisi sudah ada di pool").code, "duplicate");
  const same = classifyEntrySkip(
    `${MINT} skip: token sudah punya posisi aktif dengan strategi yang sama (log berikutnya ≥10 menit lagi)`
  );
  assert.equal(same.code, "same_strategy");
  assert.equal(same.label, "token sudah punya posisi aktif");
});

test("posisi luar tidak dihitung entry berhasil; log position opened tetap bukti", () => {
  const queuedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const item = {
    id: "qext",
    mint: MINT,
    symbol: "BONK",
    strategy: "spot",
    status: "watching",
    queuedAt,
    skips: {},
  };
  const poolText = `${MINT},,,spot,ca\n`;
  const external = {
    baseMint: MINT,
    mode: "spot",
    closed: false,
    firstSeenAt: queuedAt + 1000,
    position: POS,
    pool: POOL,
    source: "adopted",
    openedAt: null,
    entrySizeSol: null,
  };
  assert.equal(findOpenedPosition(item, { a: external }, [`📌 ENTRY posisi ${POS} terdeteksi di on-chain`]), null);
  assert.equal(
    findOpenedPosition(item, {
      a: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt + 1000, position: POS, pool: POOL },
    }),
    null
  );
  const proved = findOpenedPosition(item, {
    a: { ...external, source: "entry", openedAt: queuedAt + 500 },
  });
  assert.equal(proved.position, POS);
  const viaLog = findOpenedPosition(
    item,
    { a: { baseMint: MINT, mode: "spot", closed: false, firstSeenAt: queuedAt + 1000, position: POS, pool: POOL } },
    [`SPOT position opened: ${POS} (tx: ${TX})`]
  );
  assert.equal(viaLog.position, POS);

  const watching = reviewQueue(
    [item],
    {
      poolText,
      positions: { a: external },
      logLines: [`📌 ENTRY BONK — posisi spot aktif terdeteksi di on-chain`],
    },
    queuedAt + 2000
  );
  assert.equal(watching.items[0].status, "watching");
  assert.equal(watching.notes.length, 0);
});

test("skip strategi sama diberitahu sekali, lalu ditahan", () => {
  const queuedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const item = {
    id: "qsame",
    mint: MINT,
    symbol: "BONK",
    strategy: "spot",
    status: "watching",
    queuedAt,
    skips: {},
  };
  const poolText = `${MINT},,,spot,ca\n`;
  const line = `[2026-01-01T00:00:02.000Z] [INFO] CA ${MINT} skip: token sudah punya posisi aktif dengan strategi yang sama (log berikutnya ≥10 menit lagi)`;
  const once = reviewQueue([item], { poolText, positions: {}, logLines: [line] }, queuedAt + 5000);
  assert.match(once.notes[0].text, /belum bisa entry: token sudah punya posisi aktif/);
  assert.equal(once.notes[0].code, "same_strategy");
  assert.equal(once.items[0].status, "watching");
  const again = reviewQueue(once.items, { poolText, positions: {}, logLines: [line] }, queuedAt + 6000);
  assert.equal(again.notes.length, 0);
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
