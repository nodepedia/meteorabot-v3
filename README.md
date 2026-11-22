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
cp strat.conf.example strat.conf
```

## Konfigurasi

`strat.conf` adalah tuning yang dipakai bot. File itu tidak di-commit, dan `git pull` tidak menimpanya.

```bash
cp strat.conf.example strat.conf
```

Lakukan sekali saat pertama pasang. Kunci baru muncul di `strat.conf.example`. Kalau `strat.conf` belum punya kunci itu, bot memakai default di kode (sama dengan nilai di contoh) dan menulis nama kuncinya sekali saat mulai. Tidak ada `strat.conf` sama sekali: bot memakai `strat.conf.example` dan memperingatkan. Rahasia tetap di `.env`. Kalau key yang sama ada di keduanya, nilai `strat.conf` yang menang.

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
| `ENTRYBOT_TELEGRAM_TOKEN` | token bot Telegram **kedua** untuk antre entry (`/entry`). Jangan sama dengan `TELEGRAM_BOT_TOKEN` |
| `ENTRYBOT_TELEGRAM_CHAT_ID` | chat yang boleh pakai entry bot. Kosong = pakai `TELEGRAM_CHAT_ID` |
| `DRY_RUN` | `true` untuk tes, `false` untuk live |


## `strat.conf` (strategi)
Semua tuning strategi ada di file lokal ini (lihat [Konfigurasi](#konfigurasi)): entry, DCA, exit, swap, log, dan lainnya. Kalau key yang sama ada di `.env`, nilai `strat.conf` yang menang. Yang paling sering diubah:
- `ENTRY_DEFAULT_SIZE_SOL=0.1`: size dasar per entry (SOL)
- `ENTRY_EXPIRY_HOURS`: pool yang tidak entry dalam X jam akan di-`#`
- `ENTRY_MAX_FAILURES=3`: pool di-`#` setelah gagal entry sebanyak ini
- `POOL_LIST_FILE=pool.txt`
- `SPOT_INDICATOR_EXIT=immediate`: posisi spot langsung close saat sinyal indikator (RSI+MACD / RSI+BB). Isi `trailing` untuk perilaku lama (arm trailing dulu). BidAsk tidak terpengaruh.
- `DCA_TRIGGER_MODE=price`: DCA `bidask:double` meng-arm dari turunnya harga pool vs harga entry posisi utama (`DCA_ARM_PRICE_PCT=-20`, DCA kedua `DCA_ARM_PRICE_PCT_2=-35`). Isi `pnl` untuk kembali ke pemicu PnL lama. Posisi lama tanpa harga entry ikut mode PnL.
- `BIDASK_DOUBLE_MIN_BIN_STEP=100`: entry `bidask:double` hanya ke pool dengan bin step minimal 100. Yang dipilih di antara yang lolos = fee/active TVL 30m tertinggi. Tidak ada yang lolos = lewati siklus itu, baris tidak diberi `#`. `0` mematikan aturan ini. Spot tidak kena. DCA tetap di pool posisi yang sudah terbuka.
- `BIDASK_DOUBLE_REBALANCE_ENABLED=true`: saat harga pool turun kelipatan 10% dari harga entry tiap posisi `bidask:double` (utama dan tiap DCA), token di atas bin aktif dibentuk ulang jadi BidAsk di posisi yang sama. `false` mematikan sisi token dan sisi SOL.
- `BIDASK_DOUBLE_SOL_REBALANCE_ENABLED=true`: saat harga pulih minimal satu step dari rebalance terakhir, SOL di bawah bin aktif dibentuk ulang jadi BidAsk. `false` hanya mematikan sisi SOL.
- `BIDASK_SOL_REBALANCE_ENABLED=true`: posisi `bidask:sol` (SOL-only) tiap kelipatan 10% porsi bin token dibentuk ulang sisi tokennya saja jadi BidAsk. Bin yang masih SOL tidak disentuh, dan tidak ada rebalance sisi SOL saat harga pulih.
- `BIDASK_SOL_ENTRY_MIN_TVL_USD=20000`, `BIDASK_SOL_ENTRY_MAX_BINS=169`, `BIDASK_SOL_ENTRY_LOWER_PCT=-50`, `BIDASK_SOL_ENTRY_UPPER_PCT=15`, `BIDASK_SOL_ENTRY_PRESETS=-50/15,-30/15,-20/15`: entry manual `bidask:sol` dari `pool.txt`. Arah sentuh dicatat dari harga pertama: di bawah target bot menunggu harga naik, di atas target menunggu harga turun, tepat di target langsung masuk. Token `now` masuk begitu harga terbaca, tanpa menunggu sentuh. Lalu bot memilih pool DLMM token/SOL (TVL dan lebar bin lolos) dan membuka posisi SOL-only. Kolom ke-7 opsional menimpa rentang default. Setelah entry berhasil baris itu diberi `#`.
- `REBALANCE_MODE=inplace`: semua rebalance (spot token, spot SOL, bidask token, bidask SOL) memakai instruksi di tempat, jadi saldo yang sudah ada di wallet tidak ikut masuk. `withdraw` kembali ke tarik-lalu-setor, hanya sejumlah yang keluar dari posisi.
- Swap ke SOL saat close: token base **dan** reward di-swap ke SOL, kecuali mint yang dilindungi (posisi aktif, entry/rebalance/reentry OOR kanan/fallback OOR kiri yang sedang berjalan, USDC). Swap gagal → "swap tertunda", dicoba ulang tiap `SWAP_PENDING_RETRY_SEC` (90s); pool baru ditandai `#` setelah swap tuntas atau dihentikan (alert Telegram). Safety sweep juga memindai token Token-2022.

## `pool.txt`
Satu pool per baris, formatnya `address,size[,max],mode[,ca[,harga[,rentang]]]`. Hanya `address` yang wajib. Kolom `max` (jumlah entry seumur hidup) **diabaikan** — baris lama `address,size,max,mode` tetap valid.

File ini gitignored. Contoh yang ikut commit: `pool.txt.example`. Saat entry worker jalan, bot menulis blok komentar yang sama di antara `# === FORMAT (dikelola bot) ===` dan `# === END FORMAT ===` di puncak `pool.txt` (atau menggantinya bila teks berubah). Baris di luar blok itu tidak diubah.

| Kolom | Nilai | Default |
|---|---|---|
| `size` | angka SOL, `1x`, `1.25x`, `1.5x`, `tier1`/`tier2`/`tier3` (kali `ENTRY_DEFAULT_SIZE_SOL`) | `1x` (0.1 SOL) |
| `max` | kolom lama, tidak dipakai | — |
| `mode` | `bidask:double` (atau `bidask`), `spot`, `bidask:sol` | `bidask:double` |
| kolom ke-5 | `ca` = kolom pertama adalah **CA token (mint)**, bukan pool | kosong (alamat pool) |
| kolom ke-6 | harga per token. Wajib untuk `bidask:sol`. Opsional untuk `bidask:double` (kosong = Supertrend saja). Tanpa akhiran atau `usd` = USD. Akhiran `sol` = SOL per token. `now` hanya untuk `bidask:sol` | — |
| kolom ke-7 | rentang `bidask:sol`, `bawah/atas` (contoh `-30/15`). Bawah −99..−1, atas 0..100. Tidak valid = baris dilewati | `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT` |

```
PoolAddr1                       # bidask:double, 0.1 SOL
PoolAddr2,0.5                   # 0.5 SOL, bidask:double
PoolAddr2,0.5,,bidask:double,,0.0012       # bidask:double + target USD (kolom ke-5 kosong)
PoolAddr3,1.25x,1,spot          # spot, 0.125 SOL (angka max diabaikan)
TokenMint,1.5x,1,spot,ca        # baris CA: pool dipilih bot saat entry
TokenMint,1x,,bidask:double,ca,0.0000379sol # target SOL, lalu Supertrend
TokenMint,1x,,bidask:sol,ca,0.00123        # USD per token (sama dengan 0.00123usd)
TokenMint,1x,,bidask:sol,ca,0.0000379sol   # SOL per token, masuk saat harga menyentuh level itu
TokenMint,1x,,bidask:sol,ca,now            # masuk di harga pasar, tanpa target
TokenMint,1x,,bidask:sol,ca,now,-30/15     # rentang −30% / +15% (kolom ke-7 opsional)
TokenMint,1x,,bidask:sol,ca,0.0000379sol,-20/15
```

`bidask:sol` hanya valid bersama `ca` dan harga positif. Harga tanpa akhiran, atau berakhiran `usd` (huruf besar/kecil), adalah USD per token. Akhiran `sol` adalah SOL per token. Akhiran lain, nol, atau negatif membuat baris dilewati (ada peringatan). Tidak ada gerbang Supertrend. Pemicu USD membandingkan harga Jupiter token. Pemicu SOL membandingkan harga token USD dibagi harga SOL (WSOL, satu batch Jupiter yang sama). Harga SOL yang tidak ada atau tidak valid tidak memicu dan tidak mencatat arah.

Masuknya memakai sentuh. Arah dicatat dari harga valid pertama untuk pasangan mint + target + satuan (mengubah harga menghapus arah lama). Arah itu tersimpan di state dan tahan restart:

- harga di bawah target → arah `naik`, masuk saat harga naik sampai target (`>=`)
- harga di atas target → arah `turun`, masuk saat harga turun sampai target (`<=`)
- harga tepat di target → masuk sekarang
- harga belum terbaca → tidak ada arah, tidak masuk

Contoh: harga sekarang `0.00002953` SOL dan target `0.0000379sol` menunggu naik dulu. Log dan ringkasan menulis `menunggu naik ke 0.0000379 SOL (sekarang 0.00002953)`.

Token `now` (huruf besar/kecil, baris `CA,,,bidask:sol,ca,now`) tidak memakai sentuh. Begitu harga Jupiter terbaca, bot memilih pool dan membuka posisi pada siklus itu. Harga sekarang tidak ditulis sebagai target, jadi pergerakan kecil tidak menunda entry. Kalau pool, sewa, duplikat, atau saldo membuat entry dilewati, baris tetap aktif. Tanpa kolom ke-7, rentang −50%/+15% dihitung dari harga bin aktif saat posisi dibuka. Kolom ke-7 (misalnya `-30/15`) dipakai untuk jumlah bin, saringan `BIDASK_SOL_ENTRY_MAX_BINS`, urutan pool, quote sewa, dan range posisi. Angka itu disimpan di state posisi; re-entry memakai offset bin yang tersimpan, atau persen itu bila offset hilang.

Saat harga sudah menyentuh target, bot memilih pool DLMM token/SOL (bukan blacklist, TVL >= `BIDASK_SOL_ENTRY_MIN_TVL_USD`, lebar bin <= `BIDASK_SOL_ENTRY_MAX_BINS`) berdasarkan fee/active TVL, lalu volume/TVL, lalu jumlah bin lebih sedikit. Tidak ada yang lolos = tetap menunggu, baris tidak diberi `#`. Setelah entry berhasil, baris itu (termasuk baris CA 6 kolom berakhiran `sol`) diberi `#`, jadi tidak masuk lagi setelah posisi tutup. Hapus `#` untuk memantau lagi. Posisi SOL-only BidAsk: bin bawah dan atas dari kolom ke-7 bila ada, kalau tidak dari `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT` (default −50% / +15%), setoran hanya sampai bin aktif. Setelah terbuka, exit / rebalance / re-entry sama seperti `bidask:sol` yang sudah ada. Log, ringkasan, dan alert Telegram menampilkan harga beserta satuannya (`$0.0012` atau `0.0000379 SOL`), dan rentang posisi dalam satuan yang sama.

`bidask:double` boleh menambah harga target di kolom ke-6. Kosong = Supertrend saja, seperti sebelumnya. Satuan sama dengan `bidask:sol` (tanpa akhiran atau `usd` = USD per token, akhiran `sol` = SOL per token). Baris alamat pool mengosongkan kolom ke-5: `POOL,size,,bidask:double,,HARGA`. Baris CA tetap `ca` di kolom ke-5. `now` atau harga tidak valid membuat baris dilewati.

Sentuhnya sama: harga pertama di bawah target menunggu naik, di atas target menunggu turun, tepat di target langsung mengunci. Harga yang belum terbaca tidak mengunci. Setelah tersentuh, statusnya terkunci (armed) dan tahan restart walau harga menjauh. Sebelum armed, sinyal Supertrend tidak membuka posisi. Setelah armed, pilihan pool, sewa, duplikat, saldo, kuota, dan syarat Supertrend tidak berubah. Lognya: `target tersentuh, menunggu Supertrend`. Mengubah target, atau menghapus / memberi `#` pada baris, menghapus arah dan armed.

Setelah entry `bidask:double` berhasil, baris tidak diberi `#`. Arah dan armed direset, jadi masuk lagi harus menyentuh target dulu (harga pertama setelah reset menentukan arah baru). Kalau harga tepat sama dengan target, itu langsung armed lagi.

Gerbang masuk hanya tanda `#`. Untuk mode selain `bidask:sol`, selama baris tidak dikomentari bot boleh masuk lagi setelah posisi sebelumnya tutup. `bidask:sol` dikomentari begitu entry berhasil. Kuota yang tersisa: paling banyak **1 posisi non-DCA per strategi per pool**. `spot` dan `bidask` (`bidask:double`, `bidask:token`, `bidask:sol`) masing-masing punya slot, jadi satu spot dan satu bidask boleh terbuka di pool yang sama. Dua spot atau dua bidask tidak. Posisi DCA tidak memakan slot bidask.

Baris CA (`,ca`):
- Saat entry, bot mengambil semua pool DLMM X/SOL token itu dari Meteora (`pool-discovery-api`, timeframe 30m, cache `CA_POOL_CACHE_SEC`=60s) dan memilih **fee/active TVL 30m tertinggi**, tanpa filter tambahan (penyaringan sudah dilakukan worker). Tidak ada pool X/SOL = skip siklus itu (log maksimal 1x per CA per 10 menit).
- Pool hasil pilihan disimpan di state posisi dan di `runtime-state.json` (`poolAliases`), sehingga exit, re-entry/OOR kanan (termasuk pindah pool), dan DCA tetap memakai pool itu.
- Saat posisi selesai/dinonaktifkan, **baris CA** yang diberi `#`, sama seperti baris pool.
- Baris CA biasanya ditulis otomatis oleh Runner Alert / meteora-pool-monitor (lihat [setup.md](setup.md)), tapi bisa juga ditulis manual.
- Baris yang diawali `#` dilewati.
- Bot otomatis memberi `#` pada pool yang sudah selesai (entry+exit), gagal `ENTRY_MAX_FAILURES` kali, bukan pair SOL, atau kedaluwarsa tanpa entry.
- File ini dibaca ulang tiap siklus refresh kandidat. Menghapus `#` saat `meteorabot-entry` sedang jalan cukup — tidak perlu restart. Gate di memori (cooldown gagal, timer kedaluwarsa, pool yang sempat di-skip) ikut dibersihkan saat baris itu aktif lagi.
- Setelah **deploy** kode baru, restart proses yang memuatnya (`pm2 restart ecosystem.config.cjs`, atau minimal `meteorabot-entry` dan `meteorabot-exit`). Menghapus `#` setelah proses baru jalan tidak perlu restart lagi.

## Entry bot Telegram

Proses PM2 terpisah, `meteorabot-entrybot` (`src/worker-entrybot.js`). Ini bot Telegram lain, bukan `meteorabot-telegram`, karena satu bot cuma boleh satu konsumen `getUpdates`.

Entry bot **tidak membuka posisi**. Dia menulis satu baris ke `pool.txt` lalu memantau sampai worker entry yang sudah ada yang mengerjakan. Ukuran Default mengosongkan kolom size, jadi `ENTRY_DEFAULT_SIZE_SOL` yang dipakai. Angka tetap (default 0.5, 1, 2, dari `ENTRYBOT_SIZE_OPTIONS` di `strat.conf`) ditulis di kolom itu. Pilih pool, cek sewa, saldo, Supertrend, dan sentuh harga tetap di jalur entry.

Perintah, di chat yang diizinkan:

- `/entry` — pilih Bidask SOL, Bidask Double, atau Spot, lalu kirim CA. Bidask SOL menampilkan harga sekarang, tombol Entry sekarang atau Harga target, lalu preset rentang (`BIDASK_SOL_ENTRY_PRESETS`, default −50%/+15%, −30%/+15%, −20%/+15%). Bidask Double menampilkan tombol Langsung pantau Supertrend atau Harga target (format sama dengan Bidask SOL). Semua strategi lalu memilih ukuran: Default (kolom size kosong, jadi `ENTRY_DEFAULT_SIZE_SOL`) atau angka di `ENTRYBOT_SIZE_OPTIONS` (default 0.5, 1, 2), baru konfirmasi. Ringkasan, antrean, dan notifikasi sukses menampilkan ukuran itu. Ringkasan Bidask SOL menampilkan rentang dan calon pool. Bidask Double tanpa target: `tunggu sinyal Supertrend`. Dengan target: `tunggu harga naik/turun sampai target, lalu tunggu sinyal Supertrend`. Saat target tersentuh, entry bot mengirim status antara, lalu notifikasi sukses atau skip yang sudah ada.
- `/antrean` — daftar baris aktif. Yang dari entry bot ditandai. Tombol hapus memberi `#` pada baris itu.
- `/batal` — batalkan wizard yang sedang jalan (sekitar 10 menit, lalu sesi hangus).

Baris yang ditulis: `CA,,,bidask:sol,ca,HARGA,-30/15` (akhiran harga dipertahankan, kolom rentang dari preset), `CA,,,bidask:sol,ca,now,-50/15`, `CA,,,bidask:double,ca`, `CA,,,bidask:double,ca,HARGA`, `CA,0.5,,spot,ca`, atau `CA,,,spot,ca` bila ukuran Default. Notifikasi entry berhasil menyebut rentang Bidask SOL dan ukuran yang dipilih.

Buat botnya di Telegram lewat [@BotFather](https://t.me/BotFather):

1. `/newbot`, ikuti nama yang diminta, simpan token.
2. Tempel token ke `ENTRYBOT_TELEGRAM_TOKEN` di `.env` (jangan di-commit).
3. `ENTRYBOT_TELEGRAM_CHAT_ID` boleh kosong kalau chat-nya sama dengan `TELEGRAM_CHAT_ID`.
4. `pm2 start ecosystem.config.cjs --only meteorabot-entrybot` (atau restart sekalian).
5. Kalau token kosong, proses tetap hidup tapi idle: dia log lalu tidak mem-poll.

State antrean ada di `state/entrybot.json` (gitignored, ikut folder `state/`).

## Jalankan (PM2)
```bash
pm2 start ecosystem.config.cjs    # meteorabot-entry, meteorabot-exit, meteorabot-wallet, meteorabot-telegram, meteorabot-entrybot
pm2 save && pm2 startup
npm run pm2:logrotate             # opsional: rotasi log
```
Log:
```bash
pm2 logs meteorabot-entry         # juga: meteorabot-exit, meteorabot-wallet, meteorabot-telegram, meteorabot-entrybot
ls logs/                          # entry-out.log, exit-error.log, telegram-out.log, entrybot-out.log, dst.
```

## Update
```bash
cd ~/meteorabot-v3 && git pull && npm install && pm2 restart ecosystem.config.cjs
```
`git pull` tidak mengubah `strat.conf`.
