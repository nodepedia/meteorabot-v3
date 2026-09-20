# Meteora Bot

Combined auto-entry and deterministic exit bot for Meteora DLMM pools on Solana.

## Features

- **Auto-entry** — Supertrend (ATR 10 × 3) **bullish** on **native 15m candles from GMGN**; entry fires on `first_touch` when the real-time **Jupiter** price drops to or below the Supertrend line. Candidate refresh (`ENTRY_SCAN_INTERVAL_SEC`) and Jupiter price polling (`JUPITER_POLL_INTERVAL_SEC`, `1` = 1 req/s, one batched request for all pools) run on separate cadences, so the slow RPC/pool refresh never throttles the signal. Jupiter `price/v3` allows ~10 req/10s per key, so do not go below `1`. BidAsk two-sided, bins −34/+34; per-pool size from `pool.txt`. Bearish = the pool is not watched at all. Next entry only after the previous position closes (and while still bullish), up to `max_position`.
- **Deterministic exit** per composite mode `<strategy>:<composition>` — `bidask:double`, `bidask:token`, `bidask:sol`, `spot:double` (plus scaffold `spot:token` / `spot:sol`) — stop loss, OOR, 2-phase trailing TP, indicator-armed trailing (RSI+MACD / RSI+BB), bounce recovery. Composition is detected from the position's initial entry deposits (`allTimeDeposits`), falling back to current bin contents; strategy is inferred from bin span.
- **DCA (averaging-down)** — trailing TP terbalik: saat posisi menyentuh `DCA_ARM_PCT` (−10%), bot melacak *trough* (titik terendah PnL), lalu membuka posisi baru di pool yang sama saat PnL rebound `DCA_REBOUND_PCT` dari trough, setelah konfirmasi `DCA_CONFIRM_DELAY_SEC`. Sekali per posisi; total **per sesi** (sejak posisi pertama dibuka sampai semua posisi di pool close) dibatasi `DCA_MAX_ADDS` dan disimpan persisten di `state.json`, jadi tahan restart. Size mengikuti `entry_size` `pool.txt`, tidak memakai kuota `max_position`, dan tidak butuh Supertrend bullish.
- **Auto swap** — base token → SOL via Jupiter after close.
- **Rate-limit safe GMGN** — one 15m fetch per token per bar, behind a shared queueing limiter (cap + min-gap + 429 backoff, no retry while banned), with a disk cache for Supertrend lines.
- Telegram notifications, persistent state, `DRY_RUN`.

## Project Structure

Modules are grouped by responsibility. Start at `src/index.js` (composition root) and
follow the imports down each layer.

```
src/
  index.js            # startup: load config, notify, start entry scanner + exit loop
  config/             # .env loading and per-mode rule resolution
    env.js            #   loadEnv(), bool(), num()
    rules.js          #   RULE_DEFAULTS, modeRules(), LEGACY_MODE
    index.js          #   final config object + rulesFor(mode)
  core/               # cross-cutting helpers
    paths.js          #   ROOT, LOG_DIR, STATE_FILE, PNL_HISTORY_FILE...
    logger.js         #   console + daily rotating file log
    utils.js          #   sleep(), minutes(), clamp()
    rate-limiter.js   #   sliding-window limiter (Meteora / GMGN)
    constants.js      #   WSOL_MINT, USDC_MINT, TOKEN_PROGRAM_ID
  solana/             # chain + exchange access
    connection.js     #   getConnection() singleton
    wallet.js         #   getWallet() singleton
    balances.js       #   token/SOL balances, decimals, USD value
    swap.js           #   Jupiter swap, swap-to-SOL, safety sweep
  market/             # market data + indicators
    candles.js        #   candle routing (15m->GMGN, native->Meteora) + volume
    gmgn-client.js    #   async gmgn-cli wrapper (rate-limit aware)
    gmgn-limiter.js   #   shared GMGN queue: cap, min-gap, 429 backoff
    jupiter-price.js  #   batched real-time USD prices (price/v3)
    supertrend-state.js #  per-mint bullish/bearish + line (disk-cached)
    indicators.js     #   RSI, MACD, Bollinger Bands
    supertrend.js     #   Supertrend + touch detection
  meteora/            # DLMM SDK wrapper
    sdk.js            #   lazy SDK loader
    positions.js      #   open positions + PnL/metadata/market-cap enrichment
    close.js          #   claim fees + remove liquidity + verify close
  entry/              # entry scanner and execution
    index.js          #   two cadences: slow candidate refresh + fast Jupiter price watch
    candidates.js     #   pure candidate filter (in-flight/entered/cooldown)
    pool-list.js      #   pool.txt parser
    pool-info.js      #   pool mint orientation + pair name
    price-watch.js    #   signal: bullish line (GMGN) + price <= line (Jupiter)
    execute.js        #   swap + initializePositionAndAddLiquidity
    runtime.js        #   in-flight entry / usage registry
  exit/               # exit monitor and close flow
    index.js          #   mainLoop()
    rules.js          #   evaluateExit() decision rules
    classify.js       #   infer <strategy>:<composition> per position
    trailing.js       #   trailing TP state machine + confirmation timer
    bounce.js         #   bounce recovery state machine
    sweep.js          #   per-cycle safety sweep to SOL
    close.js          #   handleClose(): close, swap back, notify
  state/              # persistent JSON state
    store.js          #   read/write helpers + file paths
    positions.js      #   position lifecycle + OOR
    trailing.js       #   trailing pending/confirmed state
    bounce.js         #   bounce recovery state
    history.js        #   PnL snapshots
  notify/
    telegram.js       # Telegram notifications
test/                 # node:test unit + module-load smoke tests
scripts/
  patch-anchor.js     # Node 24 ESM patch (postinstall)
```

## Quick Start

```bash
git clone https://github.com/nodepedia/meteorabot.git
cd meteorabot
npm install
cp .env.example .env   # fill in values
nano pool.txt ## fill pool token 
npm start              # foreground, or: npm run pm2
```

`pool.txt` format: `pool_address,entry_size,max_position`.

> Deploying to a VPS? See [VPS Installation](#vps-installation-ubuntu).

## VPS Installation (Ubuntu)

### Requirements

- Ubuntu (tested with Node.js 24.x — required for the ESM patch in `scripts/patch-anchor.js`)
- `git`, `build-essential`, `python3` (transitive native deps: bigint-buffer, bufferutil, utf-8-validate)
- Global `pm2` for running as a service
- No database, web server, or Docker needed. The bot only makes outbound connections
  (Solana RPC/Helius, Jupiter, GMGN, Telegram).

### 1. Install system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential python3
```

### 2. Install Node.js 24 and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
node -v && npm -v
```

### 3. Clone and install the project

```bash
git clone https://github.com/nodepedia/meteorabot.git
cd meteorabot
npm install
```

`npm install` runs a `postinstall` step (`scripts/patch-anchor.js`) that patches
`@coral-xyz/anchor` and `@meteora-ag/dlmm` for Node 24 ESM compatibility.

### 4. Configure `.env`

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Required values:

| Variable | Description |
|---|---|
| `WALLET_PRIVATE_KEY` | Solana wallet secret key (base58 or JSON array) |
| `RPC_URL` / `HELIUS_API_KEY` | Solana RPC endpoint |
| `GMGN_API_KEY` | GMGN candles API key |
| `JUPITER_API_KEY` | Jupiter swap API key |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram notifications |
| `DRY_RUN` | Keep `true` for the first run; set `false` only when ready to trade live |

### 5. Create `pool.txt`

Format: `pool_address,entry_size,max_position` (one pool per line). This file is git-ignored.

### 6. Test in the foreground

```bash
npm start
```

Confirm startup logs and Telegram notification, and verify `DRY_RUN=true` before going live.

### 7. Run as a service (PM2)

```bash
npm run pm2
pm2 save
pm2 startup
```

`pm2 startup` prints a command — copy/paste and run it to enable auto-start on reboot.

### 8. Logs

```bash
npm run pm2:logs
npm run pm2:logrotate   # install pm2-logrotate (10M max, compress, retain 7)
```

### Troubleshooting

- **Wrong Node version** — `node -v` must be 24.x, otherwise the ESM patch fails.
- **Native module build errors** — ensure `build-essential` and `python3` are installed, then re-run `npm install`.
- **No Telegram messages** — check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and outbound access to `api.telegram.org`.
- **RPC rate limits** — use a dedicated Helius RPC via `HELIUS_API_KEY`/`RPC_URL`.

## Configuration

All settings live in `.env` (see `.env.example`).
Groups: Shared (wallet/RPC/API/Telegram), Entry, **Data layer** (`CANDLE_15M_SOURCE`, `GMGN_*`, `METEORA_*`), **Entry signal** (`JUPITER_POLL_INTERVAL_SEC`, `ENTRY_TOUCH_TOLERANCE_PCT`, `SUPERTREND_CACHE_FILE`), Telegram, Swap, Exit general + per-mode (`BIDASK_DOUBLE_*`, `BIDASK_TOKEN_*`, `BIDASK_SOL_*`, `SPOT_DOUBLE_*`, `SPOT_TOKEN_*`, `SPOT_SOL_*`).

### Entry signal (GMGN 15m + Jupiter)

- `pool.txt` pools are evaluated only when no position is open. A pool with no open position is watched only while its 15m Supertrend (**from closed candles**) is **bullish**.
- The Supertrend line is computed from the **latest fully-closed** 15m candle (GMGN native; Meteora has no native 15m), refreshed **once per bar** through the existing per-mint GMGN kline request (in-flight + limiter de-duplicated, so no extra requests). Lines are cached to `supertrend-cache.json` (schema-versioned; stale/legacy entries are dropped on load).
- During the brief bar transition, before the new line is ready, the **previous bar's line** is used as a fallback so entry evaluation is never skipped.
- While bullish, the bot polls **Jupiter** `price/v3` (batched, one request for up to 50 mints). If `price <= line` the bot enters immediately (`first_touch`) — pullback or breakdown afterwards is ignored. The line is bar-based (updates ~4×/hour); the price watch stays real-time.
- Bearish = the pool is not watched at all. The trend color only changes when a 15m candle closes.
- GMGN calls go through a shared queue (cap `GMGN_MAX_PER_MIN`, min-gap `GMGN_MIN_GAP_SEC`, no retry during a 429 ban).

### DCA (averaging-down)

Mirror of trailing TP, inverted. Driven by a dedicated watcher on its own cadence `DCA_POLL_INTERVAL_SEC` (default `5s`), separate from the exit loop. Each tick fetches PnL once per pool and uses that same data for both the arm/trail scan and the rebound confirmation:

1. **Arm** — `pnlPct <= DCA_ARM_PCT` (default `-10`) starts tracking; `dcaTrough` = current PnL.
2. **Trail trough** — while armed, `dcaTrough` follows any lower PnL (deeper low).
3. **Rebound** — when `pnlPct - dcaTrough >= DCA_REBOUND_PCT` (absolute points, default `1`), a pending DCA is queued.
4. **Confirm** — on a later watcher tick, once `DCA_CONFIRM_DELAY_SEC` (default `5`) has elapsed, the same PnL fetch confirms the rebound. If it held, a new position opens in the same pool; otherwise the pending is cancelled and trailing continues (trough updated if deeper).

- Size = `entry_size` from `pool.txt`; does not consume the `max_position`/entry-usage quota.
- Each position can trigger at most once, and a session (from the first position opening until every position in the pool is closed) is capped by `DCA_MAX_ADDS` (default `1`). The counter lives in `state.dcaUsage` and resets only when the session ends (no open positions left), so a restart does not re-trigger DCA within a session, while a later re-entry in the same pool starts a fresh session.
- The pool PnL response is cached and shared with the exit loop's `enrichPnl`, so both cadences stay at one Meteora PnL request per `DCA_POLL_INTERVAL_SEC` per pool.
- `DCA_COOLDOWN_SEC` (default `300`) backs off a pool after a failed DCA execution. Guarded against in-flight entries, in-flight closes, dry-run, and gas reserve.

## Running

| Command | Mode |
|---|---|
| `npm start` | Foreground |
| `npm run dev` | Foreground (dev) |
| `npm run pm2` | PM2 background daemon |
| `npm run pm2:stop` | Stop PM2 |
| `npm run pm2:logs` | Tail PM2 logs |
| `npm run pm2:logrotate` | Install/configure `pm2-logrotate` for PM2 logs |
| `npm test` | Run unit + module-load tests (`node:test`) |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |

## Development

- `npm test` runs `node --test` with no extra test framework (Node 24 built-in). Tests cover
  pure helpers (`indicators`, `supertrend`, `config/rules`) plus a smoke test that imports every
  module to catch broken import paths.
- `npm run lint` / `npm run format` use ESLint 9 (flat config in `eslint.config.js`) and Prettier
  (`.prettierrc`). Run `npm run lint:fix` and `npm run format` before opening a PR.

## Logs

- Foreground (`npm start`): logs go to the terminal and to `logs/meteorabot-YYYY-MM-DD.log`. The `logs/` directory is created automatically on startup.
- PM2 (`npm run pm2`): stdout/stderr additionally go to `logs/out.log` and `logs/error.log`.
- **Narrative summary**: every `TG_STATUS_INTERVAL` (default 5 min) the bot prints a human-readable block — mode, pools being watched (pair, trend, price vs line), open positions, DCA state, and recent entry/DCA/close actions.
- **`LOG_LEVEL`** (default `info`): `info` shows the narrative summary, key events, and warnings/errors. `debug` additionally shows technical `[detail]` lines (GMGN/Meteora/Supertrend/cycle internals).
- Daily files older than `LOG_RETENTION_DAYS` (default `7`, `0` disables) are pruned at startup.
- Rotate PM2 logs with `npm run pm2:logrotate` (installs `pm2-logrotate`, max size 10M, compresses, retains 7).
- Log files are git-ignored (`*.log`), so `logs/` is not part of the repo.

## Security

`.env`, `state.json`, `pnl-history.json`, and logs are git-ignored. Never commit secrets.

Restrict permissions with `chmod 600 .env`, and always verify a configuration with `DRY_RUN=true` before running live.
