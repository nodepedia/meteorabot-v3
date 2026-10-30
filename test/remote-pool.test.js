import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteConfig, remoteUpdatePool } from "../src/runner/remote-pool.js";

const mk = (files) => { const calls = []; const exec = (_c, args) => { const cmd = args.at(-1); calls.push(args);
  if (cmd.startsWith("cat")) return files[cmd.includes("state") ? "state" : "pool"] ?? ""; return ""; }; return { exec, calls }; };

test("remoteConfig null tanpa host", () => assert.equal(remoteConfig({}), null));
test("append bila baru, pakai BatchMode", () => {
  const cfg = remoteConfig({ MAIN_VPS_HOST: "root@1.2.3.4" }); const m = mk({ pool: "X,1x,1,spot\n" });
  const r = remoteUpdatePool(cfg, { poolAddress: "P", multiplierStr: "2x" }, m.exec);
  assert.equal(r.action, "added_remote"); assert.ok(m.calls[1].at(-1).includes(">>")); assert.ok(m.calls[0].includes("BatchMode=yes"));
});
test("skip bila pool sudah ada", () => {
  const m = mk({ pool: "P,1x,1,spot\n" });
  assert.equal(remoteUpdatePool(remoteConfig({ MAIN_VPS_HOST: "h" }), { poolAddress: "P", multiplierStr: "2x" }, m.exec).changed, false);
  assert.equal(m.calls.length, 1);
});
test("skip bila token open di state", () => {
  const m = mk({ pool: "", state: JSON.stringify({ positions: { a: { baseMint: "M", pool: "Z" } } }) });
  const r = remoteUpdatePool(remoteConfig({ MAIN_VPS_HOST: "h", MAIN_STATE_PATH: "/r/state.json" }), { poolAddress: "P", multiplierStr: "2x", mint: "M" }, m.exec);
  assert.equal(r.action, "skipped_token_already_open");
});
