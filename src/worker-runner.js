// Worker ke-4: menjalankan scripts/runner-alert-scan.js tiap RUNNER_SCAN_INTERVAL_SEC.
// Saklar RUNNER_AUTO_ENTRY (on|off) di strat.conf dibaca ulang tiap siklus (tanpa restart).
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "runner-alert-scan.js");

export function readRunnerSettings(file = path.join(ROOT, "strat.conf")) {
  const out = { enabled: false, intervalSec: 300 };
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const k = t.slice(0, t.indexOf("=")).trim();
    const v = t.slice(t.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (k === "RUNNER_AUTO_ENTRY") out.enabled = ["on", "true", "1", "yes"].includes(v);
    if (k === "RUNNER_SCAN_INTERVAL_SEC" && Number(v) >= 30) out.intervalSec = Number(v);
  }
  return out;
}

const ts = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }) + " WIB";

function runScan() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, stdio: "inherit", env: process.env });
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => {
      console.error(`[runner] ${ts()} gagal spawn: ${err.message}`);
      resolve(1);
    });
  });
}

async function loop() {
  for (;;) {
    const s = readRunnerSettings();
    if (!s.enabled) {
      console.log(`[runner] ${ts()} RUNNER_AUTO_ENTRY=off — idle (cek ulang ${s.intervalSec}s)`);
    } else {
      console.log(`[runner] ${ts()} RUNNER_AUTO_ENTRY=on — scan mulai`);
      const code = await runScan();
      console.log(`[runner] ${ts()} scan selesai (exit ${code}), berikutnya ${s.intervalSec}s`);
    }
    await new Promise((r) => setTimeout(r, s.intervalSec * 1000));
  }
}

const isMain =
  process.env.pm_id !== undefined || // PM2 (argv[1] = PM2 container, bukan file ini)
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  console.log(`[runner] ${ts()} worker start (pid ${process.pid})`);
  const hbSec = Number(process.env.RUNNER_HEARTBEAT_SEC) || 60;
  setInterval(() => {
    const s = readRunnerSettings();
    console.log(`[runner] ${ts()} heartbeat alive — RUNNER_AUTO_ENTRY=${s.enabled ? "on" : "off"}`);
  }, hbSec * 1000).unref?.();
  loop();
}
