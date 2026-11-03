import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { mainConfig, buildAddCommand, addViaMain, parseResult } from "../src/runner/main-ledger.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Simulasi VPS main secara lokal: MAIN_VPS_HOST kosong → perintah flock+node dijalankan via sh.
function setup(poolTxt = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-"));
  fs.writeFileSync(path.join(dir, "pool.txt"), poolTxt);
  const cfg = mainConfig({ MAIN_POOL_PATH: path.join(dir, "pool.txt"), MAIN_REPO_DIR: REPO });
  return { dir, cfg, pool: () => fs.readFileSync(path.join(dir, "pool.txt"), "utf8"), ledger: () => JSON.parse(fs.readFileSync(cfg.ledgerPath, "utf8")) };
}
const add = (cfg, o) => addViaMain(cfg, { by: "test", line: `${o.pool},1x,1,spot`, ...o });

test("default ledger = <dir pool.txt>/runner-added.json, lock = ledger.lock", () => {
  const c = mainConfig({ MAIN_POOL_PATH: "~/meteorabot-v3/pool.txt" });
  assert.equal(c.ledgerPath, "~/meteorabot-v3/runner-added.json");
  assert.equal(c.lockPath, "~/meteorabot-v3/runner-added.json.lock");
  assert.equal(c.repoDir, "~/meteorabot-v3");
  assert.equal(c.host, null);
  const cmd = buildAddCommand(c, { mint: "M", pool: "P", pools: ["P", "Q"], line: "P,1x,1,spot", by: "x" });
  assert.match(cmd, /^cd "\$HOME"\/'meteorabot-v3' && flock -w 60 "\$HOME"\/'meteorabot-v3\/runner-added.json.lock' 'node' scripts\/remote-add-pool.js /);
  assert.match(cmd, /--pools 'P,Q'/);
});

test("sukses: tulis baris pool.txt + entri ledger", () => {
  const s = setup("OLD,1x,1,bidask");
  const r = add(s.cfg, { mint: "MINT1", pool: "POOL1", pools: ["POOL2"] });
  assert.equal(r.status, "added");
  assert.equal(s.pool(), "OLD,1x,1,bidask\nPOOL1,1x,1,spot\n");
  const e = s.ledger().MINT1;
  assert.equal(e.mint, "MINT1");
  assert.equal(e.pool, "POOL1");
  assert.deepEqual(e.pools, ["POOL1", "POOL2"]);
  assert.equal(e.by, "test");
  assert.ok(e.addedAt);
});

test("already_added: mint sudah di ledger (pool apa pun)", () => {
  const s = setup();
  assert.equal(add(s.cfg, { mint: "M", pool: "A" }).status, "added");
  const r = add(s.cfg, { mint: "M", pool: "B" });
  assert.equal(r.status, "already_added");
  assert.equal(s.pool(), "A,1x,1,spot\n");
});

test("pool lain dari token yang sama diblok (ledger lama per pool & pool.txt)", () => {
  const s = setup();
  assert.equal(add(s.cfg, { mint: "M", pool: "A", pools: ["B"] }).status, "added");
  // Mint tak dikenal tapi pool-nya milik token yang sudah di-add.
  assert.equal(add(s.cfg, { mint: "M2", pool: "B" }).status, "already_added");
  // Pool lain token X sudah ada di pool.txt (tanpa ledger) → diblok.
  const t = setup("XPOOL_OTHER,1x,1,spot\n");
  const r = add(t.cfg, { mint: "X", pool: "XPOOL_BEST", pools: ["XPOOL_OTHER"] });
  assert.equal(r.status, "already_in_pool");
  assert.equal(r.matchedPool, "XPOOL_OTHER");
  assert.equal(t.pool(), "XPOOL_OTHER,1x,1,spot\n");
});

test("already_in_pool: termasuk baris '#' (dan ledger di-backfill)", () => {
  const s = setup("# P9,1x,1,spot\n");
  const r = add(s.cfg, { mint: "M9", pool: "P9" });
  assert.equal(r.status, "already_in_pool");
  assert.equal(s.pool(), "# P9,1x,1,spot\n");
  assert.ok(s.ledger().M9.backfill);
  assert.equal(add(s.cfg, { mint: "M9", pool: "P9" }).status, "already_added");
});

test("already_open: state.json punya posisi terbuka di token itu", () => {
  const s = setup();
  fs.writeFileSync(path.join(s.dir, "state.json"), JSON.stringify({ positions: { x: { pool: "Z", baseMint: "MO", closed: false } } }));
  const cfg = { ...s.cfg, statePath: path.join(s.dir, "state.json") };
  assert.equal(add(cfg, { mint: "MO", pool: "NEW" }).status, "already_open");
  assert.equal(s.pool(), "");
});

test("ledger rusak → error, pool.txt tidak disentuh", () => {
  const s = setup();
  fs.writeFileSync(s.cfg.ledgerPath, "{rusak");
  const r = add(s.cfg, { mint: "M", pool: "A" });
  assert.equal(r.status, "error");
  assert.equal(s.pool(), "");
});

test("cache lokal: mint yang sudah tercatat tidak memanggil main lagi", () => {
  const s = setup();
  const cfg = { ...s.cfg, cachePath: path.join(s.dir, "cache.json") };
  assert.equal(add(cfg, { mint: "C", pool: "CP" }).status, "added");
  let calls = 0;
  const r = addViaMain(cfg, { mint: "C", pool: "CP2", line: "CP2,1x,1,spot" }, () => { calls++; return ""; });
  assert.equal(r.status, "already_added");
  assert.equal(calls, 0);
});

test("ssh: perintah dikirim ke host main via ssh -i key BatchMode", () => {
  const cfg = mainConfig({ MAIN_VPS_HOST: "root@main", MAIN_VPS_SSH_KEY: "/k", MAIN_POOL_PATH: "/root/meteorabot-v3/pool.txt" });
  let seen;
  const r = addViaMain(cfg, { mint: "M", pool: "P", line: "P,1x,1,spot", by: "x" }, (bin, args) => {
    seen = [bin, ...args];
    return 'RESULT {"status":"added","mint":"M"}\n';
  });
  assert.equal(r.status, "added");
  assert.deepEqual(seen.slice(0, 7), ["ssh", "-i", "/k", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.equal(seen[7], "root@main");
  assert.match(seen[8], /flock -w 60 '\/root\/meteorabot-v3\/runner-added.json.lock'/);
  assert.equal(parseResult("noise\nRESULT {bad").status, "error");
});

test("concurrent: banyak add bersamaan untuk token sama → hanya satu yang menang", async () => {
  const s = setup();
  const N = 8;
  const runs = Array.from({ length: N }, (_, i) =>
    new Promise((resolve) => {
      const cmd = buildAddCommand(s.cfg, { mint: "RACE", pool: `RP${i}`, pools: [`RP${i}`], line: `RP${i},1x,1,spot`, by: `w${i}` });
      execFile("sh", ["-c", cmd], { encoding: "utf8" }, (err, out) => resolve(parseResult(out)));
    })
  );
  const res = await Promise.all(runs);
  assert.equal(res.filter((r) => r.status === "added").length, 1);
  assert.equal(res.filter((r) => r.status === "already_added").length, N - 1);
  assert.equal(s.pool().trim().split("\n").length, 1);
  assert.equal(Object.keys(s.ledger()).length, 1);
});

test("CLI exit code 2 + RESULT error bila argumen kurang", () => {
  let code = 0, out = "";
  try {
    execFileSync("node", [path.join(REPO, "scripts/remote-add-pool.js"), "--mint", "M"], { encoding: "utf8" });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.equal(code, 2);
  assert.equal(parseResult(out).status, "error");
});
