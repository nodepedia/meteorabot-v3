# Meteora Bot

Live trading bot for **Meteora DLMM** pools on Solana: auto-entry + deterministic exit, DCA, and auto-swap.

## Features

- **Auto-entry** — enters when the 15m Supertrend (GMGN) is bullish and the real-time Jupiter price is ≤ the line.
- **Deterministic exit** — stop loss, OOR, trailing TP, bounce recovery; `bidask:<composite>` or `spot` mode.
- **DCA (averaging-down)** — adds to the position when PnL touches `DCA_ARM_PCT` then rebounds, capped per session.
- **Auto swap** — token → SOL via Jupiter after the position closes.
- **Telegram + persistent state** — notifications and position status survive restarts.
- **`DRY_RUN`** — test without sending real transactions.

For architecture & configuration details, see `PROJECT_STRUCTURE.md`.

## VPS Setup (Ubuntu)

### Requirements

- Ubuntu with **Node.js 24.x** (required for the ESM patch in `scripts/patch-anchor.js`)
- `git`, `build-essential`, `python3`
- `pm2` (optional, to run as a service)

### 1. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential python3
```

### 2. Node.js 24 + PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
node -v && npm -v
```

### 3. Clone & install

```bash
git clone https://github.com/nodepedia/meteorabot-v3
cd meteorabot-v3
npm install
```

`npm install` runs `postinstall` (`scripts/patch-anchor.js`), which patches `@coral-xyz/anchor` and `@meteora-ag/dlmm` for ESM on Node 24.

### 4. Configure `.env` (secrets) and `strat.conf` (strategy)

Strategy settings live in `strat.conf` (committed to git). `.env` only holds secrets/instance settings (wallet, RPC, API key, Telegram, `DRY_RUN`) and is git-ignored. If the same key exists in both, `strat.conf` wins.

```bash
cp .env.example .env
nano .env             # secrets only
nano strat.conf       # strategy tuning (commit after changes)
chmod 600 .env
```

Required values:

| Variable | Description |
|---|---|
| `WALLET_PRIVATE_KEY` | Solana wallet secret key (base58 or JSON array) |
| `RPC_URL` / `HELIUS_API_KEY` | Solana RPC endpoint |
| `GMGN_API_KEY` | GMGN candle API key |
| `JUPITER_API_KEY` | Jupiter API key (price fallback & swap) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram notifications |
| `DRY_RUN` | `true` for testing; `false` only when ready to trade live |

### 5. Create `pool.txt`

One pool per line. A bare address uses the `strat.conf` defaults (`ENTRY_DEFAULT_SIZE_SOL`, `ENTRY_DEFAULT_MAX_POSITION`); add `,entry_size,max_position` to override per pool. This file is git-ignored.

The bot automatically comments out (`#`) pool lines that are done: entry+exit completed, entry failed `ENTRY_MAX_FAILURES` times, not a SOL pair, or expired without entry. Remove the leading `#` to monitor that pool again. Don't open `pool.txt` in an editor while the bot is running — saving will overwrite the bot's marks.

### 6. Test in the foreground

```bash
npm start
```

Make sure the startup logs and Telegram notifications appear, and that `DRY_RUN=true` before going live.

### 7. Run as a service (PM2)

```bash
npm run pm2
pm2 save
pm2 startup   # copy & run the printed command to auto-start on reboot
```

### 8. Logs

```bash
npm run pm2:logs
npm run pm2:logrotate   # install pm2-logrotate (max 10M, compress, retain 7)
```

### Troubleshooting

- **Wrong Node version** — `node -v` must be 24.x, otherwise the ESM patch fails.
- **Native build error** — make sure `build-essential` & `python3` are installed, then re-run `npm install`.
- **No Telegram messages** — check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and outbound access to `api.telegram.org`.
- **RPC rate limited** — use a dedicated Helius RPC via `HELIUS_API_KEY`/`RPC_URL`.

## Running

| Command | Function |
|---|---|
| `npm start` | Foreground |
| `npm run dev` | Foreground (dev) |
| `npm run pm2` | PM2 background |
| `npm run pm2:stop` | Stop PM2 |
| `npm run pm2:logs` | Tail PM2 logs |
| `npm run pm2:logrotate` | Install/configure `pm2-logrotate` |
| `npm test` | Unit tests + module-load (`node:test`) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## PnL Report

`scripts/pnl-report.js` pulls position PnL from the Meteora datapi and prints a table (WIB, SOL + USD) along with a summary of closed/open positions and total realized. Read-only — it doesn't touch `state.json` and doesn't send transactions.

```bash
node scripts/pnl-report.js                              # today 00:00 WIB → now
node scripts/pnl-report.js --days 1                     # last 1 day (on-chain verification automatic)
node scripts/pnl-report.js --from "2026-09-21 08:30" --to "2026-09-21 17:00"
node scripts/pnl-report.js --days 30 --no-verify        # long period, without on-chain
node scripts/pnl-report.js --wallet <address>           # override wallet
```

| Option | Description |
|---|---|
| `--from "YYYY-MM-DD HH:mm"` | Start (WIB). Default: today 00:00 WIB |
| `--to "YYYY-MM-DD HH:mm"` | End (WIB). Default: now |
| `--days N` | Last `N` days (overrides `--from`) |
| `--wallet <address>` | Wallet; defaults to `WALLET_PRIVATE_KEY` in `.env` |
| `--verify` / `--no-verify` | Force on/off on-chain capital verification |
| `--reconcile-threshold PCT` | Capital difference threshold (%) to correct (default 25) |
| `-h`, `--help` | Show help |

## Logs

- Foreground (`npm start`): to the terminal and `logs/meteorabot-YYYY-MM-DD.log`.
- PM2 (`npm run pm2`): additionally `logs/out.log` and `logs/error.log`.
- `LOG_LEVEL` (default `info`): `debug` shows technical `[detail]` lines.
- Old files (> `LOG_RETENTION_DAYS`, default 7) are deleted on startup; `logs/` is git-ignored.

## Security

`.env`, `state.json`, `pnl-history.json`, and logs are git-ignored — never commit secrets. `strat.conf` is deliberately committed so strategy tuning persists. Restrict permissions with `chmod 600 .env` and always test with `DRY_RUN=true` before going live.
