# meteorabot-v3

Bot trading LP otomatis untuk pool **Meteora DLMM** di Solana. Bot ini bisa berjalan sendiri: entry otomatis (Supertrend GMGN + harga Jupiter), exit otomatis (stop loss, OOR, trailing TP), DCA, auto swap token → SOL setelah posisi tutup, dan notifikasi Telegram. Ada `DRY_RUN` untuk mencoba tanpa transaksi sungguhan.

> Worker opsional yang bisa mengisi `pool.txt` otomatis: [runner-alert](https://github.com/nodepedia/runner-alert) dan [meteora-pool-monitor](https://github.com/nodepedia/meteora-pool-monitor). Lihat [setup.md](setup.md). Tanpa keduanya, bot jalan dengan pool manual.

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


## `strat.conf` (strategi, di-commit)
Semua tuning strategi ada di sini: entry, DCA, exit, swap, log, dan lainnya. Kalau key yang sama ada di `.env`, nilai `strat.conf` yang menang. Yang paling sering diubah:
- `ENTRY_DEFAULT_SIZE_SOL=0.1`: size dasar per entry (SOL)
- `ENTRY_EXPIRY_HOURS`: pool yang tidak entry dalam X jam akan di-`#`
- `ENTRY_MAX_FAILURES=3`: pool di-`#` setelah gagal entry sebanyak ini
- `POOL_LIST_FILE=pool.txt`
- `SPOT_INDICATOR_EXIT=immediate`: posisi spot langsung close saat sinyal indikator (RSI+MACD / RSI+BB). Isi `trailing` untuk perilaku lama (arm trailing dulu). BidAsk tidak terpengaruh.
- `DCA_TRIGGER_MODE=price`: DCA `bidask:double` meng-arm dari turunnya harga pool vs harga entry posisi utama (`DCA_ARM_PRICE_PCT=-20`, DCA kedua `DCA_ARM_PRICE_PCT_2=-35`). Isi `pnl` untuk kembali ke pemicu PnL lama. Posisi lama tanpa harga entry ikut mode PnL.
- `BIDASK_DOUBLE_MIN_BIN_STEP=100`: entry `bidask:double` hanya ke pool dengan bin step minimal 100. Yang dipilih di antara yang lolos = fee/active TVL 30m tertinggi. Tidak ada yang lolos = lewati siklus itu, baris tidak diberi `#`. `0` mematikan aturan ini. Spot tidak kena. DCA tetap di pool posisi yang sudah terbuka.
- `BIDASK_DOUBLE_REBALANCE_ENABLED=true`: saat harga pool turun kelipatan 10% dari harga entry tiap posisi `bidask:double` (utama dan tiap DCA), token di atas bin aktif dibentuk ulang jadi BidAsk di posisi yang sama. `false` mematikan sisi token dan sisi SOL.
- `BIDASK_DOUBLE_SOL_REBALANCE_ENABLED=true`: saat harga pulih minimal satu step dari rebalance terakhir, SOL di bawah bin aktif dibentuk ulang jadi BidAsk. `false` hanya mematikan sisi SOL.
- `REBALANCE_MODE=inplace`: semua rebalance (spot token, spot SOL, bidask token, bidask SOL) memakai instruksi di tempat, jadi saldo yang sudah ada di wallet tidak ikut masuk. `withdraw` kembali ke tarik-lalu-setor, hanya sejumlah yang keluar dari posisi.
- Swap ke SOL saat close: token base **dan** reward di-swap ke SOL, kecuali mint yang dilindungi (posisi aktif, entry/rebalance/reentry OOR kanan/fallback OOR kiri yang sedang berjalan, USDC). Swap gagal → "swap tertunda", dicoba ulang tiap `SWAP_PENDING_RETRY_SEC` (90s); pool baru ditandai `#` setelah swap tuntas atau dihentikan (alert Telegram). Safety sweep juga memindai token Token-2022.

## `pool.txt`
Satu pool per baris, formatnya `address,size[,max],mode[,ca]`. Hanya `address` yang wajib. Kolom `max` (jumlah entry seumur hidup) **diabaikan** — baris lama `address,size,max,mode` tetap valid.

| Kolom | Nilai | Default |
|---|---|---|
| `size` | angka SOL, `1x`, `1.25x`, `1.5x`, `tier1`/`tier2`/`tier3` (kali `ENTRY_DEFAULT_SIZE_SOL`) | `1x` (0.1 SOL) |
| `max` | kolom lama, tidak dipakai | — |
| `mode` | `bidask:double` (atau `bidask`), `spot` | `bidask:double` |
| kolom ke-5 | `ca` = kolom pertama adalah **CA token (mint)**, bukan pool | kosong (alamat pool) |

```
PoolAddr1                       # bidask:double, 0.1 SOL
PoolAddr2,0.5                   # 0.5 SOL, bidask:double
PoolAddr3,1.25x,1,spot          # spot, 0.125 SOL (angka max diabaikan)
TokenMint,1.5x,1,spot,ca        # baris CA: pool dipilih bot saat entry
```

Gerbang masuk hanya tanda `#`. Selama baris tidak dikomentari, bot boleh masuk lagi setelah posisi sebelumnya tutup. Kuota yang tersisa: paling banyak **1 posisi non-DCA per strategi per pool**. `spot` dan `bidask` (`bidask:double`, `bidask:token`, `bidask:sol`) masing-masing punya slot, jadi satu spot dan satu bidask boleh terbuka di pool yang sama. Dua spot atau dua bidask tidak. Posisi DCA tidak memakan slot bidask.

Baris CA (`,ca`):
- Saat entry, bot mengambil semua pool DLMM X/SOL token itu dari Meteora (`pool-discovery-api`, timeframe 30m, cache `CA_POOL_CACHE_SEC`=60s) dan memilih **fee/active TVL 30m tertinggi**, tanpa filter tambahan (penyaringan sudah dilakukan worker). Tidak ada pool X/SOL = skip siklus itu (log maksimal 1x per CA per 10 menit).
- Pool hasil pilihan disimpan di state posisi dan di `runtime-state.json` (`poolAliases`), sehingga exit, re-entry/OOR kanan (termasuk pindah pool), dan DCA tetap memakai pool itu.
- Saat posisi selesai/dinonaktifkan, **baris CA** yang diberi `#`, sama seperti baris pool.
- Baris CA biasanya ditulis otomatis oleh Runner Alert / meteora-pool-monitor (lihat [setup.md](setup.md)), tapi bisa juga ditulis manual.
- Baris yang diawali `#` dilewati.
- Bot otomatis memberi `#` pada pool yang sudah selesai (entry+exit), gagal `ENTRY_MAX_FAILURES` kali, bukan pair SOL, atau kedaluwarsa tanpa entry.
- File ini dibaca ulang tiap siklus refresh kandidat. Menghapus `#` saat `meteorabot-entry` sedang jalan cukup — tidak perlu restart. Gate di memori (cooldown gagal, timer kedaluwarsa, pool yang sempat di-skip) ikut dibersihkan saat baris itu aktif lagi.
- Setelah **deploy** kode baru, restart proses yang memuatnya (`pm2 restart ecosystem.config.cjs`, atau minimal `meteorabot-entry` dan `meteorabot-exit`). Menghapus `#` setelah proses baru jalan tidak perlu restart lagi.

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
