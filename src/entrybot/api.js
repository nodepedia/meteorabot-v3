import https from "https";

function defaultRequest(base, method, payload, timeout = 15000) {
  const body = payload == null ? null : JSON.stringify(payload);
  const url = new URL(`${base}/${String(method).replace(/^\//, "")}`);
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
        family: 4,
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (body) req.write(body);
    req.end();
  });
}

export function createTelegramApi({ token, request = defaultRequest } = {}) {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    getUpdates({ offset, timeoutSec = 30 } = {}) {
      const qs = new URLSearchParams();
      if (offset != null) qs.set("offset", String(offset));
      qs.set("timeout", String(timeoutSec));
      qs.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
      return request(base, `getUpdates?${qs}`, null, (Number(timeoutSec) + 15) * 1000);
    },
    sendMessage(chatId, text, replyMarkup) {
      const payload = { chat_id: chatId, text: String(text).slice(0, 4096) };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      return request(base, "sendMessage", payload, 15000);
    },
    answerCallback(callbackId, text) {
      if (!callbackId) return Promise.resolve(null);
      const payload = { callback_query_id: callbackId };
      if (text) payload.text = String(text).slice(0, 200);
      return request(base, "answerCallbackQuery", payload, 15000);
    },
  };
}
