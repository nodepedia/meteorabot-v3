# setup.md — Worker OPSIONAL yang mengisi `pool.txt`

meteorabot-v3 berdiri sendiri ([README.md](README.md)): cukup isi `pool.txt` manual. Dua worker terpisah bisa menambahkan baris secara otomatis, masing-masing di repo dan VPS sendiri:

| Worker | Repo | PM2 |
|---|---|---|
| Runner Alert | [nodepedia/runner-alert](https://github.com/nodepedia/runner-alert) | `runner-alert` |
| Pool monitor | [nodepedia/meteora-pool-monitor](https://github.com/nodepedia/meteora-pool-monitor) | lihat README repo itu |

Setup worker ada di README masing-masing. **Bot utama tidak perlu diubah atau di-restart**; `pool.txt` dibaca ulang tiap siklus.

## Yang ditulis worker
Worker tidak memilih pool. Token yang lolos dikirim sebagai **baris CA**:
```
<CA>,<mult>,1,spot,ca
```
- `mult` mengikuti confluence wallet Tier S/A: S + A = `1.5x`, S saja = `1.25x`, selain itu `1x`.
- meteorabot-v3 memilih pool DLMM paling efisien untuk CA itu saat entry (README, bagian `pool.txt`).

## Dedupe per token (tanpa ledger)
Kedua worker memakai `remote-pool.js` yang identik: satu perintah ssh, di bawah `flock` pada `pool.txt` (POSIX `sh` + `grep`, tidak butuh node di VPS main):
- CA, atau pool address token itu yang diketahui worker, sudah ada di baris mana pun **termasuk `#`** → skip (`already_in_pool`)
- selain itu → append baris CA

Worker boleh di VPS berbeda tanpa dobel. **Kalau baris CA dihapus total, token boleh ditambahkan lagi.**

## Yang perlu disiapkan di VPS main
- `flock` tersedia (`which flock`; bawaan util-linux di Ubuntu).
- Public key ssh tiap worker ada di `~/.ssh/authorized_keys`:
  ```bash
  # di host worker
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
  ssh-copy-id root@MAIN_IP
  ssh -o BatchMode=yes root@MAIN_IP "cat ~/meteorabot-v3/pool.txt"   # harus jalan tanpa password
  ```
- Di `.env` worker: `MAIN_VPS_HOST=root@MAIN_IP`, `MAIN_VPS_SSH_KEY`, `MAIN_POOL_PATH` (default `~/meteorabot-v3/pool.txt`).

## Verifikasi
`tail ~/meteorabot-v3/pool.txt` di VPS main menampilkan baris `<CA>,...,spot,ca` baru, dan `pm2 logs meteorabot-entry` menampilkan `CA xxxx → pool yyyy` lalu entry-nya.
