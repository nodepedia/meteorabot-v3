# meteorabot-v3

Bot trading LP otomatis untuk pool **Meteora DLMM** di Solana. Bot ini bisa berjalan sendiri: entry otomatis (Supertrend GMGN + harga Jupiter), exit otomatis (stop loss, OOR, trailing TP), DCA, auto swap token → SOL setelah posisi tutup, dan notifikasi Telegram. Ada `DRY_RUN` untuk mencoba tanpa transaksi sungguhan.

> Integrasi Runner Alert / meteora-pool-monitor itu **OPSIONAL**, lihat [setup.md](setup.md).

## Kebutuhan
- Ubuntu dengan **Node.js 24.x** (wajib untuk patch ESM di `scripts/patch-anchor.js`)
- `git`, `build-essential`, `python3`, `pm2`
- Wallet Solana, RPC (Helius), API key GMGN & Jupiter, bot Telegram

```bash
sudo apt update && sudo apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pm2
```

## Clone & install
```bash
git clone https://github.com/nodepedia/meteorabot-v3.git ~/meteorabot-v3
cd ~/meteorabot-v3
npm install          # postinstall menjalankan scripts/patch-anchor.js
cp .env.example .env && chmod 600 .env
```

## `.env` (rahasia, jangan di-commit)
| Variabel | Isi |
|---|---|
| `WALLET_PRIVATE_KEY` | secret key wallet (base58 atau JSON array) |
| `RPC_URL` / `HELIUS_API_KEY` | RPC Solana |
| `GMGN_API_KEY` | API key GMGN (candle/Supertrend) |
| `JUPITER_API_KEY` | key Jupiter (fallback kalau dua key di bawah kosong) |
| `JUPITER_PRICE_API_KEY` | key khusus polling harga |
| `JUPITER_SWAP_API_KEY` | key khusus swap |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | notifikasi Telegram |
| `DRY_RUN` | `true` untuk tes, `false` untuk live |

Variabel `SCANNER_*`, `MAIN_*`, `RUNNER_*`, `GMGN_WALLETS_DIR` hanya untuk integrasi opsional ([setup.md](setup.md)). Di bot utama biarkan kosong.

## `strat.conf` (strategi, di-commit)
Semua tuning strategi ada di sini: entry, DCA, exit, swap, log, dan lainnya. Kalau key yang sama ada di `.env`, nilai `strat.conf` yang menang. Yang paling sering diubah:
- `ENTRY_DEFAULT_SIZE_SOL=0.1`: size dasar per entry (SOL)
- `ENTRY_DEFAULT_MAX_POSITION=1`: batas entry per pool
- `ENTRY_EXPIRY_HOURS`: pool yang tidak entry dalam X jam akan di-`#`
- `ENTRY_MAX_FAILURES=3`: pool di-`#` setelah gagal entry sebanyak ini
- `POOL_LIST_FILE=pool.txt`

## `pool.txt`
Satu pool per baris, formatnya `address,size,max,mode`. Hanya `address` yang wajib.

| Kolom | Nilai | Default |
|---|---|---|
| `size` | angka SOL, `1x`, `1.25x`, `1.5x`, `tier1`/`tier2`/`tier3` (kali `ENTRY_DEFAULT_SIZE_SOL`) | `1x` (0.1 SOL) |
| `max` | jumlah entry maksimal di pool itu | `1` |
| `mode` | `bidask:double` (atau `bidask`), `spot` | `bidask:double` |

```
PoolAddr1                       # bidask:double, 0.1 SOL, max 1
PoolAddr2,0.5,2                 # 0.5 SOL, max 2
PoolAddr3,1.25x,1,spot          # spot, 0.125 SOL
```
- Baris yang diawali `#` dilewati.
- Bot otomatis memberi `#` pada pool yang sudah selesai (entry+exit), gagal `ENTRY_MAX_FAILURES` kali, bukan pair SOL, atau kedaluwarsa tanpa entry.
- Saat baris di-`#`, hitungan entry (`entryUsage`) pool itu di-reset. Jadi kalau `#` dihapus, pool bisa entry lagi dari nol.
- File ini dibaca ulang tiap siklus, jadi tidak perlu restart setelah mengubahnya.

## Jalankan (PM2)
```bash
pm2 start ecosystem.config.cjs    # meteorabot-entry, meteorabot-exit, meteorabot-wallet
pm2 save && pm2 startup
npm run pm2:logrotate             # opsional: rotasi log
```
Log:
```bash
pm2 logs meteorabot-entry         # juga: meteorabot-exit, meteorabot-wallet
ls logs/                          # entry-out.log, exit-error.log, dst.
```

## Update
```bash
cd ~/meteorabot-v3 && git pull && npm install && pm2 restart ecosystem.config.cjs
```
