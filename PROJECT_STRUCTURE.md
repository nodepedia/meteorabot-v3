# Struktur Project Meteora Bot v3

## Folder Utama

- `src/` → kode utama bot
- `src/config/` → pengaturan & API Key (termasuk Helius, GMGN, Jupiter, Telegram)
- `src/entry/` → logika masuk posisi (auto-entry)
- `src/exit/` → logika keluar posisi (auto-exit)
- `src/market/` → data harga & indikator (Supertrend, RSI, dll)
- `src/solana/` → koneksi ke Solana, wallet, swap
- `src/meteora/` → interaksi dengan Meteora DLMM
- `src/state/` → penyimpanan data posisi & status bot
- `src/notify/` → notifikasi Telegram
- `src/entrybot/` → bot Telegram antre entry (hanya menulis `pool.txt`, tidak buka posisi)
- `src/worker-entrybot.js` → proses PM2 `meteorabot-entrybot`
- `scripts/` → script bantu (laporan PnL, dll)
- `test/` → file pengujian

## File Penting

- `strat.conf` → tuning strategi yang dipakai bot (entry/exit/DCA/swap). Gitignored; `git pull` tidak menimpa.
- `strat.conf.example` → template strategi yang di-commit. Salin sekali: `cp strat.conf.example strat.conf`. Kunci baru muncul di sini.
- `.env` → rahasia & setelan instance saja (wallet, RPC, API Key, telegram, DRY_RUN). Jangan di-commit.
- `.env.example` → contoh pengisian `.env`
- `pool.txt` → daftar pool yang dipantau bot (gitignored; header format ditulis bot)
- `pool.txt.example` → contoh format baris yang sama dengan header itu
- `src/index.js` → file utama yang menjalankan bot
- `src/config/env.js` → tempat memuat pengaturan dari .env
