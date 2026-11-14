# AGENTS.md

## Aturan Kerja (WAJIB)

1. Buat rencana dulu sebelum mengedit file: sebutkan file mana, apa yang diubah, dan apakah besar/kecil.
2. Ubah SEMINIMAL mungkin. Jangan refactor atau "perbaiki sekalian" yang tidak diminta.
3. Kalau ragu atau perlu mengubah lebih banyak, tanyakan dulu.
4. Sebelum bilang "selesai": jelaskan file yang diubah + dampaknya, lalu jalankan `git status` dan `git diff --stat` dan tunjukkan hasilnya.
5. Jangan commit tanpa izin. Setelah hasil disetujui, baru tawarkan commit dengan pesan sederhana.
6. Jelaskan dengan bahasa sederhana (non-teknis). Waktu selalu pakai WIB — konversi kalau sumbernya UTC.
7. Selalu baca `PROJECT_STRUCTURE.md` dulu untuk menentukan file yang relevan; jangan baca semua folder.
8. Setiap kali mengubah angka aturan/parameter strategi (timer, persentase, cooldown, threshold), WAJIB jalankan pencarian lintas repo (`rg`) di `strat.conf`, `src/config/`, `src/`, dan `test/` untuk memastikan semua parameter kembar serta fallback default di `src/config/index.js` 100% sinkron, lalu pastikan `test/config-sync.test.js` lulus.

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
- **Default strategi ada di `strat.conf`** (di-commit). Tuning dilakukan di sini lalu `git commit`, bukan di `.env`. Bila key sama, `strat.conf` **menang** atas `.env` (`loadEnv` di `src/config/env.js`).
- Tes memakai override env (`STATE_FILE`, `DECISION_LOG_FILE`, `PNL_HISTORY_FILE`) supaya tidak menyentuh file produksi — ikuti pola ini untuk tes baru.
- `test/smoke.test.js` mengimpor semua modul; kalau pindah/ganti nama file, update daftar `MODULES` di file itu.
- `scripts/pnl-report.js` **read-only** — tidak menyentuh `state.json`, tidak mengirim transaksi.
- Rahasia & setelan instance (wallet, RPC, API key, telegram, `DRY_RUN`) ada di `.env` (jangan pernah di-commit; `chmod 600 .env`).

## Alur domain singkat

- **Entry**: Supertrend 15m native (GMGN) bullish + harga real-time Jupiter ≤ garis → masuk (`first_touch`). Bearish = pool tidak dipantau. Dua cadence terpisah (refresh kandidat vs poll harga Jupiter). Gerbang daftar pool hanya `#` di `pool.txt` (tidak ada hitungan max entry). Kuota serentak: paling banyak 1 posisi non-DCA per strategi per pool — `spot` dan `bidask` (`bidask:double` / `token` / `sol` satu slot) boleh terbuka bersamaan di pool yang sama, tidak pernah 2 spot atau 2 bidask. DCA tidak memakai kuota itu. Entry `bidask:double` hanya ke pool `binStep >= BIDASK_DOUBLE_MIN_BIN_STEP` (default 100); di antara yang lolos dipilih fee/active TVL 30m tertinggi. Tidak ada yang lolos = skip siklus, baris tidak di-`#`. Spot tidak kena. DCA tidak pindah pool. Hapus `#` saat worker entry jalan: baris ikut lagi di refresh berikutnya, tanpa restart.
- **Exit**: per mode `bidask:<komposit>` (`bidask:double`, `bidask:token`, `bidask:sol`) atau `spot` (satu mode, span ≥ `SPOT_MIN_BINS`, OOR kanan ber-timer) — stop loss, OOR, trailing TP, dll. OOR kiri `spot` → tutup tanpa swap lalu buka posisi `bidask:token` satu-sisi (jual saat naik) di pool yang sama; token dilindungi dari sweep selama proses (`spot-fallback.js`, `open-token-position.js`). Yield rendah `spot` (24h Fee/TVL posisi `feePerTvl24h` segar, strictly < `SPOT_YIELD_CLOSE_BELOW_PCT` default 7, bertahan `SPOT_YIELD_CLOSE_BELOW_SEC` default 600 detik, tanpa syarat PnL) → close biasa + klaim + swap; bukan re-entry OOR. Tepat 7 atau di atasnya mereset timer. Data basi mereset. Stop loss/OOR/trailing tetap bisa menutup sendiri.
- **DCA**: averaging-down untuk mode di `DCA_ELIGIBLE_MODES` (default `bidask:double`); `spot` & `bidask:token` dikecualikan. Kuota sesi `state.dcaUsage` / `DCA_MAX_ADDS`. `DCA_TRIGGER_MODE=price` (default) meng-arm dari turunnya harga pool vs `entryPoolPrice` posisi utama (`DCA_ARM_PRICE_PCT` -20 / `DCA_ARM_PRICE_PCT_2` -35, satu acuan); trough, pantulan, dan delay konfirmasi ikut harga. `DCA_TRIGGER_MODE=pnl` memakai PnL seperti sebelumnya (`DCA_ARM_PCT` / `DCA_ARM_PCT_2`). Posisi utama tanpa `entryPoolPrice` jatuh ke mode PnL. DCA tidak memakai kuota 1-posisi-per-strategi.
- **Rebalance bidask:double**: `BIDASK_DOUBLE_REBALANCE_ENABLED` (default nyala). Tiap kelipatan `BIDASK_DOUBLE_REBALANCE_STEP_PCT` turun dari harga entry posisi itu sendiri, token di atas bin aktif dibentuk ulang jadi BidAsk. Saat harga pulih minimal satu step (`BIDASK_DOUBLE_SOL_REBALANCE_ENABLED`, default nyala), SOL di bawah bin aktif dibentuk ulang jadi BidAsk. Posisi utama dan posisi DCA masing-masing punya penghitung step. Tidak jalan bersamaan dengan DCA di pool yang sama, dan tidak jalan selagi konfirmasi pantulan DCA masih pending. `REBALANCE_MODE=inplace` (default) memakai instruksi di tempat supaya saldo wallet tidak ikut terseret; `withdraw` hanya menyetor jumlah yang keluar dari posisi. Range tidak disusutkan.
