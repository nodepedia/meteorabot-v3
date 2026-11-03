# setup.md — Integrasi OPSIONAL: terima CA token dari Runner Alert & meteora-pool-monitor

meteorabot-v3 sudah bisa jalan sendiri ([README.md](README.md)). Panduan ini hanya kalau kamu ingin pool ditambahkan otomatis ke `pool.txt` oleh:
- **Runner Alert**: worker `meteorabot-runner` dari repo ini (`ecosystem.runner.config.cjs`), biasanya di VPS terpisah.
- **meteora-pool-monitor**: repo terpisah [nodepedia/meteora-pool-monitor](https://github.com/nodepedia/meteora-pool-monitor).

**Bot utama tidak perlu diubah atau di-restart.** `pool.txt` dibaca ulang tiap siklus.

## 1. Cara kerja
Kedua app **tidak memilih pool**. Saat token lolos filter add, mereka mengirim **CA token** ke `pool.txt` di VPS main sebagai baris CA:
```
<CA>,<mult>,1,spot,ca
```
meteorabot-v3 lalu memilih sendiri pool DLMM paling efisien untuk CA itu saat entry (lihat README, bagian `pool.txt`).

Dedupe per token, dalam **satu perintah ssh** di bawah `flock` pada `pool.txt` (POSIX `sh` + `grep`, tidak butuh node di VPS main):
- kalau CA sudah ada di baris mana pun, **termasuk baris ber-`#`** → skip (`already_in_pool`)
- kalau salah satu pool address token itu (yang diketahui app pengirim) sudah ada di baris mana pun, termasuk `#` → skip
- selain itu → append baris CA

Karena dicek dan ditulis di VPS main di bawah lock, Runner Alert dan monitor boleh jalan di **VPS yang berbeda** tanpa dobel.

Tidak ada ledger: selama baris CA masih ada (walau ber-`#`), token tidak ditambahkan lagi. **Kalau baris CA dihapus total, token boleh ditambahkan lagi.**

Size (`mult`) mengikuti confluence wallet Tier S/A:
- Tier S + Tier A: `1.5x`
- Tier S saja: `1.25x`
- Tier A saja / tidak ada: `1x`

Wallet diambil dari `GMGN_WALLETS_DIR` (`gmgn_import_S.json`, `gmgn_import_A.json`, `wallets_report.json`), dicocokkan ke top holders/traders GMGN. LP smart wallet diambil dari `lpagent-smart-wallets.json`, dicocokkan ke owner posisi DLMM on-chain.

## 2. SSH ke VPS main (di host Runner/monitor)
```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
ssh-copy-id root@MAIN_IP
ssh -o BatchMode=yes root@MAIN_IP "cat ~/meteorabot-v3/pool.txt"   # harus jalan tanpa password
```
Variabel `.env` (sama di kedua app):

| Variabel | Isi | Default |
|---|---|---|
| `MAIN_VPS_HOST` | `root@MAIN_IP` (kosong = Runner Alert menulis ke `pool.txt` lokal dengan cek yang sama; monitor = gagal add) | – |
| `MAIN_VPS_SSH_KEY` | path key ssh | `~/.ssh/id_ed25519` |
| `MAIN_POOL_PATH` | path `pool.txt` di VPS main | `~/meteorabot-v3/pool.txt` |

## 3. Runner Alert (repo ini, host runner)
`.env`:
```
SCANNER_GMGN_API_KEY=...
SCANNER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/meteorabot-v3/pool.txt
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

## 4. meteora-pool-monitor (repo terpisah, boleh host berbeda)
Lihat README repo itu. Yang terkait integrasi di `.env`-nya:
```
AUTO_ADD_ENABLED=true
MAX_ADD_TOKEN_AGE_HOURS=24
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/meteorabot-v3/pool.txt
GMGN_WALLETS_DIR=/root/gmgn-wallets
LP_SMART_WALLETS_PATH=/root/meteorabot-v3/lpagent-smart-wallets.json
RPC_URL=                     # opsional, untuk cek LP smart wallet on-chain
```
Monitor hanya mengirim baris CA untuk token berumur 12–24 jam. Status (✅ ditambahkan / ⏭️ sudah ada / ❌ gagal) dikirim di notif Telegram-nya.

## 5. Verifikasi & update
- VPS main: `tail ~/meteorabot-v3/pool.txt` menampilkan baris `<CA>,...,spot,ca` baru, dan `pm2 logs meteorabot-entry` menampilkan entry-nya.
- Update host runner: `cd ~/meteorabot-v3 && git pull && npm install && pm2 restart meteorabot-runner`.
