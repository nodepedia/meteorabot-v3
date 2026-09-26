# Meteora Bot

Bot trading live untuk pool **Meteora DLMM** di Solana: auto-entry + exit deterministik, DCA, dan auto-swap.

## Fitur

- **Auto-entry** — masuk saat Supertrend 15m (GMGN) bullish dan harga real-time Jupiter ≤ garis.
- **Exit deterministik** — stop loss, OOR, trailing TP, bounce recovery; mode `bidask:<komposit>` atau `spot`.
- **DCA (averaging-down)** — tambah posisi saat PnL menyentuh `DCA_ARM_PCT` lalu rebound, dibatasi per sesi.
- **Auto swap** — token → SOL via Jupiter setelah posisi close.
- **Telegram + state persisten** — notifikasi dan status posisi tahan restart.
- **`DRY_RUN`** — uji tanpa kirim transaksi nyata.

Detail arsitektur & konfigurasi: lihat `PROJECT_STRUCTURE.md`.

## Instalasi VPS (Ubuntu)

### Kebutuhan

- Ubuntu dengan **Node.js 24.x** (wajib untuk patch ESM di `scripts/patch-anchor.js`)
- `git`, `build-essential`, `python3`
- `pm2` (opsional, untuk jalan sebagai service)

### 1. Paket sistem

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

`npm install` menjalankan `postinstall` (`scripts/patch-anchor.js`) yang mem-patch `@coral-xyz/anchor` dan `@meteora-ag/dlmm` untuk ESM Node 24.

### 4. Konfigurasi `.env` (rahasia) dan `strat.conf` (strategi)

Setelan strategi ada di `strat.conf` (di-commit ke git). `.env` hanya rahasia/setelan instance (wallet, RPC, API key, Telegram, `DRY_RUN`) dan git-ignored. Jika key sama ada di keduanya, `strat.conf` menang.

```bash
cp .env.example .env
nano .env             # rahasia saja
nano strat.conf       # tuning strategi (commit setelah diubah)
chmod 600 .env
```

Nilai yang wajib diisi:

| Variabel | Keterangan |
|---|---|
| `WALLET_PRIVATE_KEY` | Secret key wallet Solana (base58 atau JSON array) |
| `RPC_URL` / `HELIUS_API_KEY` | Endpoint Solana RPC |
| `GMGN_API_KEY` | API key candle GMGN |
| `JUPITER_API_KEY` | API key Jupiter (fallback price & swap) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notifikasi Telegram |
| `DRY_RUN` | `true` untuk uji coba; `false` baru saat siap trading live |

### 5. Buat `pool.txt`

Satu pool per baris. Alamat polos memakai default `strat.conf` (`ENTRY_DEFAULT_SIZE_SOL`, `ENTRY_DEFAULT_MAX_POSITION`); tambah `,entry_size,max_position` untuk override per pool. File ini git-ignored.

Bot otomatis mengomentari (`#`) baris pool yang sudah selesai: entry+exit tuntas, entry gagal `ENTRY_MAX_FAILURES` kali, pasangan bukan SOL, atau kedaluwarsa tanpa entry. Hapus `#` di depan untuk memantau pool itu lagi. Jangan buka `pool.txt` di editor saat bot jalan — save akan menimpa mark bot.

### 6. Uji di foreground

```bash
npm start
```

Pastikan log startup dan notifikasi Telegram muncul, dan `DRY_RUN=true` sebelum live.

### 7. Jalan sebagai service (PM2)

```bash
npm run pm2
pm2 save
pm2 startup   # salin & jalankan perintah yang dicetak untuk auto-start saat reboot
```

### 8. Logs

```bash
npm run pm2:logs
npm run pm2:logrotate   # install pm2-logrotate (max 10M, compress, retain 7)
```

### Troubleshooting

- **Node versi salah** — `node -v` harus 24.x, kalau tidak patch ESM gagal.
- **Build native error** — pastikan `build-essential` & `python3` terpasang, lalu `npm install` ulang.
- **Tidak ada pesan Telegram** — cek `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, dan akses keluar ke `api.telegram.org`.
- **RPC kena rate limit** — pakai Helius RPC khusus via `HELIUS_API_KEY`/`RPC_URL`.

## Menjalankan

| Command | Fungsi |
|---|---|
| `npm start` | Foreground |
| `npm run dev` | Foreground (dev) |
| `npm run pm2` | PM2 background |
| `npm run pm2:stop` | Stop PM2 |
| `npm run pm2:logs` | Tail log PM2 |
| `npm run pm2:logrotate` | Install/konfigurasi `pm2-logrotate` |
| `npm test` | Tes unit + module-load (`node:test`) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## Laporan PnL

`scripts/pnl-report.js` menarik PnL posisi dari Meteora datapi dan mencetak tabel (WIB, SOL + USD) beserta ringkasan posisi closed/open dan total realized. Read-only — tidak menyentuh `state.json` dan tidak mengirim transaksi.

```bash
node scripts/pnl-report.js                              # hari ini 00:00 WIB → sekarang
node scripts/pnl-report.js --days 1                     # 1 hari terakhir (verifikasi on-chain otomatis)
node scripts/pnl-report.js --from "2026-09-21 08:30" --to "2026-09-21 17:00"
node scripts/pnl-report.js --days 30 --no-verify        # periode panjang, tanpa on-chain
node scripts/pnl-report.js --wallet <alamat>            # override wallet
```

| Opsi | Keterangan |
|---|---|
| `--from "YYYY-MM-DD HH:mm"` | Mulai (WIB). Default: hari ini 00:00 WIB |
| `--to "YYYY-MM-DD HH:mm"` | Sampai (WIB). Default: sekarang |
| `--days N` | `N` hari terakhir (menimpa `--from`) |
| `--wallet <alamat>` | Wallet; default dari `WALLET_PRIVATE_KEY` di `.env` |
| `--verify` / `--no-verify` | Paksa on/off verifikasi modal on-chain |
| `--reconcile-threshold PCT` | Ambang beda modal (%) agar dikoreksi (default 25) |
| `-h`, `--help` | Tampilkan bantuan |

## Logs

- Foreground (`npm start`): ke terminal dan `logs/meteorabot-YYYY-MM-DD.log`.
- PM2 (`npm run pm2`): tambahan `logs/out.log` dan `logs/error.log`.
- `LOG_LEVEL` (default `info`): `debug` menampilkan baris `[detail]` teknis.
- File lama (> `LOG_RETENTION_DAYS`, default 7) dihapus saat startup; `logs/` git-ignored.

## Security

`.env`, `state.json`, `pnl-history.json`, dan logs git-ignored — jangan pernah commit rahasia. `strat.conf` justru di-commit agar tuning strategi tetap ada. Batasi izin dengan `chmod 600 .env` dan selalu uji dengan `DRY_RUN=true` sebelum live.
