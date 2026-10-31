import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { readRunnerSettings } from "../src/worker-runner.js";

test("runner: saklar off, interval default 300 (tmp file, tak tergantung strat.conf produksi)", () => {
  const f = path.join(os.tmpdir(), "rs-off-" + process.pid + ".conf");
  fs.writeFileSync(f, "RUNNER_AUTO_ENTRY=off\n");
  assert.deepEqual(readRunnerSettings(f), { enabled: false, intervalSec: 300 });
});

test("runner: toggle on + interval", () => {
  const f = path.join(os.tmpdir(), "rs-" + process.pid + ".conf");
  fs.writeFileSync(f, "RUNNER_AUTO_ENTRY=on\nRUNNER_SCAN_INTERVAL_SEC=120\n");
  assert.deepEqual(readRunnerSettings(f), { enabled: true, intervalSec: 120 });
});
