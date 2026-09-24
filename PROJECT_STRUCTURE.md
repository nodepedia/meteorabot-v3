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

- `.env` → tempat menyimpan API Key dan rahasia (jangan diubah sembarangan)
- `.env.example` → contoh pengaturan
- `pool.txt` → daftar pool yang dipantau bot
- `src/index.js` → file utama yang menjalankan bot
- `src/config/env.js` → tempat memuat pengaturan dari .env
