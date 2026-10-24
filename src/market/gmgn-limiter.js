import fs from "fs";
import path from "path";
import config from "../config/index.js";
import log from "../core/logger.js";
import { ROOT } from "../core/paths.js";
import { sleep } from "../core/utils.js";

const STALE_LOCK_MS = 5000;

export function priorityRank(priority) {
  if (priority === 1 || priority === "exit" || priority === "high") return 1;
  return 2;
}

function defaultStateFile() {
  if (process.env.GMGN_RATE_STATE_FILE && process.env.GMGN_RATE_STATE_FILE.trim()) {
    return path.resolve(process.env.GMGN_RATE_STATE_FILE.trim());
  }
  return path.resolve(ROOT, config.gmgnRateStateFile || "gmgn-rate-state.json");
}

function emptyRateState() {
  return {
    nextSlotAt: 0,
    blockedUntil: 0,
    exitWantedUntil: 0,
    lastPriority: "normal",
    lastPid: 0,
    updatedAt: 0,
  };
}

export function readRateState(file = defaultStateFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return emptyRateState();
    return {
      nextSlotAt: Number(raw.nextSlotAt) || 0,
      blockedUntil: Number(raw.blockedUntil) || 0,
      exitWantedUntil: Number(raw.exitWantedUntil) || 0,
      lastPriority: raw.lastPriority || "normal",
      lastPid: Number(raw.lastPid) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return emptyRateState();
  }
}

function writeRateState(file, state) {
  const payload = JSON.stringify(state);
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmpFile, payload);
    fs.renameSync(tmpFile, file);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.writeFileSync(file, payload);
    } catch {}
  }
}

async function withRateStateLock(file, fn) {
  const lockFile = `${file}.lock`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fd = fs.openSync(lockFile, "wx");
      break;
    } catch {
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      await sleep(10);
    }
  }

  try {
    const now = Date.now();
    const state = readRateState(file);
    const result = fn(state, now);
    writeRateState(file, state);
    return result;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
  }
}

// Antrean terpusat untuk SEMUA panggilan GMGN.
// - laju dibatasi maxPerMin (rolling 60s window)
// - jarak minimum antar panggilan minGapMs (in-process + lintas worker via file slot)
// - antrean berprioritas: "exit" / "high" selalu didahulukan di depan "entry" / "normal"
// - saat 429/ban: pause sampai reset, turunkan cap sementara, dan otomatis pulihkan
//   cap kembali ke maxPerMin begitu cooldown selesai & request sukses
// - dedup in-flight per key: pemanggil bersamaan berbagi hasil yang sama
export function createGmgnLimiter({
  maxPerMin = 45,
  minGapMs = 1200,
  crossProcess = false,
  stateFile = null,
} = {}) {
  const stamps = [];
  const queue = [];
  const inflight = new Map();
  let draining = false;
  let blockedUntil = 0;
  const baseCap = Math.max(1, Number(maxPerMin) || 1);
  let currentCap = baseCap;
  let totalCalls = 0;
  let totalRateLimited = 0;

  function isCrossProcess() {
    return typeof crossProcess === "function" ? Boolean(crossProcess()) : Boolean(crossProcess);
  }

  function getStateFile() {
    return stateFile || defaultStateFile();
  }

  function prune(now) {
    const cutoff = now - 60000;
    while (stamps.length && stamps[0] <= cutoff) stamps.shift();
  }

  function nextAllowedAt(now = Date.now()) {
    if (isCrossProcess()) {
      const disk = readRateState(getStateFile());
      if (disk.blockedUntil > blockedUntil) blockedUntil = disk.blockedUntil;
    }
    let t = Math.max(now, blockedUntil);
    prune(t);
    if (stamps.length >= currentCap) {
      const idx = stamps.length - currentCap;
      t = Math.max(t, stamps[idx] + 60000);
    }
    const last = stamps[stamps.length - 1] || 0;
    if (last && minGapMs > 0) t = Math.max(t, last + minGapMs);
    if (isCrossProcess()) {
      const disk = readRateState(getStateFile());
      if (disk.nextSlotAt > t) t = disk.nextSlotAt;
    }
    return t;
  }

  async function reserveCrossProcessSlot(task) {
    const file = getStateFile();
    const rank = priorityRank(task?.priority);

    // Jika task ini berprioritas normal (entry) dan worker exit sedang meminta slot,
    // beri kesempatan singkat agar worker exit mengambil slot lebih dulu.
    if (rank > 1) {
      for (let i = 0; i < 6; i++) {
        const disk = readRateState(file);
        if (disk.exitWantedUntil <= Date.now()) break;
        await sleep(40);
      }
    }

    const hasMoreHigh = queue.some((t) => t !== task && priorityRank(t.priority) === 1);
    const slotAt = await withRateStateLock(file, (state, now) => {
      if (state.blockedUntil > blockedUntil) {
        blockedUntil = state.blockedUntil;
      }
      let localNext = Math.max(now, blockedUntil);
      prune(localNext);
      if (stamps.length >= currentCap) {
        const idx = stamps.length - currentCap;
        localNext = Math.max(localNext, stamps[idx] + 60000);
      }
      const last = stamps[stamps.length - 1] || 0;
      if (last && minGapMs > 0) localNext = Math.max(localNext, last + minGapMs);

      const reservedAt = Math.max(localNext, Number(state.nextSlotAt) || 0);
      state.nextSlotAt = reservedAt + Math.max(0, minGapMs);
      state.lastPriority = rank === 1 ? "exit" : "entry";
      state.lastPid = process.pid;
      state.updatedAt = now;
      if (rank === 1) {
        state.exitWantedUntil = hasMoreHigh ? reservedAt + Math.max(minGapMs * 2, 2500) : 0;
      }
      return reservedAt;
    });

    return slotAt;
  }

  function insertByPriority(item) {
    const itemRank = priorityRank(item.priority);
    const idx = queue.findIndex((q) => priorityRank(q.priority) > itemRank);
    if (idx === -1) queue.push(item);
    else queue.splice(idx, 0, item);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        if (isCrossProcess()) {
          const slotAt = await reserveCrossProcessSlot(queue[0]);
          const wait = slotAt - Date.now();
          if (wait > 0) await sleep(wait);
        } else {
          const wait = nextAllowedAt() - Date.now();
          if (wait > 0) await sleep(wait);
        }

        const task = queue.shift();
        if (!task) continue;
        stamps.push(Date.now());
        totalCalls++;
        try {
          const res = await task.fn();
          // Auto-recovery: pulihkan currentCap secara bertahap menuju baseCap
          // setelah periode cooldown selesai dan request berhasil.
          if (Date.now() >= blockedUntil && currentCap < baseCap) {
            const prevCap = currentCap;
            currentCap = Math.min(baseCap, Math.max(currentCap + 1, currentCap * 2));
            if (currentCap !== prevCap) {
              log.info(`GMGN limiter: cooldown selesai — cap pulih ${prevCap} → ${currentCap}/menit`);
            }
          }
          task.resolve(res);
        } catch (err) {
          task.reject(err);
        } finally {
          if (task.key) inflight.delete(task.key);
        }
      }
    } finally {
      draining = false;
    }
  }

  function schedule(key, fn, { priority = "normal" } = {}) {
    if (key && inflight.has(key)) {
      // Jika panggilan baru punya prioritas lebih tinggi (mis. exit meminta mint
      // yang sedang antre oleh entry), naikkan prioritas item di antrean.
      if (priorityRank(priority) === 1) {
        const idx = queue.findIndex((q) => q.key === key);
        if (idx !== -1 && priorityRank(queue[idx].priority) > 1) {
          const [upgraded] = queue.splice(idx, 1);
          upgraded.priority = priority;
          insertByPriority(upgraded);
        }
      }
      return inflight.get(key);
    }

    let resolve;
    let reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (key) inflight.set(key, p);

    const item = { key, fn, resolve, reject, priority };
    insertByPriority(item);

    if (isCrossProcess() && priorityRank(priority) === 1) {
      const file = getStateFile();
      withRateStateLock(file, (state, now) => {
        state.exitWantedUntil = Math.max(state.exitWantedUntil || 0, now + Math.max(minGapMs * 2, 2500));
        state.updatedAt = now;
      }).catch(() => {});
    }

    drain();
    return p;
  }

  // Pause karena 429/ban. Adaptive: turunkan cap sementara (akan pulih otomatis setelah cooldown).
  function blockFor(ms, { adaptive = true } = {}) {
    const pause = Math.max(1000, Number(ms) || 0);
    blockedUntil = Math.max(blockedUntil, Date.now() + pause);
    totalRateLimited++;
    if (adaptive && currentCap > 1) {
      currentCap = Math.max(1, Math.floor(currentCap / 2));
      log.warn(`GMGN limiter: rate-limit/ban — cap turun ke ${currentCap}/menit, pause ${Math.ceil(pause / 1000)}s`);
    } else {
      log.warn(`GMGN limiter: pause ${Math.ceil(pause / 1000)}s`);
    }
    if (isCrossProcess()) {
      const file = getStateFile();
      withRateStateLock(file, (state, now) => {
        state.blockedUntil = Math.max(state.blockedUntil || 0, blockedUntil);
        state.nextSlotAt = Math.max(state.nextSlotAt || 0, blockedUntil);
        state.updatedAt = now;
      }).catch(() => {});
    }
  }

  function stats() {
    prune(Date.now());
    return {
      queue: queue.length,
      callsLastMin: stamps.length,
      cap: currentCap,
      baseCap,
      totalCalls,
      totalRateLimited,
      blockedForMs: Math.max(0, blockedUntil - Date.now()),
    };
  }

  return {
    schedule,
    blockFor,
    stats,
    isBlocked: () => Date.now() < blockedUntil,
    nextAllowedAt,
  };
}

const gmgnLimiter = createGmgnLimiter({
  maxPerMin: config.gmgnMaxPerMin,
  minGapMs: Math.max(0, Number(config.gmgnMinGapSec) || 0) * 1000,
  crossProcess: () => Boolean(config.gmgnCentralCollector),
});

export default gmgnLimiter;
