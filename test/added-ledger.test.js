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
