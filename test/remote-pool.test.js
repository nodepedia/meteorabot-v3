import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { remoteConfig, addCaLine, buildAddCaScript, caLine } from "../src/runner/remote-pool.js";

process.env.TELEGRAM_BOT_TOKEN = "";
const CA = "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U";
const POOL = "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt";
const tmp = (content = "") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  const f = path.join(d, "pool.txt");
  fs.writeFileSync(f, content);
  return f;
};

test("remoteConfig null tanpa host; tanpa MAIN_STATE_PATH", () => {
  assert.equal(remoteConfig({}), null);
  assert.deepEqual(Object.keys(remoteConfig({ MAIN_VPS_HOST: "h" })).sort(), ["host", "key", "poolPath"]);
});

test("append baris CA bila belum ada", () => {
  const f = tmp("X1,1x,1,spot");
  const r = addCaLine({ localPath: f }, { mint: CA, multiplierStr: "1.5x" });
  assert.equal(r.action, "added");
  assert.equal(fs.readFileSync(f, "utf8"), `X1,1x,1,spot\n${CA},1.5x,1,spot,ca\n`);
});

test("skip bila CA sudah ada, termasuk baris '#'", () => {
  for (const c of [`${CA},1x,1,spot,ca\n`, `#${CA},1.25x,1,spot,ca\n`, `# ${CA},1x,1,spot,ca  # selesai\n`]) {
    const f = tmp(c);
    const r = addCaLine({ localPath: f }, { mint: CA, multiplierStr: "1x" });
    assert.equal(r.action, "already_in_pool");
    assert.equal(fs.readFileSync(f, "utf8"), c);
  }
});

test("skip bila pool address milik token sudah ada (baris manual / '#')", () => {
  for (const c of [`${POOL},1x,1,spot\n`, `#${POOL}\n`]) {
    const f = tmp(c);
    const r = addCaLine({ localPath: f }, { mint: CA, multiplierStr: "1x", knownPools: [POOL] });
    assert.equal(r.action, "already_in_pool");
    assert.equal(r.match, POOL);
  }
});

test("baris CA dihapus total → token boleh ditambahkan lagi (tanpa ledger)", () => {
  const f = tmp();
  assert.equal(addCaLine({ localPath: f }, { mint: CA, multiplierStr: "1x" }).action, "added");
  fs.writeFileSync(f, "");
  assert.equal(addCaLine({ localPath: f }, { mint: CA, multiplierStr: "1x" }).action, "added");
  assert.equal(fs.readFileSync(f, "utf8"), caLine(CA, "1x") + "\n");
});

test("ssh: satu perintah dengan flock + grep, BatchMode", () => {
  const calls = [];
  const r = addCaLine(remoteConfig({ MAIN_VPS_HOST: "root@1.2.3.4" }), { mint: CA, multiplierStr: "1.25x" }, (cmd, args) => {
    calls.push([cmd, args]);
    return "added\n";
  });
  assert.equal(r.action, "added");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "ssh");
  assert.ok(calls[0][1].includes("BatchMode=yes"));
  const script = calls[0][1].at(-1);
  assert.match(script, /flock -w 30 9/);
  assert.match(script, /grep -qF/);
  assert.match(script, /"\$HOME"\/'meteorabot-v3\/pool.txt'/);
});

test("ssh gagal → action failed, tidak throw", () => {
  const r = addCaLine(remoteConfig({ MAIN_VPS_HOST: "h" }), { mint: CA, multiplierStr: "1x" }, () => { throw new Error("boom"); });
  assert.equal(r.action, "failed");
});

test("CA invalid ditolak", () => {
  assert.throws(() => buildAddCaScript("/tmp/x", { mint: "abc;rm -rf /" }));
});

test("append serentak (8 proses, flock) → hanya satu baris", async () => {
  const f = tmp();
  const script = buildAddCaScript(f, { mint: CA, multiplierStr: "1x" });
  const outs = await Promise.all(
    Array.from({ length: 8 }, () => new Promise((res) => {
      const p = spawn("sh", ["-c", script]);
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.on("close", () => res(o.trim()));
    }))
  );
  assert.equal(outs.filter((o) => o === "added").length, 1);
  assert.equal(fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length, 1);
});
