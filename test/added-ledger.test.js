import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs"; import os from "os"; import path from "path";
import { readAdded, isAlreadyAdded, recordAdded } from "../src/runner/added-ledger.js";

test("ledger runner-added: sekali tambah per mint/pool", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ra-")), "runner-added.json");
  assert.deepEqual(readAdded(f), {});
  assert.equal(isAlreadyAdded(readAdded(f), "M", ["P"]), false);
  recordAdded(f, "M", ["P", "Z", "P"]);
  const l = readAdded(f);
  assert.deepEqual(l.M.pools, ["P", "Z"]); assert.ok(l.M.addedAt);
  assert.equal(isAlreadyAdded(l, "M", []), true);
  assert.equal(isAlreadyAdded(l, "X", ["Q", "Z"]), true);
  assert.equal(isAlreadyAdded(l, "X", ["Q"]), false);
});

import { addOnce, withLedgerLock } from "../src/runner/added-ledger.js";
test("ledger bersama: addOnce serial & record hanya saat sukses", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ra-")), "runner-added.json");
  let adds = 0;
  const add = async () => { adds++; await new Promise((r) => setTimeout(r, 30)); return { changed: true, action: "added_remote" }; };
  const [a, b] = await Promise.all([addOnce(f, { mint: "M", pools: ["P"], by: "runner-alert" }, add), addOnce(f, { mint: "M", pools: ["P"], by: "pool-monitor" }, add)]);
  assert.equal(adds, 1);
  assert.deepEqual([a.action, b.action].sort(), ["added_remote", "skipped_already_added"]);
  const fail = await addOnce(f, { mint: "N", pools: ["Q"] }, async () => ({ changed: false, action: "unchanged_remote" }));
  assert.equal(fail.action, "unchanged_remote"); assert.equal(readAdded(f).N, undefined);
  assert.equal(fs.existsSync(f + ".lock"), false);
  await assert.rejects(withLedgerLock(f, async () => { throw new Error("x"); }));
  assert.equal(fs.existsSync(f + ".lock"), false);
});
