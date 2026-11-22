# Pasang meteorabot-v3

Panduan ini memasang bot inti di VPS: proses yang memantau daftar, membuka dan menutup posisi, mengawasi wallet, dan menerima ketukan tombol Telegram.

Bot opsional yang menambah baris lewat Telegram ada di [worker-setup.md](worker-setup.md). Ringkasan untuk orang non-teknis ada di [README.md](README.md). Peta folder ada di [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

Jangan pernah menaruh kunci wallet, token Telegram, atau API key di git, di chat, atau di tangkapan layar.

## Yang perlu ada

- VPS Linux (Ubuntu) yang tetap menyala, dengan internet keluar ke RPC Solana, Jupiter, GMGN, Meteora, dan Telegram.
- Wallet Solana berisi SOL untuk posisi dan biaya jaringan.
- Akun RPC (Helius atau penyedia lain), API key GMGN (data harga untuk sinyal tren), dan API key Jupiter (harga dan swap).
- Satu bot Telegram untuk notifikasi dan tombol. Bot kedua, untuk menambah antrean, tidak wajib. Cara buatnya ada di [worker-setup.md](worker-setup.md).

## 1. Pasang Node 24, git, dan pm2

Bot wajib Node.js 24.x. Versi lain bisa gagal saat program dijalankan.

```bash
sudo apt update && sudo apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
sudo npm install -g pm2
pm2 -v
```

`node -v` harus menampilkan `v24` di depannya, misalnya `v24.22.3`. Kalau yang muncul `v18`, `v20`, atau `v22`, langkah Node di atas belum mengganti versi yang dipakai.

## 2. Clone dan pasang paket

```bash
git clone https://github.com/nodepedia/meteorabot-v3.git ~/meteorabot-v3
cd ~/meteorabot-v3
npm ci
```

`npm ci` memasang versi yang terkunci di `package-lock.json`, lalu menjalankan `scripts/patch-anchor.js`. Perintah itu harus selesai tanpa error. Kalau nanti muncul error impor Anchor atau DLMM, jalankan `npm ci` lagi dari folder ini.

## 3. Isi `.env`

`.env` menyimpan rahasia mesin ini. File itu tidak ikut git.

```bash
cd ~/meteorabot-v3
cp .env.example .env
chmod 600 .env
nano .env
```

Di nano: panah untuk pindah baris, ketik nilai di kanan tanda `=`. Simpan dengan `Ctrl+O` lalu Enter. Keluar dengan `Ctrl+X`.

Jangan menyalin nilai sungguhan ke dokumen atau chat. Isi hanya di `.env` di VPS.

| Variabel | Arti |
|---|---|
| `WALLET_PRIVATE_KEY` | Kunci rahasia wallet. Boleh teks base58, atau deretan angka JSON (array byte). Kosong: proses inti langsung berhenti. |
| `RPC_URL` | Alamat RPC Solana. Kalau diisi, ini yang dipakai. |
| `HELIUS_API_KEY` | Dipakai hanya bila `RPC_URL` kosong, untuk menyusun alamat `https://rpc.helius.xyz/?api-key=...`. Kalau keduanya kosong, bot jatuh ke RPC publik mainnet. Itu tidak cocok untuk bot yang jalan terus. |
| `GMGN_API_KEY` | Kunci GMGN untuk candle yang dipakai sinyal Supertrend. |
| `JUPITER_API_KEY` | Cadangan. Dipakai untuk harga bila `JUPITER_PRICE_API_KEY` kosong, dan untuk swap bila `JUPITER_SWAP_API_KEY` kosong. |
| `JUPITER_PRICE_API_KEY` | Kunci khusus membaca harga. |
| `JUPITER_SWAP_API_KEY` | Kunci khusus swap. |
| `DRY_RUN` | `true` = latihan: tidak mengirim transaksi sungguhan. `false` = live, uang sungguhan. Nilai selain `false` (termasuk kosong) tetap latihan. Biarkan `true` sampai log dan daftar pool sudah benar. |
| `TELEGRAM_BOT_TOKEN` | Token bot notifikasi, dari @BotFather. Bukan token bot antrean. |
| `TELEGRAM_CHAT_ID` | Chat yang menerima notifikasi dan yang boleh menekan tombol. |
| `ENTRYBOT_TELEGRAM_TOKEN` | Token bot Telegram kedua untuk `/entry`. Kosongkan sampai Anda mengikuti [worker-setup.md](worker-setup.md). |
| `ENTRYBOT_TELEGRAM_CHAT_ID` | Chat untuk bot antrean. Kosong = pakai `TELEGRAM_CHAT_ID`. |

`TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` perlu diisi sebelum proses tombol dijalankan. Cara mengambil chat id dijelaskan di [worker-setup.md](worker-setup.md) (langkahnya sama: kirim pesan ke bot, lalu buka `getUpdates`).

## 4. Salin `strat.conf`

`strat.conf` adalah setelan strategi di mesin ini (ukuran, batas waktu, rebalance, dan sebagainya). File itu tidak ikut git. `git pull` tidak menimpanya.

```bash
cd ~/meteorabot-v3
cp strat.conf.example strat.conf
```

Lakukan sekali, saat pertama pasang. Jangan commit `strat.conf`.

Urutannya:

- Kunci yang sama di `strat.conf` dan `.env`: nilai `strat.conf` yang dipakai.
- `strat.conf` belum punya kunci yang ada di `strat.conf.example`: bot memakai angka default di kode (disamakan dengan contoh) dan menulis nama kuncinya **sekali** saat proses mulai, di log: `[strat] Kunci ini tidak ada di strat.conf, memakai default: ...`
- Tidak ada `strat.conf` sama sekali: bot memakai `strat.conf.example` dan memperingatkan: `[strat] strat.conf tidak ditemukan. Memakai strat.conf.example. ...`
- Kunci baru muncul di `strat.conf.example` setelah `git pull`. Salin kunci itu ke `strat.conf` hanya bila Anda ingin mengubah angkanya. Jangan menimpa seluruh `strat.conf` dengan contoh, karena tuning Anda hilang.

Komentar di `strat.conf.example` menjelaskan tiap kunci. Yang paling sering disentuh:

| Kunci | Contoh | Arti singkat |
|---|---|---|
| `ENTRY_DEFAULT_SIZE_SOL` | `0.1` | SOL untuk baris yang tidak menulis ukuran. |
| `ENTRY_EXPIRY_HOURS` | `24` | Baris yang tidak masuk dalam sekian jam diberi `#` (saat live). |
| `ENTRY_MAX_FAILURES` | `3` | Setelah gagal entry sebanyak ini, baris diberi `#`. |
| `POOL_LIST_FILE` | `pool.txt` | Nama file daftar. |
| `ENTRY_TIMEFRAME` | `15m` | Candle untuk sinyal Supertrend. |
| `ENTRY_TOUCH_MODE` | `held_pullback` | Cara sinyal tren dipakai. `first_touch` = masuk saat harga menyentuh garis saat tren naik. |
| `SPOT_INDICATOR_EXIT` | `immediate` | Spot menutup saat sinyal indikator. `trailing` = mengikuti kenaikan dulu. |
| `DCA_TRIGGER_MODE` | `price` | Tambah posisi (average-down) hanya untuk bidask double, dari turunnya harga. |
| `BIDASK_DOUBLE_MIN_BIN_STEP` | `100` | Bidask double hanya ke pool dengan jarak bin minimal ini. `0` mematikan saringan. Spot tidak kena. |
| `BIDASK_SOL_ENTRY_MIN_TVL_USD` | `20000` | TVL minimum pool saat entry SOL-only. |
| `BIDASK_SOL_ENTRY_MAX_BINS` | `169` | Lebar posisi SOL-only maksimum. |
| `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT` | `-50` / `15` | Rentang default SOL-only bila baris tidak menulis kolom rentang. |
| `BIDASK_SOL_ENTRY_PRESETS` | `-50/15,-30/15,-20/15` | Tombol rentang di bot antrean. |
| `ENTRYBOT_SIZE_OPTIONS` | `0.5,1,2` | Tombol ukuran di bot antrean, selain Default. |
| `REBALANCE_MODE` | `inplace` | Bentuk ulang posisi di tempat. `withdraw` menarik ke wallet lalu menyetor lagi. |
| `TELEGRAM_BUTTONS_ENABLED` | `true` | `false` = pesan status tanpa tombol. |
| `SWAP_PENDING_RETRY_SEC` | `90` | Jeda coba lagi bila swap sisa token gagal. |

Saat posisi ditutup, bot menukar token sisa (termasuk reward) ke SOL, kecuali mint yang sedang dilindungi dan USDC. Detailnya ada di komentar bagian swap di `strat.conf.example`.

## 5. Buat `pool.txt`

`pool.txt` adalah daftar yang dipantau. File itu tidak ikut git. Saat proses entry jalan, bot menulis ulang blok penjelasan di antara `# === FORMAT (dikelola bot) ===` dan `# === END FORMAT ===`. Jangan mengedit isi blok itu. Baris di luar blok tidak diubah oleh penulisan header.

```bash
cd ~/meteorabot-v3
cp pool.txt.example pool.txt
```

Satu baris = satu target. Kolom dipisah koma:

`alamat_atau_CA, size, (kolom ke-3 diabaikan), mode, ca, harga_entry, rentang`

Hanya kolom pertama yang wajib. Mode kosong berarti `bidask:double`.

| Kolom | Isi |
|---|---|
| 1 | Alamat pool, atau alamat token (mint / CA) bila kolom ke-5 berisi `ca`. |
| 2 | Ukuran. Angka = SOL tetap (`0.5`). `1x`, `1.25x`, `1.5x` dikali `ENTRY_DEFAULT_SIZE_SOL` (jadi `1x` = 0.1 SOL bila default 0.1). `tier1` = 1x, `tier2` = 1.25x, `tier3` = 1.5x. Kosong = default. |
| 3 | Bekas batas jumlah entry. Diabaikan. Boleh dikosongkan. |
| 4 | `spot`, `bidask:double` (atau `bidask`), atau `bidask:sol`. |
| 5 | `ca` bila kolom pertama adalah token, bukan pool. Kosong bila kolom pertama alamat pool. Nilai lain membuat baris dilewati. |
| 6 | Harga per token. Wajib untuk `bidask:sol`. Opsional untuk `bidask:double`. Tanpa akhiran atau `usd` = USD per token. Akhiran `sol` = SOL per token. `now` hanya untuk `bidask:sol`. |
| 7 | Rentang `bidask:sol` saja, bentuk `bawah/atas`, contoh `-30/15`. Bawah dari -99 sampai -1, atas dari 0 sampai 100. Kosong = `BIDASK_SOL_ENTRY_LOWER_PCT` / `UPPER_PCT`. Di luar batas itu, baris dilewati. |

Contoh yang sama dengan header bot:

```text
POOL_ADDRESS,1x,,spot
TOKEN_CA,1x,,spot,ca
POOL_ADDRESS,0.5,,bidask:double
POOL_ADDRESS,0.5,,bidask:double,,0.0012
TOKEN_CA,1.25x,,bidask:double,ca
TOKEN_CA,1x,,bidask:double,ca,0.0000379sol
TOKEN_CA,1x,,bidask:sol,ca,0.00123
TOKEN_CA,1x,,bidask:sol,ca,0.00123usd
TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol
TOKEN_CA,1x,,bidask:sol,ca,now
TOKEN_CA,1x,,bidask:sol,ca,now,-30/15
TOKEN_CA,1x,,bidask:sol,ca,0.0000123sol,-20/15
```

Ganti `POOL_ADDRESS` dan `TOKEN_CA` dengan alamat sungguhan. Jangan menaruh catatan di baris yang sama. Baris yang diawali `#` diabaikan.

### Kapan bot masuk

**Spot.** Menunggu sinyal Supertrend (tren naik pada candle `ENTRY_TIMEFRAME`). Tidak ada harga target.

**Bidask double.** Kolom harga kosong = hanya Supertrend. Kolom harga terisi = harga pertama menentukan arah, lalu baru Supertrend:

- harga di bawah target menunggu naik sampai target, lalu sinyal
- harga di atas target menunggu turun sampai target, lalu sinyal
- harga tepat di target langsung siap menunggu sinyal
- harga belum terbaca = belum siap, tidak masuk

Setelah tersentuh, status itu tetap tersimpan walau harga menjauh, termasuk setelah restart. Sebelum tersentuh, sinyal Supertrend tidak membuka posisi. `now` atau harga tidak valid membuat baris dilewati. Kolom ke-7 tidak dipakai. Mengubah target, atau menghapus / memberi `#` pada baris, menghapus arah itu.

**Bidask SOL.** Wajib `ca` plus harga positif atau `now`. Tidak memakai Supertrend. Arah sentuh disimpan dan tahan restart:

- di bawah target menunggu naik sampai `>=` target
- di atas target menunggu turun sampai `<=` target
- tepat di target masuk sekarang
- harga belum terbaca belum masuk dan belum menyimpan arah
- `now` masuk begitu harga terbaca. Harga saat itu tidak disimpan sebagai target

Satuan `sol` membandingkan harga token dalam SOL. Satuan USD membandingkan harga token dalam USD. Harga SOL yang gagal dibaca tidak memicu. Setelah harga cocok, bot memilih pool token/SOL (TVL dan lebar bin lolos). Tidak ada yang lolos = baris tetap menunggu.

### Tanda `#` dan kuota

Saat live (bukan `DRY_RUN`):

- Entry `bidask:sol` yang berhasil memberi `#` pada baris itu, jadi tidak masuk lagi. Hapus `#` untuk memantau lagi.
- Entry spot atau bidask double yang berhasil **tidak** memberi `#`. Baris tetap aktif. Bidask double dengan target harus menyentuh target lagi sebelum masuk berikutnya.
- Baris juga bisa diberi `#` bila kedaluwarsa tanpa entry, gagal entry sampai `ENTRY_MAX_FAILURES`, pair-nya bukan SOL, harga pool terus meleset, atau posisi hilang dari chain dan tidak ada posisi lain di pool itu.

`DRY_RUN=true` tidak menulis `#` ke `pool.txt`.

Di satu pool, paling banyak satu posisi spot dan satu posisi bidask (double, token, atau SOL berbagi slot bidask). Dua spot atau dua bidask tidak dibuka bersamaan. Tambahan average-down tidak memakai slot itu.

File dibaca ulang tiap siklus. Menghapus `#` saat `meteorabot-entry` sedang jalan sudah cukup, tanpa restart. Jangan membiarkan `pool.txt` terbuka di editor lalu disimpan saat bot jalan: simpanan editor bisa menimpa tanda `#` yang baru ditulis bot.

## 6. Jalankan empat proses inti

Dari folder repo:

```bash
cd ~/meteorabot-v3
pm2 start ecosystem.config.cjs --only meteorabot-entry,meteorabot-exit,meteorabot-wallet,meteorabot-telegram
pm2 status
pm2 save
pm2 startup
```

`pm2 startup` mencetak satu perintah yang diawali `sudo`. Salin perintah itu, jalankan, lalu `pm2 save` sekali lagi. Tanpa itu, proses tidak bangkit setelah VPS reboot.

`pm2 status` untuk keempat nama itu harus `online`.

| Proses | Tugas |
|---|---|
| `meteorabot-entry` | Membaca `pool.txt`, menunggu sinyal atau harga, membuka posisi, dan average-down bidask double. |
| `meteorabot-exit` | Mengawasi posisi: ambil untung, bentuk ulang, tutup, dan menjalankan ketukan tombol. |
| `meteorabot-wallet` | Mengawasi wallet dan menukar sisa token ke SOL. |
| `meteorabot-telegram` | Mendengarkan ketukan tombol. Tidak membuka atau menutup posisi sendiri. |

Jangan menjalankan `npm start` bersamaan. Perintah itu menjalankan entry dan exit dalam satu proses lagi, jadi bot jadi dobel.

Proses kelima, `meteorabot-entrybot`, tidak ikut perintah `--only` di atas. Cara menyalakannya ada di [worker-setup.md](worker-setup.md).

## 7. Cek log

```bash
pm2 logs meteorabot-entry --lines 40
pm2 logs meteorabot-exit --lines 20
pm2 logs meteorabot-wallet --lines 20
pm2 logs meteorabot-telegram --lines 20
ls logs/
```

Yang diharapkan saat latihan:

- Entry: `Meteora Worker [1/3]: ENTRY + DCA` dan `Mode: DRY RUN`.
- Exit: `Meteora Worker [2/3]: EXIT MONITOR` dan `Mode: DRY RUN`.
- Wallet: `Meteora Worker [3/3]: WALLET & SWEEP` dan `Mode: DRY RUN`.
- Telegram: `Meteora Worker: TELEGRAM BUTTONS` dan `Tombol: ON`.

File di `logs/` antara lain `entry-out.log`, `entry-error.log`, `exit-out.log`, `exit-error.log`, `wallet-out.log`, `wallet-error.log`, `telegram-out.log`, `telegram-error.log`.

`Ctrl+C` hanya menutup tampilan log, tidak mematikan bot.

## 8. Tombol di pesan status

Tombol hanya muncul di pesan rutin Position Status, dan hanya bila `TELEGRAM_BUTTONS_ENABLED` bukan `false`. Alert entry, exit, dan rebalance tidak membawa tombol.

- `♻️` lalu nama token: bentuk ulang. Lalu pilih `Token`, `SOL`, atau `Batal`. Memilih sisi langsung mengantre.
- `⚡` lalu nama token: tutup posisi (Zap Out). Lalu `✅ Ya, zap out ...` atau batal.
- Posisi token-only (`bidask:token`) hanya punya tombol tutup.
- Nama lebih panjang dari 10 karakter: satu tombol per baris.

Ketukan mengubah tombol di pesan yang sama dan menampilkan toast. Tidak ada pesan baru. Proses exit yang mengerjakan antrean. Perintah yang lebih lama dari 10 menit, atau posisi yang sudah hilang, tidak dijalankan. Bila sisi yang dipilih kosong, pesannya `Tidak ada yang bisa di-rebalance di sisi itu`.

Cara menekan tombol, langkah demi langkah, ada di [worker-setup.md](worker-setup.md#tombol-di-pesan-status).

## 9. Update

```bash
cd ~/meteorabot-v3
git pull
npm ci
pm2 restart meteorabot-entry meteorabot-exit meteorabot-wallet meteorabot-telegram
```

`git pull` tidak mengubah `.env`, `strat.conf`, atau `pool.txt`. Setelah pull, lihat log startup. Bila ada baris `[strat] Kunci ini tidak ada di strat.conf`, kunci baru itu memakai default. Salin dari `strat.conf.example` ke `strat.conf` bila Anda ingin mengatur angkanya sendiri, lalu restart lagi.

## 10. Masalah yang sering muncul

| Yang terlihat | Artinya | Yang dilakukan |
|---|---|---|
| `node -v` bukan v24 | Node salah | Ulangi langkah 1. `npm ci` lagi setelah Node 24 aktif. |
| `WALLET_PRIVATE_KEY is not set — exiting` dan status `errored` / restart terus | `.env` kosong atau proses belum di-restart setelah diisi | Isi kunci, lalu `pm2 restart meteorabot-entry meteorabot-exit meteorabot-wallet`. |
| `TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID kosong — worker telegram berhenti` | Proses tombol tidak punya token atau chat | Isi keduanya di `.env`, lalu `pm2 restart meteorabot-telegram`. |
| `Telegram getUpdates failed: 409` dan kata `Conflict` | Dua program membaca update bot yang sama | Token notifikasi hanya untuk `meteorabot-telegram`. Bot antrean wajib token lain. Lihat [worker-setup.md](worker-setup.md). |
| `[strat] strat.conf tidak ditemukan` | Contoh yang dipakai, bukan file lokal | `cp strat.conf.example strat.conf`, lalu restart. |
| `[strat] Kunci ini tidak ada di strat.conf` | Kunci itu memakai default. Bukan error | Salin kunci dari contoh bila ingin mengubahnya. |
| Log entry `skipped:` pada satu baris | Format baris tidak diterima | Cocokkan dengan contoh di bagian 5. |
| Masih `Mode: DRY RUN` padahal ingin live | `DRY_RUN` bukan `false` | Set `DRY_RUN=false`, simpan `.env`, restart keempat proses. |
| Setelah reboot tidak ada proses | `pm2 startup` atau `pm2 save` belum selesai | Ulangi akhir langkah 6. |
| Tanda `#` yang ditulis bot hilang | `pool.txt` tersimpan dari editor yang masih membuka salinan lama | Tutup editor. Jangan menyimpan file itu saat bot jalan. |
