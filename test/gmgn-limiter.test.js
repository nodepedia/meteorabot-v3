import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createGmgnLimiter, readRateState } from "../src/market/gmgn-limiter.js";

test("limiter preserves order and enforces min gap", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 50 });
  const order = [];
  const t0 = Date.now();
  await Promise.all(
    [1, 2, 3].map((n) =>
      limiter.schedule(null, async () => {
        order.push(n);
      })
    )
  );
  const elapsed = Date.now() - t0;
  assert.deepEqual(order, [1, 2, 3]);
  assert.ok(elapsed >= 80, `elapsed ${elapsed}ms should be >= ~100ms`);
});

test("limiter dedups concurrent tasks with the same key", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 0 });
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };
  const [a, b] = await Promise.all([limiter.schedule("k", fn), limiter.schedule("k", fn)]);
  assert.equal(calls, 1);
  assert.equal(a, 42);
  assert.equal(b, 42);
});

test("limiter enforces the per-minute cap", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 2, minGapMs: 0 });
  await Promise.all([limiter.schedule(null, async () => {}), limiter.schedule(null, async () => {})]);
  const wait = limiter.nextAllowedAt() - Date.now();
  assert.ok(wait > 50000, `wait ${wait}ms should be ~60s`);
});

test("blockFor pauses scheduling and adaptive cap auto-recovers after cooldown", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 8, minGapMs: 0 });
  limiter.blockFor(80);
  assert.equal(limiter.stats().cap, 4);
  const t0 = Date.now();
  await limiter.schedule(null, async () => {});
  assert.ok(Date.now() - t0 >= 70);
  assert.equal(limiter.stats().cap, 8);
});

test("limiter prioritizes exit tasks ahead of queued entry tasks", async () => {
  const limiter = createGmgnLimiter({ maxPerMin: 100, minGapMs: 30 });
  const order = [];
  const p1 = limiter.schedule("first", async () => {
    order.push("first");
  }, { priority: "entry" });
  const p2 = limiter.schedule("entry-2", async () => {
    order.push("entry-2");
  }, { priority: "entry" });
  const p3 = limiter.schedule("exit-1", async () => {
    order.push("exit-1");
  }, { priority: "exit" });
  await Promise.all([p1, p2, p3]);
  // "first" starts immediately, then "exit-1" jumps ahead of "entry-2"
  assert.deepEqual(order, ["first", "exit-1", "entry-2"]);
});

test("cross-process limiters serialize slots across two workers without bursting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmgn-rate-"));
  const stateFile = path.join(tmpDir, "gmgn-rate-state.json");
  const workerEntry = createGmgnLimiter({ maxPerMin: 100, minGapMs: 60, crossProcess: true, stateFile });
  const workerExit = createGmgnLimiter({ maxPerMin: 100, minGapMs: 60, crossProcess: true, stateFile });

  const stamps = [];
  await Promise.all([
    workerEntry.schedule("e1", async () => stamps.push({ w: "entry", t: Date.now() }), { priority: "entry" }),
    workerExit.schedule("x1", async () => stamps.push({ w: "exit", t: Date.now() }), { priority: "exit" }),
    workerEntry.schedule("e2", async () => stamps.push({ w: "entry", t: Date.now() }), { priority: "entry" }),
  ]);

  assert.equal(stamps.length, 3);
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i].t - stamps[i - 1].t;
    assert.ok(gap >= 45, `cross-process gap ${gap}ms between call ${i - 1} and ${i} should be >= ~60ms`);
  }
  const disk = readRateState(stateFile);
  assert.ok(disk.nextSlotAt > 0);
});
