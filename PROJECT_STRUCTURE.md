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
- `scripts/` → script bantu (laporan PnL, dll)
- `test/` → file pengujian

## File Penting

- `strat.conf` → default strategi (entry/exit/DCA/swap, dll). Di-commit ke git; tuning di sini.
- `.env` → rahasia & setelan instance saja (wallet, RPC, API Key, telegram, DRY_RUN). Jangan di-commit.
- `.env.example` → contoh pengisian `.env`
- `pool.txt` → daftar pool yang dipantau bot
- `src/index.js` → file utama yang menjalankan bot
- `src/config/env.js` → tempat memuat pengaturan dari .env
