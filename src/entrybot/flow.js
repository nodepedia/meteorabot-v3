// Satu langkah wizard / perintah. IO (harga, pool.txt) masuk lewat deps.
import {
  cancelKeyboard,
  confirmKeyboard,
  deleteKeyboard,
  emptySession,
  formatEntryLine,
  formatQueueMessage,
  formatQuoteAsk,
  formatSummary,
  isSolanaMint,
  listActiveLines,
  parseCallbackData,
  parseCommand,
  parseTargetPrice,
  previewEntryPool,
  priceErrorText,
  sameChat,
  sessionExpired,
  strategyKeyboard,
  strategyLabel,
  symbolFromPools,
} from "./logic.js";

function touch(session, now, patch) {
  return { ...session, ...patch, updatedAt: now };
}

function reply(text, keyboard = null, toast = null) {
  return { replies: [{ text, keyboard }], toast };
}

export async function handleEntrybotTurn(state, turn, deps) {
  const now = deps.now?.() ?? Date.now();
  const allowed = deps.allowedChatId;
  if (!sameChat(turn?.chatId, allowed)) return { state, replies: [], toast: null, ignored: true };

  let session = state.session || emptySession(now);
  let items = Array.isArray(state.items) ? state.items : [];
  const expired = sessionExpired(session, now, deps.wizardTtlMs);

  if (turn.type === "callback" && parseCallbackData(turn.data)?.type === "delete") {
    const address = parseCallbackData(turn.data).address;
    return finish(state, session, items, await removeQueued(address, items, deps), now);
  }

  if (expired && session.step !== "idle") {
    session = emptySession(now);
    const command = turn.type === "text" ? parseCommand(turn.text) : null;
    if (command !== "entry") {
      const out = reply("Sesi entry sudah kedaluwarsa. Ketik /entry lagi.", null, "Sesi habis");
      return finish(state, session, items, out, now);
    }
  }

  if (turn.type === "text") {
    const command = parseCommand(turn.text);
    if (command === "batal") {
      const was = session.step !== "idle";
      return finish(
        state,
        emptySession(now),
        items,
        reply(was ? "Oke, dibatalin." : "Nggak ada yang lagi diisi."),
        now
      );
    }
    if (command === "antrean") {
      const text = deps.readPoolText?.() ?? "";
      const listed = formatQueueMessage(listActiveLines(text), items);
      return finish(state, session, items, reply(listed.text, listed.keyboard), now);
    }
    if (command === "entry") {
      return finish(
        state,
        touch(emptySession(now), now, { step: "strategy" }),
        items,
        reply("🎯 Entry baru / Pilih strategi:", strategyKeyboard()),
        now
      );
    }
  }

  if (turn.type === "callback") {
    const parsed = parseCallbackData(turn.data);
    if (!parsed) return finish(state, session, items, reply("Tombolnya nggak dikenal.", null, "Dibatalkan"), now);
    if (parsed.type === "cancel") {
      return finish(state, emptySession(now), items, reply("Oke, dibatalin.", null, "Dibatalkan"), now);
    }
    if (parsed.type === "strategy") {
      const next = touch(emptySession(now), now, { step: "ca", strategy: parsed.strategy });
      return finish(
        state,
        next,
        items,
        reply(
          `${strategyLabel(parsed.strategy)} dipilih. Kirim CA token:`,
          cancelKeyboard(),
          strategyLabel(parsed.strategy)
        ),
        now
      );
    }
    if (parsed.type === "confirm") {
      if (session.step !== "confirm") {
        return finish(state, session, items, reply("Nggak ada yang dikonfirmasi. Ketik /entry.", null, "Batal"), now);
      }
      const line = formatEntryLine({ strategy: session.strategy, mint: session.mint, targetToken: session.targetRaw });
      const written = await deps.appendLine(line);
      if (!written?.ok && written?.duplicate) {
        return finish(
          state,
          emptySession(now),
          items,
          reply("CA ini sudah ada di antrean (barisnya masih aktif). Cek /antrean.", null, "Sudah ada"),
          now
        );
      }
      if (!written?.ok) {
        return finish(
          state,
          session,
          items,
          reply("Gagal nulis pool.txt. Coba lagi ya.", confirmKeyboard(), "Gagal"),
          now
        );
      }
      const item = {
        id: deps.newId?.() || `q${now.toString(36)}`,
        mint: session.mint,
        symbol: session.symbol,
        strategy: session.strategy,
        line,
        sizeSol: deps.defaultSizeSol,
        targetRaw: session.targetRaw || null,
        queuedAt: now,
        status: "watching",
        skips: {},
        fromEntrybot: true,
      };
      return finish(
        state,
        emptySession(now),
        [...items, item],
        reply(`⏳ Masuk antrean, dipantau.\n${line}`, deleteKeyboard(session.mint), "Masuk antrean"),
        now
      );
    }
  }

  if (turn.type === "text" && session.step === "ca") {
    const mint = String(turn.text || "").trim();
    if (!isSolanaMint(mint)) {
      return finish(
        state,
        touch(session, now, {}),
        items,
        reply("CA-nya nggak valid. Kirim mint Solana (base58, kira-kira 32–44 karakter).", cancelKeyboard()),
        now
      );
    }
    let quote;
    try {
      quote = await deps.quoteMint(mint);
    } catch (err) {
      return finish(
        state,
        session,
        items,
        reply(`Gagal ambil harga. Coba kirim CA-nya lagi. (${err.message})`, cancelKeyboard()),
        now
      );
    }
    const pools = quote?.pools || [];
    const symbol = quote?.symbol || symbolFromPools(pools, mint) || null;
    const preview = previewEntryPool(session.strategy, pools, mint, deps.previewOpts || {});
    const next = touch(session, now, {
      mint,
      symbol,
      priceUsd: Number.isFinite(Number(quote?.priceUsd)) ? Number(quote.priceUsd) : null,
      priceSol: Number.isFinite(Number(quote?.priceSol)) ? Number(quote.priceSol) : null,
      preview,
    });
    if (session.strategy === "bidask:sol") {
      return finish(state, { ...next, step: "price" }, items, reply(formatQuoteAsk(next), cancelKeyboard()), now);
    }
    const confirmed = { ...next, step: "confirm" };
    return finish(
      state,
      confirmed,
      items,
      reply(formatSummary(confirmed, deps.defaultSizeSol), confirmKeyboard()),
      now
    );
  }

  if (turn.type === "text" && session.step === "price") {
    const parsed = parseTargetPrice(turn.text);
    if (!parsed.ok) {
      return finish(state, touch(session, now, {}), items, reply(priceErrorText(parsed.reason), cancelKeyboard()), now);
    }
    const next = touch(session, now, {
      step: "confirm",
      targetRaw: parsed.token,
      target: parsed.entryPrice,
      targetUnit: parsed.entryPriceUnit,
    });
    return finish(state, next, items, reply(formatSummary(next, deps.defaultSizeSol), confirmKeyboard()), now);
  }

  if (turn.type === "text" && (session.step === "strategy" || session.step === "confirm")) {
    const hint = session.step === "strategy" ? "Pilih strateginya lewat tombol ya." : "Pakai tombol konfirmasi ya.";
    return finish(state, session, items, reply(hint), now);
  }

  return finish(state, session, items, { replies: [], toast: null }, now);
}

async function removeQueued(address, items, deps) {
  const ok = deps.commentAddress?.(address);
  const removed = (ok instanceof Promise ? await ok : ok) !== false;
  const next = items.map((item) =>
    item.status === "watching" && item.mint === address
      ? { ...item, status: "removed", doneAt: deps.now?.() ?? Date.now() }
      : item
  );
  if (!removed) return reply("Gagal mengubah pool.txt. Coba lagi ya.", null, "Gagal");
  return { replies: [{ text: "Oke, barisnya di-#.", keyboard: null }], toast: "Dihapus", items: next };
}

function finish(state, session, items, out, _now) {
  return {
    state: { ...state, session, items: out.items || items },
    replies: out.replies || [],
    toast: out.toast ?? null,
    ignored: false,
  };
}
