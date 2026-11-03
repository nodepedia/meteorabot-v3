# setup.md — Integrasi OPSIONAL: terima pool dari Runner Alert & meteora-pool-monitor

meteorabot-v3 sudah bisa jalan sendiri ([README.md](README.md)). Panduan ini hanya kalau kamu ingin pool ditambahkan otomatis ke `pool.txt` oleh:
- **Runner Alert**: worker `meteorabot-runner` dari repo ini (`ecosystem.runner.config.cjs`), biasanya di VPS terpisah.
- **meteora-pool-monitor**: repo terpisah [nodepedia/meteora-pool-monitor](https://github.com/nodepedia/meteora-pool-monitor).

**Bot utama tidak perlu diubah atau di-restart.** `pool.txt` dibaca ulang tiap siklus.

## 1. Cara kerja
Runner Alert dan monitor boleh berjalan di **VPS yang berbeda** (atau di VPS main sendiri). Keduanya menambah pool dengan **satu perintah yang dijalankan di VPS main** (lewat ssh, atau lokal bila `MAIN_VPS_HOST` kosong):
```
cd <repo meteorabot-v3> && flock -w 60 <ledger>.lock node scripts/remote-add-pool.js --mint .. --pool .. --pools .. --line ..
```
Di bawah `flock`, script itu secara atomik:
1. membaca ledger `runner-added.json` di VPS main. Mint sudah ada (atau salah satu pool token sudah tercatat) → `already_added`;
2. memeriksa `pool.txt`: kalau pool terbaik **atau pool lain mana pun dari token itu** ada di baris mana saja, termasuk baris `#` dan baris manual → `already_in_pool` (mint ikut dicatat ke ledger);
3. (opsional, `MAIN_STATE_PATH`) token/pool masih punya posisi terbuka di `state.json` → `already_open`;
4. menambahkan baris spot ke `pool.txt`:
```
<pool>,<mult>,1,spot
```
5. menulis entri ledger `{mint, pool, pools, addedAt, by}` (tmp lalu rename), lalu mencetak `RESULT {"status":"added",...}`.

Jadi tiap **token (mint) hanya bisa di-add sekali seumur hidup**, siapa pun yang duluan. Kalau token sudah pernah masuk lewat pool mana pun, pool lain token itu tidak bisa di-add lagi.

Size (`mult`) mengikuti confluence wallet Tier S/A:
- Tier S + Tier A: `1.5x`
- Tier S saja: `1.25x`
- Tier A saja / tidak ada: `1x`

Wallet diambil dari `GMGN_WALLETS_DIR` (`gmgn_import_S.json`, `gmgn_import_A.json`, `wallets_report.json`), dicocokkan ke top holders/traders GMGN. LP smart wallet diambil dari `lpagent-smart-wallets.json`, dicocokkan ke owner posisi DLMM on-chain.

## 2. SSH ke VPS main (di host Runner/monitor yang BUKAN VPS main)
```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
ssh-copy-id root@MAIN_IP
ssh -o BatchMode=yes root@MAIN_IP 'cd ~/meteorabot-v3 && command -v flock && node -v'   # harus jalan tanpa password
```
Di VPS main: repo meteorabot-v3 harus versi yang punya `scripts/remote-add-pool.js` (`git pull`). `flock` (paket `util-linux`) sudah ada di Ubuntu. Kalau `node` dari nvm dan tidak ada di PATH ssh non-interaktif, isi `MAIN_NODE_BIN` dengan path absolut (`ssh root@MAIN_IP 'bash -lc "which node"'`).

Variabel `.env` (sama di kedua app):

| Variabel | Isi | Default |
|---|---|---|
| `MAIN_VPS_HOST` | `root@MAIN_IP`. Kosong = app berjalan DI VPS main, perintah dijalankan lokal | – |
| `MAIN_VPS_SSH_KEY` | path key ssh | `~/.ssh/id_ed25519` |
| `MAIN_POOL_PATH` | path `pool.txt` di VPS main | `~/meteorabot-v3/pool.txt` |
| `MAIN_ADDED_PATH` | ledger add-once di VPS main (lock = `<file>.lock`) | `<dir MAIN_POOL_PATH>/runner-added.json` |
| `MAIN_REPO_DIR` | repo meteorabot-v3 di VPS main (tempat `scripts/remote-add-pool.js`) | `<dir MAIN_POOL_PATH>` |
| `MAIN_NODE_BIN` | binary node di VPS main | `node` |
| `MAIN_STATE_PATH` | `state.json` di VPS main, cek posisi terbuka (opsional) | kosong = tidak dicek |
| `MAIN_LOCK_WAIT_SEC` | batas tunggu `flock` | `60` |
| `ADDED_CACHE_PATH` | cache lokal (hanya hemat ssh, bukan sumber kebenaran) | Runner: `<repo>/runner-added.cache.json`, monitor: `data/added-cache.json` |

`RUNNER_ADDED_PATH` **dihapus**: ledger tidak lagi dibaca dari file lokal tiap host.

## 3. Ledger add-once (`runner-added.json` di VPS main)
- Satu-satunya sumber kebenaran ada di VPS main, di `MAIN_ADDED_PATH`. Token tetap diblok meski kamu menghapus `#` atau barisnya dari `pool.txt`.
- Semua cek + add + catat terjadi di satu proses di bawah `flock`, jadi dua app yang add bersamaan tidak mungkin sama-sama berhasil.
- Ledger rusak (JSON tidak valid) → status `error`, `pool.txt` tidak disentuh.
- Cache lokal hanya mencatat mint yang sudah terjawab `added/already_added/already_in_pool`, agar tidak ssh berulang. Boleh dihapus kapan saja.

### Migrasi satu kali (dari versi lama)
Versi lama menyimpan ledger di host tiap app (`RUNNER_ADDED_PATH`, default `<repo>/runner-added.json`). Kalau Runner Alert/monitor **bukan** di VPS main dan file itu ada, gabungkan sekali ke VPS main (tidak dijalankan otomatis). Hentikan dulu runner & monitor, lalu dari host runner:
```bash
scp root@MAIN_IP:~/meteorabot-v3/runner-added.json /tmp/main-added.json 2>/dev/null || echo '{}' > /tmp/main-added.json
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("/tmp/main-added.json","utf8")||"{}");const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync("/tmp/merged-added.json",JSON.stringify({...b,...a},null,2))' ~/meteorabot-v3/runner-added.json
scp /tmp/merged-added.json root@MAIN_IP:~/meteorabot-v3/runner-added.json
```
Ulangi untuk ledger di host monitor bila berbeda. Format lama `{pools, addedAt, by}` tetap dibaca (pool lama ikut memblok). Kalau semua app sudah di VPS main dengan path default, tidak perlu migrasi: file lama `~/meteorabot-v3/runner-added.json` sudah menjadi ledger utama.

## 4. Runner Alert (repo ini, host runner)
`.env`:
```
SCANNER_GMGN_API_KEY=...
SCANNER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/meteorabot-v3/pool.txt
MAIN_STATE_PATH=~/meteorabot-v3/state.json
# MAIN_ADDED_PATH=~/meteorabot-v3/runner-added.json   # default
# MAIN_NODE_BIN=node
GMGN_WALLETS_DIR=/root/gmgn-wallets
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```
- LP smart wallet dibaca dari `<repo>/lpagent-smart-wallets.json`.
- `strat.conf`:
  - `RUNNER_AUTO_ENTRY=on|off` dibaca ulang tiap siklus.
  - `RUNNER_SCAN_INTERVAL_SEC=300`
  - `RUNNER_RPC_MIN_GAP_MS` (opsional, default 150) di `.env`.
```bash
pm2 start ecosystem.runner.config.cjs   # meteorabot-runner
pm2 logs meteorabot-runner              # "heartbeat alive", "scan mulai/selesai"
```

## 5. meteora-pool-monitor (repo terpisah, host mana saja)
Lihat README repo itu. Yang terkait integrasi di `.env`-nya:
```
AUTO_ADD_ENABLED=true
MAX_ADD_TOKEN_AGE_HOURS=24
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/meteorabot-v3/pool.txt
MAIN_STATE_PATH=~/meteorabot-v3/state.json
GMGN_WALLETS_DIR=/root/gmgn-wallets
LP_SMART_WALLETS_PATH=/root/meteorabot-v3/lpagent-smart-wallets.json
RPC_URL=                     # opsional, untuk cek LP smart wallet on-chain
```
Monitor hanya add pool paling efisien (fee/active TVL 30m tertinggi) untuk token berumur 12–24 jam. Status add dikirim di notif Telegram-nya.

## 6. Verifikasi & update
- VPS main: `tail ~/meteorabot-v3/pool.txt` menampilkan baris `...,spot` baru, dan `pm2 logs meteorabot-entry` menampilkan entry-nya.
- Update: **VPS main dulu** (`cd ~/meteorabot-v3 && git pull`, bot utama tidak perlu restart), lalu host runner: `cd ~/meteorabot-v3 && git pull && npm install && pm2 restart meteorabot-runner`.
- Cek ledger di VPS main: `cat ~/meteorabot-v3/runner-added.json`.
