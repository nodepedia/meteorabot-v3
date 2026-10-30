# Meteora Bot

> Full VPS setup (Main + Runner): see [SETUP.md](SETUP.md)


Live trading bot for **Meteora DLMM** pools on Solana: auto-entry + deterministic exit, DCA, and auto-swap.

## Features

- **Auto-entry** — enters when the 15m Supertrend (GMGN) is bullish and the real-time Jupiter price is ≤ the line.
- **Deterministic exit** — stop loss, OOR, trailing TP, bounce recovery; `bidask:<composite>` or `spot` mode.
- **DCA (averaging-down)** — adds when PnL touches `DCA_ARM_PCT` then rebounds; the second add uses `DCA_ARM_PCT_2` on the main position if the first add already closed, capped at 2 per session (no refund).
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

### Individual PM2 workers

`ecosystem.config.cjs` defines three workers (logs in `./logs/`):

| PM2 name | Script | Role |
|---|---|---|
| `meteorabot-entry` | `src/worker-entry.js` | Screening + open positions |
| `meteorabot-exit` | `src/worker-exit.js` | Monitor + close positions |
| `meteorabot-wallet` | `src/worker-wallet.js` | Wallet balance / housekeeping |
| `meteorabot-runner` | `src/worker-runner.js` | Runner Alert scan → auto-append to `pool.txt` (toggle) |

```bash
pm2 start ecosystem.config.cjs                              # all workers
pm2 start ecosystem.config.cjs --only meteorabot-entry      # one worker
pm2 restart meteorabot-exit
pm2 logs meteorabot-wallet
pm2 logs meteorabot-runner
pm2 save && pm2 startup                                     # persist on reboot
```

### Runner Alert auto-entry (`meteorabot-runner`)

- `strat.conf`: `RUNNER_AUTO_ENTRY=off` (default) or `on`; `RUNNER_SCAN_INTERVAL_SEC=300`. Re-read every cycle, no restart needed.
- `.env`: `SCANNER_GMGN_API_KEY`, `SCANNER_RPC_URL` (separate from the main bot keys); Telegram alerts use `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
- Check status: `pm2 logs meteorabot-runner` shows `RUNNER_AUTO_ENTRY=off — idle` or `scan mulai` / `scan selesai`.
- Manual one-shot still works: `node scripts/runner-alert-scan.js [--dry-run]`.

### Scripts

| Command | Function |
|---|---|
| `node scripts/runner-alert-scan.js` | Runner alert scan |
| `node scripts/pnl-report.js` | PnL report (read-only) |
| `node scripts/scan-pnl.js` | PnL scan |
| `node scripts/patch-anchor.js` | Patch Anchor dependency (post-install) |

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

## Runner di VPS terpisah

Di VPS worker:
0. Dependency: Node.js 24 + npm, PM2 (`npm i -g pm2`), git, openssh-client:
   ```
   apt update && apt install -y git openssh-client curl
   curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
   npm i -g pm2
   ```
   Lalu salin file wallet GMGN Tier S/A (`gmgn_import_S.json`, `gmgn_import_A.json`, `wallets_report.json` dari lowcap-hunter) ke satu folder dan isi `GMGN_WALLETS_DIR=/path/folder` di `.env` (tanpa ini confluence GMGN tidak terdeteksi).
1. `ssh-keygen -t ed25519`
2. `ssh-copy-id root@MAIN_IP`
3. Tes: `ssh root@MAIN_IP echo ok`
4. Clone repo, `npm install`
5. `.env`: isi `SCANNER_GMGN_API_KEY`, `SCANNER_RPC_URL`, `MAIN_VPS_HOST=root@MAIN_IP` (opsional `MAIN_VPS_SSH_KEY`, `MAIN_POOL_PATH`, `MAIN_STATE_PATH=~/grokbot/meteorabot-v3/state.json` untuk skip token yang posisinya masih open)
6. `strat.conf`: `RUNNER_AUTO_ENTRY=on`
7. `pm2 start ecosystem.config.cjs --only meteorabot-runner`

Di VPS main: biarkan `RUNNER_AUTO_ENTRY=off` atau jangan jalankan `meteorabot-runner`.
