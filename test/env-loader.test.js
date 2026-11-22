import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadEnv, resolveStratSource, stratSourceWarning } from "../src/config/env.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "strat-env-"));
const write = (name, content) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, content);
  return file;
};

test("strat.conf menang atas .env untuk key yang sama", () => {
  const strat = write("a.conf", "TRAILING_DROP_PCT=3\n");
  const env = write("a.env", "TRAILING_DROP_PCT=1.5\nSECRET=abc\n");
  const cfg = loadEnv(strat, env);
  assert.equal(cfg.TRAILING_DROP_PCT, "3");
  assert.equal(cfg.SECRET, "abc");
});

test("key hanya di salah satu file tetap terbaca", () => {
  const strat = write("b.conf", "ONLY_STRAT=1\n");
  const env = write("b.env", "ONLY_ENV=2\n");
  const cfg = loadEnv(strat, env);
  assert.equal(cfg.ONLY_STRAT, "1");
  assert.equal(cfg.ONLY_ENV, "2");
});

test("komentar, baris kosong, dan kutip diabaikan/dibersihkan", () => {
  const strat = write("c.conf", '# komentar\n\nNUMA=10\nSTR="halo dunia"\n');
  const cfg = loadEnv(strat, write("c.env", ""));
  assert.equal(cfg.NUMA, "10");
  assert.equal(cfg.STR, "halo dunia");
  assert.equal(cfg["# komentar"], undefined);
});

test("file yang tidak ada tidak membuat error", () => {
  const missing = path.join(TMP, "tidak-ada.conf");
  const env = write("d.env", "SECRET=xyz\n");
  assert.deepEqual(loadEnv(missing, env), { SECRET: "xyz" });
  assert.deepEqual(loadEnv(missing, missing), {});
});

test("strat.conf hilang jatuh ke strat.conf.example", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-miss-"));
  const strat = path.join(dir, "strat.conf");
  const example = path.join(dir, "strat.conf.example");
  fs.writeFileSync(example, "ENTRY_SIZE_SPLIT=0.5\nENTRYBOT_SIZE_OPTIONS=0.5,1,2\n");
  const decision = resolveStratSource({ stratFile: strat, exampleFile: example, allowFallback: true, testMode: false });
  assert.equal(decision.source, "example");
  assert.equal(decision.reason, "missing");
  assert.equal(decision.file, path.resolve(example));
  assert.match(stratSourceWarning(decision), /strat\.conf tidak ditemukan/);
  assert.match(stratSourceWarning(decision), /cp strat\.conf\.example strat\.conf/);
});

test("strat.conf yang kurang kunci baru memakai nama kunci itu saja", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-part-"));
  const strat = path.join(dir, "strat.conf");
  const example = path.join(dir, "strat.conf.example");
  fs.writeFileSync(strat, "SOL_MODE=true\n");
  fs.writeFileSync(
    example,
    "SOL_MODE=true\nENTRYBOT_SIZE_OPTIONS=0.5,1,2\nBIDASK_SOL_ENTRY_PRESETS=-50/15,-30/15,-20/15\nENTRY_SIZE_SPLIT=0.5\n"
  );
  const decision = resolveStratSource({ stratFile: strat, exampleFile: example, allowFallback: true, testMode: false });
  assert.equal(decision.source, "strat");
  assert.deepEqual(decision.missingKeys, ["BIDASK_SOL_ENTRY_PRESETS", "ENTRYBOT_SIZE_OPTIONS", "ENTRY_SIZE_SPLIT"]);
  const warning = stratSourceWarning(decision);
  assert.match(warning, /memakai default/);
  assert.match(warning, /ENTRYBOT_SIZE_OPTIONS/);
  assert.doesNotMatch(warning, /0\.5,1,2/);
  const env = loadEnv(strat, path.join(dir, "kosong.env"));
  assert.equal(env.SOL_MODE, "true");
  assert.equal(env.ENTRYBOT_SIZE_OPTIONS, undefined);
});

test("path eksplisit yang hilang tidak mengambil contoh", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-pin-"));
  const example = path.join(dir, "strat.conf.example");
  fs.writeFileSync(example, "ONLY_EXAMPLE=1\n");
  const decision = resolveStratSource({
    stratFile: path.join(dir, "tidak-ada.conf"),
    exampleFile: example,
    allowFallback: false,
    testMode: false,
  });
  assert.equal(decision.source, "missing");
  assert.equal(stratSourceWarning(decision), null);
});

test("tes tidak membaca strat.conf sungguhan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-testmode-"));
  const strat = path.join(dir, "strat.conf");
  const example = path.join(dir, "strat.conf.example");
  fs.writeFileSync(strat, "SOL_MODE=false\n");
  fs.writeFileSync(example, "SOL_MODE=true\nENTRY_SIZE_SPLIT=0.5\n");
  const decision = resolveStratSource({ stratFile: strat, exampleFile: example, allowFallback: true, testMode: true });
  assert.equal(decision.source, "example");
  assert.equal(decision.reason, "test");
  assert.equal(stratSourceWarning(decision), null);
  const env = loadEnv();
  assert.equal(env.ENTRYBOT_SIZE_OPTIONS, "0.5,1,2");
  assert.equal(env.ENTRY_SIZE_SPLIT, "0.5");
  assert.equal(env.BIDASK_SOL_ENTRY_PRESETS, "-50/15,-30/15,-20/15");
});
