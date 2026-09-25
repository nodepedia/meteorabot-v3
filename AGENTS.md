# AGENTS.md

## Aturan Kerja (WAJIB)

1. Buat rencana dulu sebelum mengedit file: sebutkan file mana, apa yang diubah, dan apakah besar/kecil.
2. Ubah SEMINIMAL mungkin. Jangan refactor atau "perbaiki sekalian" yang tidak diminta.
3. Kalau ragu atau perlu mengubah lebih banyak, tanyakan dulu.
4. Sebelum bilang "selesai": jelaskan file yang diubah + dampaknya, lalu jalankan `git status` dan `git diff --stat` dan tunjukkan hasilnya.
5. Jangan commit tanpa izin. Setelah hasil disetujui, baru tawarkan commit dengan pesan sederhana.
6. Jelaskan dengan bahasa sederhana (non-teknis). Waktu selalu pakai WIB — konversi kalau sumbernya UTC.
7. Selalu baca `PROJECT_STRUCTURE.md` dulu untuk menentukan file yang relevan; jangan baca semua folder.

## Snapshot

Bot trading live untuk pool Meteora DLMM di Solana (auto-entry + exit deterministik + DCA + auto-swap). Jalankan dari `src/index.js`.

- Full ESM (`"type": "module"`), **tanpa build step / TypeScript**. Edit `.js` langsung.
- **Wajib Node 24.x** (dipatok `node -v`). Bukan sekadar preferensi: `postinstall` mem-patch dependency agar jalan di Node 24.
- Detail arsitektur & konfigurasi: `PROJECT_STRUCTURE.md` dan `README.md` (jangan duplikasi di sini).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` / `npm run dev` | Jalankan bot (foreground) |
| `npm test` | `node --test` (Node built-in, tanpa framework) |
| `node --test test/rules.test.js` | Jalankan SATU file tes |
| `npm run lint` / `lint:fix` | ESLint 9 flat config |
| `npm run format` / `format:check` | Prettier |
| `npm run pm2` / `pm2:stop` / `pm2:logs` | Jalankan/stop/tail via PM2 |

Gaya: Prettier `printWidth: 120`, kutip ganda. Sebelum selesai jalankan `npm run lint` dan `npm test`.

## Keamanan runtime (penting)

- `npm start` benar-benar konek ke Solana RPC/Helius, Jupiter, GMGN, dan **bisa mengirim transaksi trading**. Selalu uji dengan `DRY_RUN=true` di `.env` dulu.
- Jangan jalankan bot sambil mengedit file state produksi (`state.json`, `pool.txt`, dll) — bisa bentrok.

## Jebakan repo

- **`npm install` menjalankan `postinstall`** (`scripts/patch-anchor.js`) yang mem-patch `@coral-xyz/anchor` + `@meteora-ag/dlmm` untuk ESM Node 24. Ganti/update dependency → jalankan `npm install` ulang, jika tidak bot gagal import.
- **Bot menulis ke `pool.txt`**: mengomentari (`#`) pool yang sudah selesai. Jangan biarkan `pool.txt` terbuka di editor saat bot jalan (save akan menimpa mark bot).
- File state runtime **git-ignored** dan tidak boleh di-commit: `state.json`, `pool.txt`, `decision-log.json`, `pnl-history.json`, `supertrend-cache.json`, `logs/`, `.env`.
- Tes memakai override env (`STATE_FILE`, `DECISION_LOG_FILE`, `PNL_HISTORY_FILE`) supaya tidak menyentuh file produksi — ikuti pola ini untuk tes baru.
- `test/smoke.test.js` mengimpor semua modul; kalau pindah/ganti nama file, update daftar `MODULES` di file itu.
- `scripts/pnl-report.js` **read-only** — tidak menyentuh `state.json`, tidak mengirim transaksi.
- Rahasia ada di `.env` (jangan pernah di-commit; `chmod 600 .env`).

## Alur domain singkat

- **Entry**: Supertrend 15m native (GMGN) bullish + harga real-time Jupiter ≤ garis → masuk (`first_touch`). Bearish = pool tidak dipantau. Dua cadence terpisah (refresh kandidat vs poll harga Jupiter).
- **Exit**: per mode `bidask:<komposit>` (`bidask:double`, `bidask:token`, `bidask:sol`) atau `spot` (satu mode, span ≥ `SPOT_MIN_BINS`, OOR kanan ber-timer) — stop loss, OOR, trailing TP, dll. OOR kiri `spot` → tutup tanpa swap lalu buka posisi `bidask:token` satu-sisi (jual saat naik) di pool yang sama; token dilindungi dari sweep selama proses (`spot-fallback.js`, `open-token-position.js`). Yield rendah `spot` (in-range, yield ≤ `SPOT_LOW_YIELD_CLOSE_PCT`, PnL ≥ 0, bertahan `SPOT_LOW_YIELD_DELAY_MINUTES`) → close + swap.
- **DCA**: averaging-down saat PnL sentuh `DCA_ARM_PCT`, rebound dari trough, dibatasi per sesi (`state.dcaUsage`). Hanya mode di `DCA_ELIGIBLE_MODES` (default `bidask:double`); `spot` & `bidask:token` dikecualikan.
