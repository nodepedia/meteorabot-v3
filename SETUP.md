# meteorabot-v3 Setup Guide (fresh VPS: Main + Runner Worker)

Two Ubuntu VPS:
- **Main VPS**: runs `meteorabot-entry`, `meteorabot-exit`, `meteorabot-wallet` (LP positions).
- **Runner VPS**: runs `meteorabot-runner` (Runner Alert scan), writes runners into Main's `pool.txt` over SSH. Separate GMGN/Helius keys = no quota clash.

## 1. Install dependencies (both VPS)
```bash
apt update && apt install -y git openssh-client curl
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
npm i -g pm2
git clone https://github.com/nodepedia/meteorabot-v3.git ~/grokbot/meteorabot-v3
cd ~/grokbot/meteorabot-v3 && npm install
cp .env.example .env
```

## 2. Main VPS
1. Edit `.env`: wallet private key, RPC/Helius, GMGN, Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Leave `SCANNER_*` and `MAIN_*` empty.
2. Edit `strat.conf` (entry size, ranges, etc.). Keep `RUNNER_AUTO_ENTRY=off`.
3. Add manual pools to `pool.txt` (optional).
4. Start:
```bash
pm2 start ecosystem.config.cjs --only meteorabot-entry,meteorabot-exit,meteorabot-wallet
pm2 save && pm2 startup
```

## 3. Runner VPS
1. SSH key to Main:
```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
ssh-copy-id root@MAIN_IP
ssh -o BatchMode=yes root@MAIN_IP "cat ~/grokbot/meteorabot-v3/pool.txt"   # must print without password
```
2. GMGN smart wallets (Tier S/A from lowcap-hunter):
```bash
mkdir -p /root/grokbot/gmgn-wallets
# copy gmgn_import_S.json, gmgn_import_A.json, wallets_report.json here
```
3. `.env` (only these needed):
```
SCANNER_GMGN_API_KEY=...
SCANNER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/grokbot/meteorabot-v3/pool.txt
MAIN_STATE_PATH=~/grokbot/meteorabot-v3/state.json
GMGN_WALLETS_DIR=/root/grokbot/gmgn-wallets
TELEGRAM_BOT_TOKEN=...   # optional alerts
TELEGRAM_CHAT_ID=...
```
Use absolute paths (no `~`) for `MAIN_VPS_SSH_KEY` and `GMGN_WALLETS_DIR`.
4. `strat.conf`: `RUNNER_AUTO_ENTRY=on` (live toggle, no restart needed). Interval: `RUNNER_SCAN_INTERVAL_SEC=300`.
5. Start:
```bash
pm2 start ecosystem.config.cjs --only meteorabot-runner
pm2 save && pm2 startup
```

## 4. Verify
- Runner: `pm2 logs meteorabot-runner` shows `worker start`, a `heartbeat alive` line every 60s (`RUNNER_HEARTBEAT_SEC`), and `scan mulai` / `scan selesai` (`off — idle` = toggle is off). Debug: `timeout 60 node src/worker-runner.js`.
- Main: `tail ~/grokbot/meteorabot-v3/pool.txt` shows new `...,spot` lines; `pm2 logs meteorabot-entry` shows the entry.

## 5. Sizing rule (Runner)
- Tier S + Tier A wallets: 1.5x
- Tier S only: 1.25x
- Tier A only / none: 1x

## 6. Update
```bash
cd ~/grokbot/meteorabot-v3 && git pull && npm install && pm2 restart all
```
Never commit `.env`.
