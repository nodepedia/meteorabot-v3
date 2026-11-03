# setup.md — Integrasi OPSIONAL: terima pool dari Runner Alert & meteora-pool-monitor

meteorabot-v3 sudah bisa jalan sendiri ([README.md](README.md)). Panduan ini hanya kalau kamu ingin pool ditambahkan otomatis ke `pool.txt` oleh:
- **Runner Alert**: worker `meteorabot-runner` dari repo ini (`ecosystem.runner.config.cjs`), biasanya di VPS terpisah.
- **meteora-pool-monitor**: repo terpisah [nodepedia/meteora-pool-monitor](https://github.com/nodepedia/meteora-pool-monitor).

**Bot utama tidak perlu diubah atau di-restart.** `pool.txt` dibaca ulang tiap siklus.

## 1. Cara kerja
Kedua app terhubung ke VPS main lewat ssh, membaca `pool.txt`, lalu menambahkan satu baris spot:
```
<pool>,<mult>,1,spot
```
Baris itu **tidak** ditambahkan kalau:
- pool token sudah ada di `pool.txt` (baris tanpa `#`), atau
- ada baris **spot** ber-`#` untuk pool token itu (fallback `#`: sudah pernah trade), atau
- `MAIN_STATE_PATH` diisi dan token masih punya posisi terbuka di `state.json`, atau
- token sudah ada di ledger add-once (lihat bagian 3).

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
| `MAIN_VPS_HOST` | `root@MAIN_IP` (kosong = Runner Alert menulis ke `pool.txt` lokal; monitor = gagal add) | – |
| `MAIN_VPS_SSH_KEY` | path key ssh | `~/.ssh/id_ed25519` |
| `MAIN_POOL_PATH` | path `pool.txt` di VPS main | `~/meteorabot-v3/pool.txt` |
| `MAIN_STATE_PATH` | path `state.json` di VPS main, untuk cek posisi terbuka (opsional) | kosong = tidak dicek |

## 3. Ledger add-once bersama (`runner-added.json`)
- Tiap token hanya boleh di-add **sekali seumur hidup**, siapa pun yang duluan (Runner Alert atau monitor). Token tetap diblok meski kamu menghapus `#` atau barisnya.
- Ledger disimpan di file JSON per mint (`{pools, addedAt, by}`) di host tempat app berjalan, di path `RUNNER_ADDED_PATH`.
  - Default Runner Alert: `<repo meteorabot-v3>/runner-added.json`
  - Default monitor: `/root/meteorabot-v3/runner-added.json`
- **Kalau kedua app di host yang sama, set `RUNNER_ADDED_PATH` ke path absolut yang sama di kedua `.env`**, misalnya `RUNNER_ADDED_PATH=/root/meteorabot-v3/runner-added.json`.
- Cek, add, dan catat dijalankan di bawah lock `runner-added.json.lock`. Lock basi (> 120 detik) dibersihkan otomatis. Penulisan atomik (tmp lalu rename).
- Ledger hanya dicatat kalau add **sukses**.
- Kalau kedua app di host berbeda, file ledger tidak terbagi. Jalankan keduanya di host yang sama.

## 4. Runner Alert (repo ini, host runner)
`.env`:
```
SCANNER_GMGN_API_KEY=...
SCANNER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
MAIN_VPS_HOST=root@MAIN_IP
MAIN_VPS_SSH_KEY=/root/.ssh/id_ed25519
MAIN_POOL_PATH=~/meteorabot-v3/pool.txt
MAIN_STATE_PATH=~/meteorabot-v3/state.json
RUNNER_ADDED_PATH=/root/meteorabot-v3/runner-added.json
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

## 5. meteora-pool-monitor (repo terpisah, host yang sama)
Lihat README repo itu. Yang terkait integrasi di `.env`-nya:
```
AUTO_ADD_ENABLED=true
MAX_ADD_TOKEN_AGE_HOURS=24
RUNNER_ADDED_PATH=/root/meteorabot-v3/runner-added.json   # SAMA dengan Runner Alert
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
- Update host runner: `cd ~/meteorabot-v3 && git pull && npm install && pm2 restart meteorabot-runner`.
