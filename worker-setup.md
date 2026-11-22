# Optional worker and Telegram buttons

This guide is for beginners. Follow the numbers from the top. Type the commands on the VPS (the computer that stays on), in the bot folder (`~/meteorabot-v3`), unless a step says to type them somewhere else.

The main bot, the one that opens and closes positions, must already be running. If it is not, finish [setup.md](setup.md) first, including `DRY_RUN=true` so you can practice.

What this page covers:

1. **The queue bot** (`meteorabot-entrybot`) is optional. It only adds a line to the watch list. Opening a position is left to the main bot.
2. **Buttons on the status message** belong to the main bot. Their process (`meteorabot-telegram`) was already started in [setup.md](setup.md). The end of this page explains how to press those buttons.

This page leaves out other repos that fill the list from outside.

## Why the two bots have to be separate

Telegram lets only **one** program "listen" to each bot. That program uses a call named `getUpdates`.

The notification bot (`TELEGRAM_BOT_TOKEN`) is already listened to by `meteorabot-telegram`, so button taps get through. If the queue bot uses that same token, Telegram rejects one of the two programs. The button-process log then shows:

```text
Telegram getUpdates failed: 409
```

and the text `Conflict`. After that, `/entry` gets no reply. Create a second bot in @BotFather, and put its token in `ENTRYBOT_TELEGRAM_TOKEN`.

## 1. Create a bot in Telegram

1. Open Telegram. Search for `@BotFather` and open that official chat.
2. Send:

   ```text
   /newbot
   ```

3. BotFather asks for a **name**. This is the name people see, and it may contain spaces. An example of your reply: `Meteora Queue`.
4. BotFather then asks for a **username**. It must end in `bot`, with no spaces. Example: `meteora_queue_bot`. If that username is already taken, BotFather asks for another one.
5. BotFather replies with a token. It looks roughly like `123456789:AAH...`. Copy the whole token.
6. Save that token only for the `.env` step below. Leave it out of git, out of chat, and out of messages to other people.

Leave the notification token that is already in `TELEGRAM_BOT_TOKEN` on that line. The queue bot gets the new token.

## 2. Get the chat id

The bot replies to only one chat. Messages from any other chat are ignored, and the bot stays silent.

### Way A — the same chat as the notifications

If the same person presses the status buttons and sends `/entry`, you can skip a new chat id. Leave `ENTRYBOT_TELEGRAM_CHAT_ID` empty. The queue bot then uses `TELEGRAM_CHAT_ID`.

You still open the **new** bot's chat and press Start, so Telegram allows that bot to message you.

### Way B — read the id from Telegram

Do this **before** you start the queue process, and use the **new** bot's token.

1. In Telegram, open the new bot. Press **Start**, or send `hi`.
2. In a browser, open this address. Replace `<TOKEN>` with the new bot's token. Leave out spaces and quote marks:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

3. The right page is JSON and contains `"ok":true`. Look for a piece like this:

   ```text
   "chat":{"id":123456789
   ```

   The number `123456789` is the chat id. A group chat is usually a negative number, for example `-1001234567890`. Copy the digits exactly, including the minus sign when there is one.

If the page says `"ok":true,"result":[]`, your message has not arrived yet, or another program already collected it. Send `hi` again, then reload the page.

If the page says `409` or `Conflict`, some program is already listening to this token. Stop that process first (`pm2 stop meteorabot-entrybot` when that is the process), send `hi` again, then open the page again.

## 3. Write the token into `.env`

1. Go to the bot folder:

   ```bash
   cd ~/meteorabot-v3
   ```

2. Open the secrets file:

   ```bash
   nano .env
   ```

3. Find these two lines (use the down arrow in nano):

   ```text
   ENTRYBOT_TELEGRAM_TOKEN=
   ENTRYBOT_TELEGRAM_CHAT_ID=
   ```

4. Paste the token to the right of `=` on the first line. Add no spaces and no quote marks.
5. For Way A, leave `ENTRYBOT_TELEGRAM_CHAT_ID` empty. For Way B, write the number to the right of `=`.
6. Save: press `Ctrl+O`, then Enter.
7. Leave: press `Ctrl+X`.

Here is the shape of those lines. The value below is a made-up sample. The letters `contohBukanTokenSungguhan` are Indonesian for "example of a made-up token". Replace the sample with the token BotFather gave you:

```text
ENTRYBOT_TELEGRAM_TOKEN=123456789:AAHcontohBukanTokenSungguhan
ENTRYBOT_TELEGRAM_CHAT_ID=
```

## 4. Start the process

`meteorabot-entry` must already be `online` (check with `pm2 status`). That process is the one that later opens positions. The queue bot only writes a line.

```bash
cd ~/meteorabot-v3
pm2 start ecosystem.config.cjs --only meteorabot-entrybot
pm2 save
pm2 status
```

In `pm2 status`, the `meteorabot-entrybot` row must say `online`. `pm2 save` stores this list so it comes back after a reboot, together with the `pm2 startup` command you already ran during setup.

## 5. Check that the log looks right

```bash
pm2 logs meteorabot-entrybot --lines 30
```

What you should see:

```text
Meteora Worker: ENTRY BOT
Antre entry lewat Telegram | chat <angka chat Anda>
Tidak membuka posisi. Hanya menulis baris pool.txt.
```

Those lines mean "Meteora Worker: ENTRY BOT", "Queue an entry through Telegram | chat <your chat number>", and "Does not open a position. Only writes a pool.txt line." The placeholder `<angka chat Anda>` is where your chat number appears.

`Ctrl+C` only closes the log view. The bot keeps running.

The same text is copied to `logs/entrybot-out.log`. Errors, when there are any, go to `logs/entrybot-error.log`.

If the token is empty, the process stays `online` and simply does not listen. The log says:

```text
ENTRYBOT_TELEGRAM_TOKEN kosong — entry bot idle, tidak mem-poll Telegram.
```

That line means: ENTRYBOT_TELEGRAM_TOKEN is empty — the entry bot is idle and is not asking Telegram for updates.

If the token is set, but the chat id is empty and `TELEGRAM_CHAT_ID` is empty too:

```text
Chat id kosong — isi TELEGRAM_CHAT_ID atau ENTRYBOT_TELEGRAM_CHAT_ID. Entry bot idle.
```

That line means: the chat id is empty — fill in TELEGRAM_CHAT_ID or ENTRYBOT_TELEGRAM_CHAT_ID. The entry bot is idle.

## 6. Use `/entry`

Open the chat with the **queue** bot (the new bot). Use the account whose chat id is allowed. Type:

```text
/entry
```

The reply you want:

```text
🎯 Entry baru / Pilih strategi:
```

That line means "New entry / Choose a strategy:". The buttons are `Bidask SOL`, `Bidask Double`, `Spot`, and `❌ Batal` (Cancel).

Then send the **token address** (also called a mint or CA). It is about 32–44 characters long. An address the bot cannot accept gets this reply:

```text
CA-nya nggak valid. Kirim mint Solana (base58, kira-kira 32–44 karakter).
```

That means: that CA is not valid. Send a Solana mint (base58, about 32–44 characters).

A session left alone for about 10 minutes expires. The bot replies `Sesi entry sudah kedaluwarsa. Ketik /entry lagi.` (This entry session has expired. Type /entry again.) Type `/entry` to start from the top.

This step only writes one line into `pool.txt`. `meteorabot-entry` is the process that acts on it.

### Bidask SOL

1. Press `Bidask SOL`. The small popup says `Bidask SOL`. The message says `Bidask SOL dipilih. Kirim CA token:` (Bidask SOL selected. Send the token CA:)
2. Send the CA. The bot shows a short name, the current price in SOL and in USD, then `Masuk sekarang, atau pakai harga target?` (Enter now, or use a target price?)
3. Choose one:
   - `⚡ Entry sekarang` (Enter now) enters as soon as the price can be read. The price at that moment is not stored as a target.
   - `🎯 Harga target` (Target price) makes the bot ask for a number. Examples it accepts: `0.0000379sol` or `0.009usd`. A number with no ending is treated as USD. A wrong reply starts with `Harga harus lebih dari 0...` (The price must be more than 0...) or `Satuan nggak dikenal...` (The unit is not recognized...)
4. The bot asks for the range with `Pilih rentang posisi:` (Choose the position range:). The buttons come from `BIDASK_SOL_ENTRY_PRESETS`. The defaults are `Preset 1: -50% / +15%`, `Preset 2: -30% / +15%`, and `Preset 3: -20% / +15%`. The left number is how far below the price. The right number is how far above. A SOL-only position still places SOL only up to the current price. The bins above that stay empty.
5. Next is `Pilih ukuran entry:` (Choose the entry size:)
   - `Default (strat.conf: 0.1 SOL)` uses `ENTRY_DEFAULT_SIZE_SOL` and leaves the size column empty.
   - `0.5 SOL`, `1 SOL`, and `2 SOL` come from `ENTRYBOT_SIZE_OPTIONS`.
6. You then see `📋 Konfirmasi entry` (Confirm entry), with the strategy, token, size, price, trigger, range, and a candidate pool. Press `✅ Konfirmasi` (Confirm).

The success reply looks like this:

```text
⏳ Masuk antrean, dipantau.
Size     : ...
Rentang  : ...
```

That means "Added to the queue. It is being watched." `Size` is the amount. `Rentang` means the range.

Under that text is one line, for example:

```text
CA,,,bidask:sol,ca,now,-50/15
```

or, if you chose a price and a size of 0.5:

```text
CA,0.5,,bidask:sol,ca,0.0000379sol,-30/15
```

The popup says `Masuk antrean` (Added to the queue). There is a button `🗑 Hapus antrean` (Remove from the queue).

The trigger line in the summary uses these exact words:

- `entry sekarang (harga pasar)` (enter now, at the market price) when you chose Enter now
- `tunggu harga naik sampai target` (wait for the price to rise to the target) when the current price is below the target
- `tunggu harga turun sampai target` (wait for the price to fall to the target) when the current price is above the target

### Bidask Double

1. Press `Bidask Double`, then send the CA.
2. The bot asks `Langsung pantau Supertrend, atau pakai harga target?` (Watch Supertrend right away, or use a target price?)
   - `📈 Langsung pantau Supertrend` (Watch Supertrend right away) sets no target price. You go on to the size step.
   - `🎯 Harga target` (Target price) asks for a price the same way as Bidask SOL. The word `now` is refused with `Bidask Double tidak pakai now.` (Bidask Double does not use now.)
3. Choose a size, the same way as above. There is no range step.
4. Confirm.

The line that gets written:

```text
CA,,,bidask:double,ca
```

or, with a target and the Default size:

```text
CA,,,bidask:double,ca,0.0000379sol
```

or, with a fixed size:

```text
CA,0.5,,bidask:double,ca
```

In the summary, the trigger is `tunggu sinyal Supertrend` (wait for the Supertrend signal), or `tunggu harga naik/turun sampai target, lalu tunggu sinyal Supertrend` (wait for the price to rise or fall to the target, then wait for the Supertrend signal). A target price only unlocks the signal. The Supertrend signal, an uptrend, is still what opens the position.

### Spot

1. Press `Spot`, send the CA, choose a size, and confirm. There is no price step and no range step.
2. The line is `CA,,,spot,ca` for the Default size, or `CA,0.5,,spot,ca` if you chose 0.5 SOL.

The summary writes the trigger `entry langsung` (enter right away). That means this style has no target price. The entry worker still waits for the Supertrend signal before it opens the position.

## 7. `/antrean` and `/batal`

Type `/antrean`. The command name means "queue".

- An empty list replies `Antrean kosong. Ketik /entry buat nambah.` (The queue is empty. Type /entry to add one.)
- When there are lines, the title is `📋 Antrean` (Queue). Each line shows the strategy, the name, and either `dari entrybot` (from the entry bot) or `manual`. At most 20 lines are shown. Each line has a button `🗑 Hapus ...` (Remove ...).
- Removing a line puts `#` on it. The line stays in the file, with that mark. The reply is `Oke, barisnya di-#.` (OK, the line was marked with #.) The popup says `Dihapus` (Removed).

Type `/batal` (cancel) to cancel a wizard that is in progress. The reply is `Oke, dibatalin.` (OK, cancelled.) If no wizard is open, the reply is `Nggak ada yang lagi diisi.` (Nothing is being filled in right now.) The `❌ Batal` (Cancel) button on a message does the same thing.

A CA that already has an active line is refused at the confirm step: `CA ini sudah ada di antrean (barisnya masih aktif). Cek /antrean.` (This CA is already in the queue. Its line is still active. Check /antrean.)

## 8. What the messages mean after a line joins the queue

The queue bot watches the logs and the open positions. It sends updates to the same chat.

| Message | Meaning |
|---|---|
| `🎯 ... target tersentuh, menunggu Supertrend.` | The Bidask Double price has touched the target. The position is still closed. It is waiting for the uptrend signal. |
| `✅ Entry ... berhasil` | The position is open. The message names the strategy, the position, the pool, the bin step, the size, and, for Bidask SOL, the range. When a transaction exists, a link to it is included. |
| `⚠️ ... belum bisa entry: dry-run, posisi tidak dibuka. Masih nunggu.` | `DRY_RUN` is still on. The line keeps waiting. No transaction was sent. |
| `⚠️ ... belum bisa entry: SOL di wallet kurang. Masih nunggu.` | The wallet does not have enough SOL. The line stays. |
| `⚠️ ... belum bisa entry: sudah ada posisi. Masih nunggu.` | That style's slot on the pool is already taken. |
| `⚠️ ... belum bisa entry: sewa non-refundable. Masih nunggu.` | The pool's rent fee cannot be refunded, so the entry is held. |
| `⚠️ ... belum bisa entry: ... Masih nunggu.` | No pool passed the filters (money in the pool, width, and so on). The text after the colon is copied from the log. |
| `⚠️ ... keluar dari antrean: ...` | The line is no longer active. It was marked with `#`, or it was removed. |
| `⚠️ ... barisnya sudah tidak aktif. Pantauan berhenti.` | The same outcome, with no extra reason attached. |

A "cannot enter yet" warning for the same reason waits about 15 minutes before it is sent again.

A successful Bidask SOL entry, once `DRY_RUN` is off, marks that line with `#`. A successful Spot or Bidask Double entry leaves the line unmarked. Those can enter again later. A Bidask Double line that has a target has to touch that target again.

## 9. The `strat.conf` keys this bot uses

Change these in `strat.conf`. When the same key is also in `.env`, the `strat.conf` value wins. Then restart:

```bash
pm2 restart meteorabot-entrybot meteorabot-entry
```

| Key | Default in the example | What it is for |
|---|---|---|
| `ENTRY_DEFAULT_SIZE_SOL` | `0.1` | The Default button, and any line whose size column is empty. |
| `ENTRYBOT_SIZE_OPTIONS` | `0.5,1,2` | The fixed-size buttons. SOL amounts, separated by commas. A number the bot cannot read is ignored. |
| `BIDASK_SOL_ENTRY_PRESETS` | `-50/15,-30/15,-20/15` | The order of the Bidask SOL range buttons. |
| `BIDASK_SOL_ENTRY_LOWER_PCT` | `-50` | The lower end of the range when a `pool.txt` line leaves column 7 empty. The queue bot itself always writes the preset you pressed. |
| `BIDASK_SOL_ENTRY_UPPER_PCT` | `15` | The upper end of the range for a line with no column 7. |
| `BIDASK_SOL_ENTRY_MIN_TVL_USD` | `20000` | A pool with less money in it than this is passed over for a SOL-only entry. |
| `BIDASK_SOL_ENTRY_MAX_BINS` | `169` | A pool wider than this is skipped. |

The Telegram summary shows a candidate pool using those same filters. The process that opens the position is still `meteorabot-entry`.

## 10. Turning it off

Stop it for now. You can start it again later:

```bash
pm2 stop meteorabot-entrybot
pm2 save
```

Start it again:

```bash
pm2 start meteorabot-entrybot
pm2 save
```

To leave the process running while it stops listening, clear `ENTRYBOT_TELEGRAM_TOKEN` in `.env`, save, then run:

```bash
pm2 restart meteorabot-entrybot
```

The log goes back to the `entry bot idle` line. To remove the process from the pm2 list:

```bash
pm2 delete meteorabot-entrybot
pm2 save
```

Lines already written in `pool.txt` stay there. `meteorabot-entry` keeps reading them.

The wizard's saved progress is in `state/entrybot.json`. Git does not track that file. Deleting it only forgets the current session and which notifications were already sent. Lines in `pool.txt` stay.

## 11. Common problems

| What happens | Why | What to do |
|---|---|---|
| `/entry` gets no reply at all | Only the chat saved in `TELEGRAM_CHAT_ID` or `ENTRYBOT_TELEGRAM_CHAT_ID` gets a reply, and an idle process stays silent | Use the chat that matches `TELEGRAM_CHAT_ID` or `ENTRYBOT_TELEGRAM_CHAT_ID`. Check the log from step 5. |
| The button log says `Telegram getUpdates failed: 409` | The queue token is the same as `TELEGRAM_BOT_TOKEN` | Create a new bot. Put that token in `ENTRYBOT_TELEGRAM_TOKEN`. Restart both processes: `pm2 restart meteorabot-telegram meteorabot-entrybot`. |
| `ENTRYBOT_TELEGRAM_TOKEN kosong` (ENTRYBOT_TELEGRAM_TOKEN is empty) | That line in `.env` is still empty, or the process was not restarted after you filled it in | Fill in the token, then run `pm2 restart meteorabot-entrybot`. |
| `Chat id kosong` (Chat id is empty) | Both chat id lines are empty | Fill in `TELEGRAM_CHAT_ID` or `ENTRYBOT_TELEGRAM_CHAT_ID`, then restart. |
| `Gagal ambil harga` (Could not fetch the price) | The Jupiter price, or the pool list, could not be read | Send the same CA again. Check the Jupiter keys in `.env` and the `meteorabot-entry` log. |
| `Gagal nulis pool.txt` (Could not write pool.txt) | The file cannot be written | Run the bot from the repo folder, and make sure `pool.txt` exists (`cp pool.txt.example pool.txt`). |
| `CA ini sudah ada di antrean` (This CA is already in the queue) | An active line for that CA is already there | Open `/antrean` and remove the old line, or leave it. |
| A notice says `dry-run, posisi tidak dibuka` (dry-run, the position was not opened) | Practice mode is still on | This is expected while `DRY_RUN=true`. Switch to live only after you choose to, in [setup.md](setup.md). |
| The line is in `pool.txt`, and there is still no position | `meteorabot-entry` is stopped, or it is still waiting for a signal, a price, or a pool | Check `pm2 status`. For Spot and Bidask Double, wait for the signal. For a target price, wait until the price touches it. |
| After a reboot, the queue bot is gone | `pm2 save` has not been run since you started it | Repeat step 4. |

## Buttons on the status message

This section is about the main bot. The process `meteorabot-telegram` is one of the four main processes in [setup.md](setup.md). It only listens for taps. The entry process and the exit process are the ones that send the status message.

You need all of these:

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are filled in.
- `pm2 status` shows `meteorabot-telegram` as `online`.
- The log contains `Meteora Worker: TELEGRAM BUTTONS` and `Tombol: ON` (Buttons: ON).
- `TELEGRAM_BUTTONS_ENABLED` in `strat.conf` is something other than `false`. The example default is `true`. After you change it, run `pm2 restart meteorabot-entry meteorabot-exit meteorabot-telegram`.

With `false`, the status message is still sent, and it has no buttons.

How to use them, in the notification chat (the first bot):

1. Wait for a Position Status message. Only that message has buttons. An "entry succeeded" alert, and messages like it, have none.
2. `♻️` followed by the token name reshapes that position. The name is the pair's symbol with the `-SOL` ending left off.
3. Press `♻️`. That row's buttons change to `Token`, `SOL`, and `Batal` (Cancel), all on one row.
4. `Token` reshapes the token side. `SOL` reshapes the SOL side. Either choice goes straight into the queue. There is no extra Yes question. The popup says `Rebalance <nama> dijadwalkan` (Rebalance <name> is scheduled). `<nama>` is the token name.
5. `⚡` closes the position (Zap Out). Press it, then press `✅ Ya, zap out <nama>` (Yes, zap out <name>) to go ahead, or `✖️ Batal` (Cancel). The scheduled popup says `Zap Out <nama> dijadwalkan` (Zap Out <name> is scheduled).
6. A token-only position shows only `⚡`. It has no `♻️` button.
7. A name longer than 10 characters is shown as one button per line, so the name is not cut off.

`meteorabot-exit` works through that queue on its next cycle. A tap only changes the buttons on the same message. The tap itself sends no new message.

If the side you chose has nothing that can be reshaped, the reply is `Tidak ada yang bisa di-rebalance di sisi itu` (There is nothing to rebalance on that side). A command older than 10 minutes, or for a position that no longer exists, is left undone.

Zap Out closes the position the same way a manual close does, swaps leftover tokens into SOL, and stops the automatic re-open that usually follows when the price leaves the top of the range.
