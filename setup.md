# Install meteorabot-v3

This guide installs the main bot on a VPS, a computer that stays on. That bot watches your list, opens and closes positions, watches the wallet, and receives taps on the Telegram buttons.

The optional bot that adds lines through Telegram is in [worker-setup.md](worker-setup.md). A short summary for non-technical readers is in [README.md](README.md). The folder map is in [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

Never put a wallet key, a Telegram token, or an API key in git, in a chat, or in a screenshot.

## What you need

- A Linux VPS (Ubuntu) that stays on, with outbound internet to the Solana network (RPC), Jupiter, GMGN, Meteora, and Telegram.
- A Solana wallet that holds SOL for positions and for network fees.
- An RPC account (Helius or another provider), a GMGN API key (price data for the trend signal), and a Jupiter API key (prices and swaps).
- One Telegram bot for notifications and buttons. A second bot, for adding to the queue, is optional. How to create it is in [worker-setup.md](worker-setup.md).

## 1. Install Node 24, git, and pm2

The bot requires Node.js 24.x. Another version can fail when the program starts.

```bash
sudo apt update && sudo apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
sudo npm install -g pm2
pm2 -v
```

`node -v` must show `v24` at the start, for example `v24.22.3`. If you see `v18`, `v20`, or `v22`, the Node steps above have not replaced the version that is in use.

## 2. Clone the repo and install packages

```bash
git clone https://github.com/nodepedia/meteorabot-v3.git ~/meteorabot-v3
cd ~/meteorabot-v3
npm ci
```

`npm ci` installs the versions locked in `package-lock.json`, then runs `scripts/patch-anchor.js`. That command must finish with no error. If an Anchor or DLMM import error shows up later, run `npm ci` again from this folder.

## 3. Fill in `.env`

`.env` stores the secrets for this machine. Git does not track that file.

```bash
cd ~/meteorabot-v3
cp .env.example .env
chmod 600 .env
nano .env
```

In nano, use the arrow keys to move between lines, and type the value to the right of `=`. Save with `Ctrl+O`, then Enter. Leave with `Ctrl+X`.

Type real values only in `.env` on the VPS. Keep them out of documents and out of chat.

| Variable | Meaning |
|---|---|
| `WALLET_PRIVATE_KEY` | The wallet's secret key. It can be base58 text, or a JSON list of numbers (a byte array). If it is empty, the main processes stop right away. |
| `RPC_URL` | The Solana RPC address (the network connection). If this is filled in, this is the one that is used. |
| `HELIUS_API_KEY` | Used only when `RPC_URL` is empty, to build the address `https://rpc.helius.xyz/?api-key=...`. If both are empty, the bot falls back to the public mainnet RPC. A bot that runs all the time needs its own RPC. |
| `GMGN_API_KEY` | The GMGN key for the candles used by the Supertrend signal. |
| `JUPITER_API_KEY` | A backup key. It is used for prices when `JUPITER_PRICE_API_KEY` is empty, and for swaps when `JUPITER_SWAP_API_KEY` is empty. |
| `JUPITER_PRICE_API_KEY` | A key used only to read prices. |
| `JUPITER_SWAP_API_KEY` | A key used only for swaps. |
| `DRY_RUN` | `true` means practice: no real transactions are sent. `false` means live, with real money. Any value other than `false` (including empty) stays in practice. Leave it as `true` until the logs and the pool list look right. |
| `TELEGRAM_BOT_TOKEN` | The notification bot's token, from @BotFather. The queue bot uses a different token. |
| `TELEGRAM_CHAT_ID` | The chat that receives notifications, and the only chat allowed to press the buttons. |
| `ENTRYBOT_TELEGRAM_TOKEN` | The second Telegram bot's token, for `/entry`. Leave it empty until you follow [worker-setup.md](worker-setup.md). |
| `ENTRYBOT_TELEGRAM_CHAT_ID` | The chat for the queue bot. Leave it empty to use `TELEGRAM_CHAT_ID`. |

Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` before you start the button process. How to get the chat id is explained in [worker-setup.md](worker-setup.md) (the steps are the same: send a message to the bot, then open `getUpdates`).

## 4. Copy `strat.conf`

`strat.conf` holds this machine's strategy settings (size, time limits, reshape, and so on). Git does not track that file. `git pull` does not overwrite it.

```bash
cd ~/meteorabot-v3
cp strat.conf.example strat.conf
```

Do this once, the first time you install. Do not commit `strat.conf`.

Which value wins:

- The same key is in both `strat.conf` and `.env`: the `strat.conf` value is used.
- `strat.conf` does not yet have a key that is in `strat.conf.example`: the bot uses the default number in the code (matched to the example) and writes that key's name **once** when the process starts, in the log: `[strat] Kunci ini tidak ada di strat.conf, memakai default: ...` (These keys are missing from strat.conf, using the defaults: ...)
- There is no `strat.conf` at all: the bot uses `strat.conf.example` and warns: `[strat] strat.conf tidak ditemukan. Memakai strat.conf.example. ...` (strat.conf was not found. Using strat.conf.example. ...)
- A new key shows up in `strat.conf.example` after `git pull`. Copy that key into `strat.conf` only when you want to change the number. Leave the rest of your `strat.conf` as it is, so your own tuning stays in place.

Comments in `strat.conf.example` explain each key. These are the ones people change most often:

| Key | Example | In short |
|---|---|---|
| `ENTRY_DEFAULT_SIZE_SOL` | `0.1` | SOL used for a line that does not write a size. |
| `ENTRY_EXPIRY_HOURS` | `24` | A line that has not entered within this many hours is marked with `#` (when live). |
| `ENTRY_MAX_FAILURES` | `3` | After entry fails this many times, the line is marked with `#`. |
| `POOL_LIST_FILE` | `pool.txt` | The name of the list file. |
| `ENTRY_TIMEFRAME` | `15m` | The candle size for the Supertrend signal. |
| `ENTRY_TOUCH_MODE` | `held_pullback` | How the trend signal is used. `first_touch` means enter when the price touches the line while the trend is up. |
| `SPOT_INDICATOR_EXIT` | `immediate` | Spot closes when the indicator signal fires. `trailing` means follow the rise first. |
| `DCA_TRIGGER_MODE` | `price` | Add to the position (an average-down, buying more after a drop) only for bidask double, based on the price drop. |
| `BIDASK_DOUBLE_MIN_BIN_STEP` | `100` | Bidask double only enters a pool whose bin spacing is at least this. `0` turns the filter off. Spot is unaffected. |
| `BIDASK_SOL_ENTRY_MIN_TVL_USD` | `20000` | The least money a pool must hold (TVL) for a SOL-only entry. |
| `BIDASK_SOL_ENTRY_MAX_BINS` | `169` | The widest a SOL-only position may be, in price steps (bins). |
| `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT` | `-50` / `15` | The default SOL-only range when a line does not write a range column. |
| `BIDASK_SOL_ENTRY_PRESETS` | `-50/15,-30/15,-20/15` | The range buttons in the queue bot. |
| `ENTRYBOT_SIZE_OPTIONS` | `0.5,1,2` | The size buttons in the queue bot, besides Default. |
| `REBALANCE_MODE` | `inplace` | Reshape the position in place. `withdraw` pulls the funds to the wallet, then deposits them again. |
| `BIDASK_DOUBLE_REBALANCE_FIRST_STEP_PCT` / `NEXT_STEP_PCT` | `20` / `5` | Bidask double reshapes its token bins after the pool price falls 20% from that position's own entry, then every further 5% (20, 25, 30, ...). When price recovers by one rung (20 points after the first reshape, then 5), the SOL side is reshaped too. |
| `BIDASK_SOL_REBALANCE_FIRST_STEP_PCT` / `NEXT_STEP_PCT` | `20` / `5` | SOL-only positions use the same rungs, counted as the share of bins above the active bin that have turned into token, not as a price drop. Spot keeps even steps. |
| `TELEGRAM_BUTTONS_ENABLED` | `true` | `false` sends status messages with no buttons. |
| `SWAP_PENDING_RETRY_SEC` | `90` | How many seconds to wait before trying a leftover-token swap again. |

When a position is closed, the bot swaps leftover tokens (including rewards) into SOL. A token that is being protected, and USDC, stay as they are. The details are in the swap-section comments in `strat.conf.example`.

If `strat.conf` still has `BIDASK_DOUBLE_REBALANCE_STEP_PCT` or `BIDASK_SOL_REBALANCE_STEP_PCT` and does not yet have the matching `FIRST_STEP_PCT` and `NEXT_STEP_PCT` keys, that mode keeps even steps of the old value. The exit process logs the ladder it is actually using when it starts.

## 5. Create `pool.txt`

`pool.txt` is the list the bot watches. Git does not track that file. While the entry process is running, the bot rewrites the explanation block between `# === FORMAT (dikelola bot) ===` (FORMAT, managed by the bot) and `# === END FORMAT ===`. Leave the inside of that block alone. Lines outside the block stay as you wrote them when the header is rewritten.

```bash
cd ~/meteorabot-v3
cp pool.txt.example pool.txt
```

One line is one target. Columns are separated by commas:

`address_or_CA, size, (column 3 is ignored), mode, ca, entry_price, range`

Only the first column is required. An empty mode means `bidask:double`.

| Column | Contents |
|---|---|
| 1 | A pool address, or a token address (mint / CA) when column 5 contains `ca`. |
| 2 | Size. A plain number is a fixed amount of SOL (`0.5`). `1x`, `1.25x`, and `1.5x` are multiplied by `ENTRY_DEFAULT_SIZE_SOL` (so `1x` is 0.1 SOL when the default is 0.1). `tier1` is 1x, `tier2` is 1.25x, and `tier3` is 1.5x. Empty means the default. |
| 3 | An old cap on how many entries were allowed. It is ignored. You can leave it empty. |
| 4 | `spot`, `bidask:double` (or `bidask`), or `bidask:sol`. |
| 5 | `ca` when the first column is a token address. Empty when the first column is a pool address. Any other value makes the bot skip the line. |
| 6 | Price per token. Required for `bidask:sol`. Optional for `bidask:double`. No suffix, or `usd`, means USD per token. The suffix `sol` means SOL per token. `now` is only for `bidask:sol`. |
| 7 | The `bidask:sol` range only, written as `lower/upper`, for example `-30/15`. The lower number is from -99 to -1. The upper number is from 0 to 100. Empty means `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT`. Outside those limits, the bot skips the line. |

Examples, the same ones as the bot's header:

```text
POOL_ADDRESS,1x,,spot
TOKEN_CA,1x,,spot,ca
POOL_ADDRESS,0.5,,bidask:double
POOL_ADDRESS,0.5,,bidask:double,,0.0012
TOKEN_CA,1.25x,,bidask:double,ca
TOKEN_CA,1x,,bidask:double,ca,0.0000379sol
TOKEN_CA,1x,,bidask:sol,ca,0.00123
TOKEN_CA,1x,,bidask:sol,ca,0.00123usd
TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol
TOKEN_CA,1x,,bidask:sol,ca,now
TOKEN_CA,1x,,bidask:sol,ca,now,-30/15
TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol,-20/15
```

Replace `POOL_ADDRESS` and `TOKEN_CA` with real addresses. Keep notes off the same line. A line that starts with `#` is ignored.

### When the bot enters

**Spot.** It waits for the Supertrend signal (an uptrend on the `ENTRY_TIMEFRAME` candle). There is no target price.

**Bidask double.** An empty price column means Supertrend only. A filled price column means the first price sets the direction, and only then does Supertrend apply:

- a price below the target waits to rise to the target, then waits for the signal
- a price above the target waits to fall to the target, then waits for the signal
- a price exactly on the target is ready to wait for the signal right away
- a price that has not been read yet means the line is not ready, and the bot does not enter

After the price is touched, that status stays saved even if the price moves away, including after a restart. Before it is touched, the Supertrend signal does not open a position. `now`, or a price that is not valid, makes the bot skip the line. Column 7 is unused. Changing the target, or deleting the line or marking it with `#`, clears that direction.

**Bidask SOL.** It needs `ca` plus a positive price, or `now`. It does not use Supertrend. The touch direction is saved and survives a restart:

- below the target, it waits to rise until the price is `>=` the target
- above the target, it waits to fall until the price is `<=` the target
- exactly on the target, it enters now
- a price that has not been read yet does not enter, and it does not save a direction
- `now` enters as soon as the price can be read. The price at that moment is not saved as the target

The `sol` unit compares the token's price in SOL. The USD unit compares the token's price in USD. If the SOL price cannot be read, nothing triggers. After the price matches, the bot picks a token/SOL pool whose TVL and bin width both pass. If none pass, the line keeps waiting.

### The `#` mark and the limit

When the bot is live (`DRY_RUN` is off):

- A successful `bidask:sol` entry marks that line with `#`, so it does not enter again. Remove the `#` to watch it again.
- A successful spot or bidask double entry leaves the line active, with no new `#`. A bidask double line with a target has to touch that target again before the next entry.
- A line can also get a `#` when it expires with no entry, entry fails until `ENTRY_MAX_FAILURES`, its pair is not SOL, the pool price keeps missing, or the position disappears from the chain and no other position remains in that pool.

`DRY_RUN=true` does not write `#` into `pool.txt`.

On one pool, the bot keeps at most one spot position and one bidask position. Double, token, and SOL share that one bidask slot. A second spot, or a second bidask, stays closed while one of that style is already open. An average-down add sits outside that slot.

The file is read again every cycle. Removing a `#` while `meteorabot-entry` is running is enough. A restart is unnecessary. Close `pool.txt` in your editor while the bot is running. Saving an old copy from the editor can overwrite a `#` the bot just wrote.

## 6. Start the four main processes

pm2 keeps each process running in the background. From the repo folder:

```bash
cd ~/meteorabot-v3
pm2 start ecosystem.config.cjs --only meteorabot-entry,meteorabot-exit,meteorabot-wallet,meteorabot-telegram
pm2 status
pm2 save
pm2 startup
```

`pm2 startup` prints one command that starts with `sudo`. Copy that command, run it, then run `pm2 save` once more. That is what brings the processes back after the VPS reboots.

In `pm2 status`, all four names must show `online`.

| Process | Job |
|---|---|
| `meteorabot-entry` | Reads `pool.txt`, waits for a signal or a price, opens positions, and does the bidask double average-down. |
| `meteorabot-exit` | Watches positions: takes profit, reshapes, closes, and carries out button taps. |
| `meteorabot-wallet` | Watches the wallet and swaps leftover tokens into SOL. |
| `meteorabot-telegram` | Listens for button taps. Opening and closing positions is left to the other processes. |

While these four are running, leave `npm start` alone. That command starts entry and exit again in another process, so the bot would be running twice.

The fifth process, `meteorabot-entrybot`, is left out of the `--only` command above. How to turn it on is in [worker-setup.md](worker-setup.md).

## 7. Check the logs

```bash
pm2 logs meteorabot-entry --lines 40
pm2 logs meteorabot-exit --lines 20
pm2 logs meteorabot-wallet --lines 20
pm2 logs meteorabot-telegram --lines 20
ls logs/
```

What you should see during practice:

- Entry: `Meteora Worker [1/3]: ENTRY + DCA` and `Mode: DRY RUN`.
- Exit: `Meteora Worker [2/3]: EXIT MONITOR` and `Mode: DRY RUN`.
- Wallet: `Meteora Worker [3/3]: WALLET & SWEEP` and `Mode: DRY RUN`.
- Telegram: `Meteora Worker: TELEGRAM BUTTONS` and `Tombol: ON` (Buttons: ON).

Files in `logs/` include `entry-out.log`, `entry-error.log`, `exit-out.log`, `exit-error.log`, `wallet-out.log`, `wallet-error.log`, `telegram-out.log`, and `telegram-error.log`.

`Ctrl+C` only closes the log view. The bot keeps running.

## 8. Buttons on the status message

Buttons appear only on the regular Position Status message, and only when `TELEGRAM_BUTTONS_ENABLED` is something other than `false`. Entry, exit, and rebalance alerts have no buttons.

- `♻️` followed by the token name reshapes the position. Then choose `Token`, `SOL`, or `Batal` (Cancel). Choosing a side puts it in the queue right away.
- `⚡` followed by the token name closes the position (Zap Out). Then press `✅ Ya, zap out ...` (Yes, zap out ...) or cancel.
- A token-only position (`bidask:token`) has only the close button.
- A name longer than 10 characters gets one button per line.

A tap changes the buttons on that same message and shows a small popup (a toast). The tap does not send a new message. The exit process is what works through the queue. A command older than 10 minutes, or for a position that is already gone, is left undone. If the side you chose is empty, the message is `Tidak ada yang bisa di-rebalance di sisi itu` (There is nothing to rebalance on that side).

How to press the buttons, step by step, is in [worker-setup.md](worker-setup.md#buttons-on-the-status-message).

## 9. Update

```bash
cd ~/meteorabot-v3
git pull
npm ci
pm2 restart meteorabot-entry meteorabot-exit meteorabot-wallet meteorabot-telegram
```

`git pull` leaves `.env`, `strat.conf`, and `pool.txt` as they are. After the pull, look at the startup log. A line that starts with `[strat] Kunci ini tidak ada di strat.conf` (These keys are missing from strat.conf) means those new keys are using the defaults. Copy them from `strat.conf.example` into `strat.conf` when you want to set the numbers yourself, then restart again.

## 10. Common problems

| What you see | What it means | What to do |
|---|---|---|
| `node -v` does not start with v24 | The wrong Node is in use | Repeat step 1. Run `npm ci` again after Node 24 is the active version. |
| `WALLET_PRIVATE_KEY is not set — exiting`, and the status is `errored` or it keeps restarting | `.env` is empty, or the process was not restarted after you filled it in | Fill in the key, then run `pm2 restart meteorabot-entry meteorabot-exit meteorabot-wallet`. |
| `TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID kosong — worker telegram berhenti` (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is empty — the telegram worker is stopping) | The button process has no token or no chat | Fill in both in `.env`, then run `pm2 restart meteorabot-telegram`. |
| `Telegram getUpdates failed: 409` and the word `Conflict` | Two programs are reading updates for the same bot | Keep the notification token for `meteorabot-telegram` only. The queue bot needs its own token. See [worker-setup.md](worker-setup.md). |
| `[strat] strat.conf tidak ditemukan` (strat.conf was not found) | The bot is reading the example file, because your local `strat.conf` is missing | Run `cp strat.conf.example strat.conf`, then restart. |
| `[strat] Kunci ini tidak ada di strat.conf` (These keys are missing from strat.conf) | That key is using the default. The bot is still running | Copy the key from the example when you want to change it. |
| The entry log shows `skipped:` on one line | That line's format was not accepted | Match it to the examples in section 5. |
| The log still says `Mode: DRY RUN` after you meant to go live | `DRY_RUN` is set to something other than `false` | Set `DRY_RUN=false`, save `.env`, and restart all four processes. |
| After a reboot, no processes are running | `pm2 startup` or `pm2 save` did not finish | Repeat the end of step 6. |
| A `#` the bot wrote has disappeared | `pool.txt` was saved from an editor that still had an old copy open | Close the editor. Leave that file unsaved while the bot is running. |
