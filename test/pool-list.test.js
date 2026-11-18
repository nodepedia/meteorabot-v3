import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "../src/config/index.js";
import {
  parsePoolList,
  loadPoolList,
  commentPoolInList,
  applyPoolListHeader,
  ensurePoolListHeader,
  poolListHeaderLines,
} from "../src/entry/pool-list.js";

const ADDR_A = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const ADDR_B = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";

function withEntry(overrides, fn) {
  const saved = { ...config.entry };
  Object.assign(config.entry, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config.entry, saved);
  }
}

test("alamat saja memakai default dari config", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A}\n${ADDR_B}\n`);
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 0.2, mode: "bidask:double" },
      { pool: ADDR_B, sizeSol: 0.2, mode: "bidask:double" },
    ]);
  });
});

test("alamat,size,max: size dipakai, kolom max lama diabaikan", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A},0.5,3\n`);
    assert.deepEqual(out, [{ pool: ADDR_A, sizeSol: 0.5, mode: "bidask:double" }]);
  });
});

test("multiplier 1x / 1.25x / 1.5x dan tier1/tier2/tier3 dihitung dari defaultSizeSol", () => {
  withEntry({ defaultSizeSol: 0.1, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A},1x,1\n${ADDR_B},1.25x,1\n${ADDR_A},1.5x,2\n`);
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 0.1, mode: "bidask:double" },
      { pool: ADDR_B, sizeSol: 0.125, mode: "bidask:double" },
      { pool: ADDR_A, sizeSol: 0.15, mode: "bidask:double" },
    ]);
  });

  withEntry({ defaultSizeSol: 1, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A},tier1,1\n${ADDR_B},tier2,1\n${ADDR_A},tier3,1\n`);
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 1, mode: "bidask:double" },
      { pool: ADDR_B, sizeSol: 1.25, mode: "bidask:double" },
      { pool: ADDR_A, sizeSol: 1.5, mode: "bidask:double" },
    ]);
  });
});

test("kolom ke-4 spot (Runner Spot) dan kolom ke-2 spot mengatur mode: spot", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(
      `${ADDR_A},1x,1,spot\n${ADDR_B},1.25x,1,SPOT\n${ADDR_A},1.5x,1,spot\n${ADDR_B},0.15,1,spot\n${ADDR_A},spot\n`
    );
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 0.2, mode: "spot" },
      { pool: ADDR_B, sizeSol: 0.25, mode: "spot" },
      { pool: ADDR_A, sizeSol: 0.3, mode: "spot" },
      { pool: ADDR_B, sizeSol: 0.15, mode: "spot" },
      { pool: ADDR_A, sizeSol: 0.2, mode: "spot" },
    ]);
  });
});

test("kolom ke-4 bidask / bidask:double valid, nilai lain di-skip", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`${ADDR_A},1x,1,bidask\n${ADDR_B},1x,1,bidask:double\n${ADDR_A},1x,1,invalid_mode\n`);
    assert.deepEqual(out, [
      { pool: ADDR_A, sizeSol: 0.2, mode: "bidask:double" },
      { pool: ADDR_B, sizeSol: 0.2, mode: "bidask:double" },
    ]);
  });
});

test("bidask:sol hanya sah bersama ca dan harga entry USD positif", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    assert.deepEqual(parsePoolList(`${ADDR_A},1x,,bidask:sol,ca,0.00125\n`), [
      { pool: ADDR_A, sizeSol: 0.2, mode: "bidask:sol", ca: true, entryPrice: 0.00125, entryPriceUnit: "usd" },
    ]);
    assert.deepEqual(parsePoolList(`${ADDR_B},0.5,,bidask:sol,ca,2\n${ADDR_A},tier2,,bidask:sol,ca,0.5\n`), [
      { pool: ADDR_B, sizeSol: 0.5, mode: "bidask:sol", ca: true, entryPrice: 2, entryPriceUnit: "usd" },
      { pool: ADDR_A, sizeSol: 0.25, mode: "bidask:sol", ca: true, entryPrice: 0.5, entryPriceUnit: "usd" },
    ]);
    assert.deepEqual(
      parsePoolList(
        `${ADDR_A},1x,,bidask:sol\n${ADDR_A},1x,,bidask:sol,ca\n${ADDR_A},1x,,bidask:sol,ca,0\n${ADDR_A},1x,,bidask:sol,ca,-1\n${ADDR_A},1x,,bidask:sol,ca,abc\n${ADDR_B},1x,,bidask:sol,bukan-ca,1\n`
      ),
      []
    );
    assert.deepEqual(parsePoolList(`${ADDR_A},1x,,spot\n${ADDR_B},1x,,spot,ca\n${ADDR_A}\n`), [
      { pool: ADDR_A, sizeSol: 0.2, mode: "spot" },
      { pool: ADDR_B, sizeSol: 0.2, mode: "spot", ca: true },
      { pool: ADDR_A, sizeSol: 0.2, mode: "bidask:double" },
    ]);
  });
});

test("bidask:sol membaca satuan sol, usd, angka polos, dan menolak akhiran lain", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    assert.deepEqual(parsePoolList(`${ADDR_A},1x,,bidask:sol,ca,0.0000123sol\n`), [
      {
        pool: ADDR_A,
        sizeSol: 0.2,
        mode: "bidask:sol",
        ca: true,
        entryPrice: 0.0000123,
        entryPriceUnit: "sol",
      },
    ]);
    assert.deepEqual(parsePoolList(`${ADDR_A},1x,,bidask:sol,ca,0.0000123SOL\n`), [
      {
        pool: ADDR_A,
        sizeSol: 0.2,
        mode: "bidask:sol",
        ca: true,
        entryPrice: 0.0000123,
        entryPriceUnit: "sol",
      },
    ]);
    assert.deepEqual(
      parsePoolList(
        `${ADDR_B},1x,,bidask:sol,ca,0.0012usd\n${ADDR_A},1x,,bidask:sol,ca,0.0012USD\n${ADDR_A},0.5,,bidask:sol,ca,0.5\n`
      ),
      [
        { pool: ADDR_B, sizeSol: 0.2, mode: "bidask:sol", ca: true, entryPrice: 0.0012, entryPriceUnit: "usd" },
        { pool: ADDR_A, sizeSol: 0.2, mode: "bidask:sol", ca: true, entryPrice: 0.0012, entryPriceUnit: "usd" },
        { pool: ADDR_A, sizeSol: 0.5, mode: "bidask:sol", ca: true, entryPrice: 0.5, entryPriceUnit: "usd" },
      ]
    );
    assert.deepEqual(
      parsePoolList(
        `${ADDR_A},1x,,bidask:sol,ca,0.0012eur\n${ADDR_A},1x,,bidask:sol,ca,1btc\n${ADDR_A},1x,,bidask:sol,ca,-0.2sol\n${ADDR_A},1x,,bidask:sol,ca,0sol\n${ADDR_A},1x,,bidask:sol,ca,-1\n`
      ),
      []
    );
  });
});

test("header pool.txt idempoten dan tidak mengubah baris pengguna", () => {
  const user = "KEEP_ME,1x,,spot\n# catatan user\n";
  const first = applyPoolListHeader(user);
  assert.equal(first.changed, true);
  assert.ok(first.next.startsWith("# === FORMAT (dikelola bot) ===\n"));
  assert.ok(first.next.includes("# === END FORMAT ===\nKEEP_ME,1x,,spot\n# catatan user\n"));
  const second = applyPoolListHeader(first.next);
  assert.equal(second.changed, false);
  assert.equal(second.next, first.next);

  const dirty = first.next.replace("Kelipatan", "TEKS_LAMA");
  const fixed = applyPoolListHeader(dirty);
  assert.equal(fixed.changed, true);
  assert.equal(fixed.next, first.next);

  const above = `USER_TOP,0.5,,bidask:double\n${first.next}`;
  const kept = applyPoolListHeader(above);
  assert.equal(kept.changed, false);
  assert.ok(kept.next.startsWith("USER_TOP,0.5,,bidask:double\n"));
  assert.ok(kept.next.includes("KEEP_ME,1x,,spot\n# catatan user\n"));

  const example = fs.readFileSync(path.resolve("pool.txt.example"), "utf8");
  assert.equal(example, applyPoolListHeader("").next);
  assert.deepEqual(example.replace(/\n$/, "").split("\n"), poolListHeaderLines());
  const header = poolListHeaderLines().join("\n");
  assert.match(header, /TOKEN_CA,1x,,bidask:sol,ca,0\.00123\n/);
  assert.match(header, /0\.00123usd/);
  assert.match(header, /0\.0000123sol/);
  assert.match(header, /USD per token/);
  assert.match(header, /SOL per token/);
});

test("ensurePoolListHeader menulis atomik dan tidak menulis ulang bila sama", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-header-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, "ADDR_USER,1.5x,,spot\n");
  try {
    assert.equal(ensurePoolListHeader(file), true);
    const once = fs.readFileSync(file, "utf8");
    assert.match(once, /# === FORMAT \(dikelola bot\) ===/);
    assert.match(once, /ADDR_USER,1\.5x,,spot\n$/);
    assert.equal(ensurePoolListHeader(file), false);
    assert.equal(fs.readFileSync(file, "utf8"), once);
    assert.equal(
      fs.readdirSync(dir).some((name) => name.endsWith(".tmp")),
      false
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("baris # dan kosong diabaikan", () => {
  withEntry({ defaultSizeSol: 0.2, defaultMaxPositions: 1 }, () => {
    const out = parsePoolList(`# ${ADDR_A}\n\n   #${ADDR_B}\n${ADDR_A}\n`);
    assert.deepEqual(out, [{ pool: ADDR_A, sizeSol: 0.2, mode: "bidask:double" }]);
  });
});

test("alamat saja di-skip bila default size tidak valid", () => {
  withEntry({ defaultSizeSol: 0, defaultMaxPositions: 1 }, () => {
    assert.deepEqual(parsePoolList(`${ADDR_A}\n`), []);
    assert.deepEqual(parsePoolList(`${ADDR_A},1.25x,1\n`), []);
  });
});

test("commentPoolInList menandai baris pool aktif dan idempoten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-list-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, `# header\n${ADDR_A}\n${ADDR_B},0.5,2\n#${ADDR_A}\n`);
  const saved = config.entry.poolListFile;
  config.entry.poolListFile = file;
  try {
    assert.equal(commentPoolInList(ADDR_A), true);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after, `# header\n#${ADDR_A}\n${ADDR_B},0.5,2\n#${ADDR_A}\n`);

    assert.equal(commentPoolInList(ADDR_A), true);
    assert.equal(fs.readFileSync(file, "utf8"), after);

    assert.equal(commentPoolInList(ADDR_B), true);
    assert.equal(fs.readFileSync(file, "utf8"), `# header\n#${ADDR_A}\n#${ADDR_B},0.5,2\n#${ADDR_A}\n`);
  } finally {
    config.entry.poolListFile = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPoolList membaca dari file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-list-"));
  const file = path.join(dir, "pool.txt");
  fs.writeFileSync(file, `${ADDR_A}\n`);
  const saved = config.entry.poolListFile;
  const savedSize = config.entry.defaultSizeSol;
  config.entry.poolListFile = file;
  config.entry.defaultSizeSol = 0.2;
  try {
    assert.deepEqual(loadPoolList(), [{ pool: ADDR_A, sizeSol: 0.2, mode: "bidask:double" }]);
  } finally {
    config.entry.poolListFile = saved;
    config.entry.defaultSizeSol = savedSize;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
