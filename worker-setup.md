# Worker opsional dan tombol Telegram

Panduan ini untuk pemula. Ikuti nomornya dari atas. Perintah diketik di VPS, di folder bot (`~/meteorabot-v3`), kecuali dikatakan lain.

Bot inti (membuka dan menutup posisi) harus sudah jalan. Kalau belum, selesaikan [setup.md](setup.md) dulu, termasuk `DRY_RUN=true` untuk latihan.

Yang dibahas di sini:

1. **Bot antrean** (`meteorabot-entrybot`) — opsional. Ia hanya menambah baris ke daftar pantauan. Ia tidak membuka posisi.
2. **Tombol di pesan status** — bukan worker opsional. Prosesnya (`meteorabot-telegram`) sudah dijalankan di [setup.md](setup.md). Bagian akhir halaman ini menjelaskan cara menekan tombolnya.

Repo lain yang mengisi daftar dari luar tidak dibahas di sini.

## Kenapa bot-nya harus beda

Telegram hanya mengizinkan **satu** program yang "mendengarkan" tiap bot. Program itu memakai panggilan `getUpdates`.

Bot notifikasi (`TELEGRAM_BOT_TOKEN`) sudah didengarkan oleh `meteorabot-telegram`, supaya ketukan tombol sampai. Kalau bot antrean memakai token yang sama, Telegram menolak salah satunya. Di log proses tombol muncul:

```text
Telegram getUpdates failed: 409
```

dan teks `Conflict`. Perintah `/entry` lalu tidak dibalas. Solusinya: buat bot kedua di @BotFather, dan taruh tokennya di `ENTRYBOT_TELEGRAM_TOKEN`.

## 1. Buat bot di Telegram

1. Buka Telegram. Cari `@BotFather` dan buka chat resmi itu.
2. Kirim:

   ```text
   /newbot
   ```

3. BotFather meminta **nama**. Ini nama yang tampil, boleh ada spasi. Contoh balasan Anda: `Meteora Antrean`.
4. BotFather lalu meminta **username**. Harus diakhiri `bot`, tanpa spasi. Contoh: `meteora_antrean_bot`. Kalau username sudah dipakai, BotFather meminta yang lain.
5. BotFather membalas dengan token, bentuknya kira-kira `123456789:AAH...`. Salin seluruh token.
6. Simpan token hanya untuk langkah `.env` di bawah. Jangan kirim ke orang lain, jangan commit, jangan tempel di chat ini.

Token bot notifikasi yang sudah ada di `TELEGRAM_BOT_TOKEN` jangan disalin ke sini.

## 2. Ambil chat id

Bot hanya membalas satu chat. Chat lain diabaikan tanpa balasan.

### Cara A — chat yang sama dengan notifikasi

Kalau orang yang sama yang menekan tombol status dan yang mengirim `/entry`, Anda tidak perlu chat id baru. Biarkan `ENTRYBOT_TELEGRAM_CHAT_ID` kosong. Bot antrean memakai `TELEGRAM_CHAT_ID`.

Anda tetap harus membuka chat bot **baru** dan menekan Start, supaya Telegram mengizinkan bot itu mengirim pesan ke Anda.

### Cara B — baca id dari Telegram

Lakukan ini **sebelum** proses antrean dijalankan, dan pakai token bot **baru**.

1. Di Telegram, buka bot baru. Tekan **Start**, atau kirim `hi`.
2. Di browser, buka alamat ini. Ganti `<TOKEN>` dengan token bot baru, tanpa spasi dan tanpa tanda kutip:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

3. Halaman yang benar berbentuk JSON dan ada `"ok":true`. Cari potongan seperti:

   ```text
   "chat":{"id":123456789
   ```

   Angka `123456789` itu chat id. Chat grup biasanya angka negatif, misalnya `-1001234567890`. Salin angkanya persis.

Kalau halaman berisi `"ok":true,"result":[]`, pesan Anda belum sampai atau sudah diambil program lain. Kirim `hi` lagi, lalu muat ulang halaman.

Kalau halaman berisi `409` atau `Conflict`, ada program yang sedang mendengarkan token ini. Hentikan proses itu dulu (`pm2 stop meteorabot-entrybot` bila itu prosesnya), kirim `hi` lagi, lalu buka halaman itu lagi.

## 3. Tulis token ke `.env`

1. Masuk ke folder bot:

   ```bash
   cd ~/meteorabot-v3
   ```

2. Buka file rahasia:

   ```bash
   nano .env
   ```

3. Cari dua baris ini (panah bawah di nano):

   ```text
   ENTRYBOT_TELEGRAM_TOKEN=
   ENTRYBOT_TELEGRAM_CHAT_ID=
   ```

4. Tempel token di kanan `=` pada baris pertama. Jangan tambah spasi atau tanda kutip.
5. Untuk cara A, biarkan `ENTRYBOT_TELEGRAM_CHAT_ID` kosong. Untuk cara B, tulis angkanya di kanan `=`.
6. Simpan: tekan `Ctrl+O`, lalu Enter.
7. Keluar: tekan `Ctrl+X`.

Contoh bentuknya (ini bukan token sungguhan):

```text
ENTRYBOT_TELEGRAM_TOKEN=123456789:AAHcontohBukanTokenSungguhan
ENTRYBOT_TELEGRAM_CHAT_ID=
```

## 4. Nyalakan prosesnya

`meteorabot-entry` harus sudah `online` (lihat `pm2 status`). Dialah yang nanti membuka posisi. Bot antrean hanya menulis baris.

```bash
cd ~/meteorabot-v3
pm2 start ecosystem.config.cjs --only meteorabot-entrybot
pm2 save
pm2 status
```

Di `pm2 status`, baris `meteorabot-entrybot` harus `online`. `pm2 save` menyimpan daftar ini supaya ikut bangkit setelah reboot (bersama perintah `pm2 startup` yang sudah dijalankan di setup).

## 5. Pastikan log-nya benar

```bash
pm2 logs meteorabot-entrybot --lines 30
```

Yang diharapkan:

```text
Meteora Worker: ENTRY BOT
Antre entry lewat Telegram | chat <angka chat Anda>
Tidak membuka posisi. Hanya menulis baris pool.txt.
```

`Ctrl+C` hanya menutup tampilan log.

Salinan yang sama ada di `logs/entrybot-out.log` dan, bila ada error, `logs/entrybot-error.log`.

Kalau token kosong, proses tetap `online` tetapi tidak mendengarkan. Log-nya:

```text
ENTRYBOT_TELEGRAM_TOKEN kosong — entry bot idle, tidak mem-poll Telegram.
```

Kalau token ada tetapi chat id kosong dan `TELEGRAM_CHAT_ID` juga kosong:

```text
Chat id kosong — isi TELEGRAM_CHAT_ID atau ENTRYBOT_TELEGRAM_CHAT_ID. Entry bot idle.
```

## 6. Pakai `/entry`

Buka chat dengan bot **antrean** (bukan bot notifikasi), dari akun yang chat id-nya diizinkan. Ketik:

```text
/entry
```

Balasan yang diharapkan:

```text
🎯 Entry baru / Pilih strategi:
```

dengan tombol `Bidask SOL`, `Bidask Double`, `Spot`, dan `❌ Batal`.

Lalu kirim **alamat token** (mint / CA), bukan alamat pool. Panjangnya kira-kira 32–44 karakter. CA yang tidak valid dibalas:

```text
CA-nya nggak valid. Kirim mint Solana (base58, kira-kira 32–44 karakter).
```

Sesi yang didiamkan sekitar 10 menit hangus. Bot membalas `Sesi entry sudah kedaluwarsa. Ketik /entry lagi.` Ketik `/entry` untuk mulai dari awal.

Bot tidak membuka posisi pada langkah ini. Ia menulis satu baris ke `pool.txt`. `meteorabot-entry` yang mengerjakannya.

### Bidask SOL

1. Tekan `Bidask SOL`. Toast: `Bidask SOL`. Pesan: `Bidask SOL dipilih. Kirim CA token:`
2. Kirim CA. Bot menampilkan nama singkat, harga sekarang dalam SOL dan USD, lalu `Masuk sekarang, atau pakai harga target?`
3. Pilih salah satu:
   - `⚡ Entry sekarang` — masuk begitu harga terbaca. Bukan harga target.
   - `🎯 Harga target` — bot meminta angka. Contoh yang diterima: `0.0000379sol` atau `0.009usd`. Tanpa akhiran dianggap USD. Balasan salah: `Harga harus lebih dari 0...` atau `Satuan nggak dikenal...`
4. Bot menanyakan rentang: `Pilih rentang posisi:` Tombolnya dari `BIDASK_SOL_ENTRY_PRESETS`. Default: `Preset 1: -50% / +15%`, `Preset 2: -30% / +15%`, `Preset 3: -20% / +15%`. Angka kiri = seberapa jauh di bawah harga, angka kanan = seberapa jauh di atas. Posisi SOL-only tetap mengisi SOL hanya sampai harga saat ini. Bagian atas dibiarkan kosong.
5. `Pilih ukuran entry:`
   - `Default (strat.conf: 0.1 SOL)` memakai `ENTRY_DEFAULT_SIZE_SOL` dan mengosongkan kolom ukuran.
   - `0.5 SOL`, `1 SOL`, `2 SOL` berasal dari `ENTRYBOT_SIZE_OPTIONS`.
6. Muncul `📋 Konfirmasi entry` (strategi, token, ukuran, harga, pemicu, rentang, calon pool). Tekan `✅ Konfirmasi`.

Balasan berhasil:

```text
⏳ Masuk antrean, dipantau.
Size     : ...
Rentang  : ...
```

dan satu baris, misalnya:

```text
CA,,,bidask:sol,ca,now,-50/15
```

atau, bila Anda memilih harga dan ukuran 0.5:

```text
CA,0.5,,bidask:sol,ca,0.0000379sol,-30/15
```

Toast: `Masuk antrean`. Ada tombol `🗑 Hapus antrean`.

Teks pemicu di ringkasan:

- `entry sekarang (harga pasar)` untuk Entry sekarang
- `tunggu harga naik sampai target` bila harga sekarang di bawah target
- `tunggu harga turun sampai target` bila harga sekarang di atas target

### Bidask Double

1. Tekan `Bidask Double`, lalu kirim CA.
2. Bot bertanya: `Langsung pantau Supertrend, atau pakai harga target?`
   - `📈 Langsung pantau Supertrend` — tidak ada harga target. Lanjut ke ukuran.
   - `🎯 Harga target` — kirim harga seperti di Bidask SOL. Kata `now` ditolak: `Bidask Double tidak pakai now.`
3. Pilih ukuran, sama seperti di atas. Tidak ada langkah rentang.
4. Konfirmasi.

Baris yang ditulis:

```text
CA,,,bidask:double,ca
```

atau dengan target dan ukuran Default:

```text
CA,,,bidask:double,ca,0.0000379sol
```

atau dengan ukuran tetap:

```text
CA,0.5,,bidask:double,ca
```

Di ringkasan, pemicunya `tunggu sinyal Supertrend`, atau `tunggu harga naik/turun sampai target, lalu tunggu sinyal Supertrend`. Harga target hanya mengizinkan sinyal. Sinyal Supertrend (tren naik) tetap yang membuka posisi.

### Spot

1. Tekan `Spot`, kirim CA, pilih ukuran, konfirmasi. Tidak ada harga dan tidak ada rentang.
2. Barisnya `CA,,,spot,ca` untuk ukuran Default, atau `CA,0.5,,spot,ca` bila Anda memilih 0.5 SOL.

Ringkasan menulis pemicu `entry langsung`. Artinya tidak ada harga target. Worker entry tetap menunggu sinyal Supertrend sebelum membuka posisi.

## 7. `/antrean` dan `/batal`

Ketik `/antrean`.

- Daftar kosong: `Antrean kosong. Ketik /entry buat nambah.`
- Ada baris: judul `📋 Antrean`, lalu tiap baris dengan strategi, nama, dan `dari entrybot` atau `manual`. Paling banyak 20 baris. Tiap baris punya tombol `🗑 Hapus ...`.
- Hapus memberi `#` pada baris itu (baris tidak dihapus fisik). Balasan: `Oke, barisnya di-#.` Toast: `Dihapus`.

Ketik `/batal` untuk membatalkan wizard yang sedang berjalan. Balasan: `Oke, dibatalin.` Kalau tidak ada wizard: `Nggak ada yang lagi diisi.` Tombol `❌ Batal` di pesan melakukan hal yang sama.

CA yang sudah punya baris aktif ditolak saat konfirmasi: `CA ini sudah ada di antrean (barisnya masih aktif). Cek /antrean.`

## 8. Arti notifikasi sesudah masuk antrean

Bot antrean memantau log dan posisi. Ia mengirim kabar ke chat yang sama.

| Pesan | Artinya |
|---|---|
| `🎯 ... target tersentuh, menunggu Supertrend.` | Harga Bidask Double sudah menyentuh target. Posisi belum dibuka. Masih menunggu sinyal tren. |
| `✅ Entry ... berhasil` | Posisi sudah terbuka. Pesan menyebut strategi, posisi, pool, bin step, ukuran, dan (untuk Bidask SOL) rentang. Bila ada, disertakan tautan transaksi. |
| `⚠️ ... belum bisa entry: dry-run, posisi tidak dibuka. Masih nunggu.` | `DRY_RUN` masih menyala. Baris tetap menunggu. Tidak ada transaksi. |
| `⚠️ ... belum bisa entry: SOL di wallet kurang. Masih nunggu.` | SOL tidak cukup. Baris tetap ada. |
| `⚠️ ... belum bisa entry: sudah ada posisi. Masih nunggu.` | Slot strategi itu sudah terpakai. |
| `⚠️ ... belum bisa entry: sewa non-refundable. Masih nunggu.` | Biaya sewa pool tidak bisa kembali, jadi entry ditahan. |
| `⚠️ ... belum bisa entry: ... Masih nunggu.` | Belum ada pool yang lolos saringan (TVL, lebar, dan sebagainya). Teks setelah titik dua menyalin alasan dari log. |
| `⚠️ ... keluar dari antrean: ...` | Baris sudah tidak aktif (diberi `#` atau dihapus). |
| `⚠️ ... barisnya sudah tidak aktif. Pantauan berhenti.` | Sama, tanpa alasan yang lebih rinci. |

Peringatan "belum bisa entry" untuk alasan yang sama tidak diulang lebih sering dari sekitar 15 menit.

Entry Bidask SOL yang berhasil (dan `DRY_RUN` mati) membuat baris itu diberi `#`. Spot dan Bidask Double yang berhasil tidak diberi `#`. Mereka bisa masuk lagi nanti. Bidask Double yang punya target harus menyentuh target itu lagi.

## 9. Kunci `strat.conf` yang dipakai bot ini

Ubah di `strat.conf` (bukan di `.env` bila kuncinya sama, karena `strat.conf` yang menang). Lalu restart:

```bash
pm2 restart meteorabot-entrybot meteorabot-entry
```

| Kunci | Default di contoh | Dipakai untuk |
|---|---|---|
| `ENTRY_DEFAULT_SIZE_SOL` | `0.1` | Tombol Default, dan baris yang kolom ukurannya kosong. |
| `ENTRYBOT_SIZE_OPTIONS` | `0.5,1,2` | Tombol ukuran tetap, angka SOL dipisah koma. Angka tidak valid diabaikan. |
| `BIDASK_SOL_ENTRY_PRESETS` | `-50/15,-30/15,-20/15` | Urutan tombol rentang Bidask SOL. |
| `BIDASK_SOL_ENTRY_LOWER_PCT` | `-50` | Rentang bawah bila suatu baris `pool.txt` tidak menulis kolom ke-7. Bot antrean sendiri selalu menulis preset yang Anda tekan. |
| `BIDASK_SOL_ENTRY_UPPER_PCT` | `15` | Rentang atas untuk baris tanpa kolom ke-7. |
| `BIDASK_SOL_ENTRY_MIN_TVL_USD` | `20000` | Pool dengan TVL di bawah ini tidak dipilih saat entry SOL-only. |
| `BIDASK_SOL_ENTRY_MAX_BINS` | `169` | Pool yang lebih lebar dari ini dilewati. |

Ringkasan di Telegram menampilkan calon pool menurut saringan yang sama. Yang membuka posisi tetap `meteorabot-entry`.

## 10. Mematikan

Hentikan sementara (bisa dinyalakan lagi):

```bash
pm2 stop meteorabot-entrybot
pm2 save
```

Nyalakan lagi:

```bash
pm2 start meteorabot-entrybot
pm2 save
```

Agar proses tetap hidup tetapi tidak mendengarkan: kosongkan `ENTRYBOT_TELEGRAM_TOKEN` di `.env`, simpan, lalu:

```bash
pm2 restart meteorabot-entrybot
```

Log kembali ke kalimat `entry bot idle`. Hapus proses dari daftar pm2:

```bash
pm2 delete meteorabot-entrybot
pm2 save
```

Baris yang sudah tertulis di `pool.txt` tidak ikut terhapus. `meteorabot-entry` tetap membacanya.

State wizard ada di `state/entrybot.json`. File itu tidak ikut git. Menghapusnya hanya melupakan sesi dan pantauan notifikasi, tidak menghapus baris di `pool.txt`.

## 11. Masalah yang sering muncul

| Yang terjadi | Sebab | Perbaikan |
|---|---|---|
| `/entry` tidak dibalas sama sekali | Chat ini bukan chat yang diizinkan, atau proses idle | Samakan chat dengan `TELEGRAM_CHAT_ID` / `ENTRYBOT_TELEGRAM_CHAT_ID`. Cek log langkah 5. |
| Log tombol `Telegram getUpdates failed: 409` | Token antrean sama dengan `TELEGRAM_BOT_TOKEN` | Buat bot baru. Isi `ENTRYBOT_TELEGRAM_TOKEN` dengan token itu. Restart kedua proses: `pm2 restart meteorabot-telegram meteorabot-entrybot`. |
| `ENTRYBOT_TELEGRAM_TOKEN kosong` | Baris di `.env` masih kosong, atau proses belum di-restart | Isi token, `pm2 restart meteorabot-entrybot`. |
| `Chat id kosong` | Kedua chat id kosong | Isi `TELEGRAM_CHAT_ID` atau `ENTRYBOT_TELEGRAM_CHAT_ID`, lalu restart. |
| `Gagal ambil harga` | Harga Jupiter atau daftar pool gagal dibaca | Kirim CA yang sama lagi. Cek kunci Jupiter di `.env` dan log `meteorabot-entry`. |
| `Gagal nulis pool.txt` | File tidak bisa ditulis | Pastikan bot dijalankan dari folder repo dan `pool.txt` ada (`cp pool.txt.example pool.txt`). |
| `CA ini sudah ada di antrean` | Baris aktif untuk CA itu sudah ada | `/antrean`, hapus yang lama, atau biarkan. |
| Notifikasi `dry-run, posisi tidak dibuka` | Latihan masih menyala | Ini normal selama `DRY_RUN=true`. Live hanya setelah Anda sengaja mengubahnya di [setup.md](setup.md). |
| Baris sudah di `pool.txt` tetapi tidak ada posisi | `meteorabot-entry` mati, atau masih menunggu sinyal / harga / pool | `pm2 status`. Untuk Spot dan Bidask Double, tunggu sinyal. Untuk harga target, tunggu harga menyentuh. |
| Setelah reboot bot antrean hilang | Belum `pm2 save` | Ulangi langkah 4. |

## Tombol di pesan status

Bagian ini bukan worker opsional. Proses `meteorabot-telegram` adalah satu dari empat proses inti di [setup.md](setup.md). Ia hanya mendengarkan ketukan. Pesan status dikirim oleh proses entry dan exit.

Syarat:

- `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` terisi.
- `pm2 status` menunjukkan `meteorabot-telegram` `online`.
- Di log: `Meteora Worker: TELEGRAM BUTTONS` dan `Tombol: ON`.
- `TELEGRAM_BUTTONS_ENABLED` di `strat.conf` bukan `false`. Default contoh adalah `true`. Mengubahnya lalu `pm2 restart meteorabot-entry meteorabot-exit meteorabot-telegram`.

`false` membuat pesan status tetap terkirim, tanpa tombol.

Cara pakai, di chat notifikasi (bot pertama, bukan bot antrean):

1. Tunggu pesan Position Status. Hanya pesan itu yang membawa tombol. Alert "entry berhasil" dan sejenisnya tidak.
2. `♻️` diikuti nama token = bentuk ulang posisi itu. Nama adalah simbol pair tanpa akhiran `-SOL`.
3. Tekan `♻️`. Tombol baris itu berubah menjadi `Token`, `SOL`, dan `Batal` dalam satu baris.
4. `Token` membentuk ulang sisi token. `SOL` membentuk ulang sisi SOL. Keduanya langsung masuk antrean. Tidak ada pertanyaan "Ya" lagi. Toast-nya `Rebalance <nama> dijadwalkan`.
5. `⚡` = tutup posisi (Zap Out). Tekan, lalu `✅ Ya, zap out <nama>` untuk jadi, atau `✖️ Batal`. Toast jadwal: `Zap Out <nama> dijadwalkan`.
6. Posisi token-only hanya menampilkan `⚡`. Tidak ada `♻️`.
7. Nama yang lebih panjang dari 10 karakter ditampilkan satu tombol per baris, supaya tidak terpotong.

Yang mengerjakan antrean adalah `meteorabot-exit`, pada siklus berikutnya. Ketukan hanya mengubah keyboard pesan yang sama. Tidak ada pesan baru dari ketukan itu.

Bila sisi yang dipilih tidak punya yang bisa dibentuk ulang, balasannya `Tidak ada yang bisa di-rebalance di sisi itu`. Perintah yang lebih lama dari 10 menit, atau untuk posisi yang sudah tidak ada, tidak dijalankan.

Zap Out menutup posisi seperti tutup manual, menukar sisa token ke SOL, dan tidak melanjutkan buka-ulang otomatis yang biasa terjadi saat harga keluar dari atas range.
