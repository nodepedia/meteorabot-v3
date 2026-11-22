import fs from "fs";
import path from "path";
import { ENV_FILE, STRAT_EXAMPLE_FILE, STRAT_FILE } from "../core/paths.js";

function parseEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function exampleKeysMissing(stratFile, exampleFile) {
  const have = parseEnvFile(stratFile);
  const example = parseEnvFile(exampleFile);
  return Object.keys(example)
    .filter((key) => !Object.prototype.hasOwnProperty.call(have, key))
    .sort();
}

// strat.conf lokal menang atas .env. File tidak ada → strat.conf.example.
// Path eksplisit (argumen atau STRAT_FILE) tidak di-fallback.
// Saat tes, tanpa path eksplisit, yang dibaca selalu contoh supaya
// strat.conf milik operator tidak mengubah hasil tes.
export function resolveStratSource({
  stratFile = STRAT_FILE,
  exampleFile = STRAT_EXAMPLE_FILE,
  allowFallback = true,
  testMode = false,
} = {}) {
  const strat = path.resolve(stratFile);
  const example = path.resolve(exampleFile);
  if (testMode && allowFallback) {
    return { file: example, source: "example", missingKeys: [], reason: "test" };
  }
  if (fs.existsSync(strat)) {
    const missingKeys = allowFallback ? exampleKeysMissing(strat, example) : [];
    return { file: strat, source: "strat", missingKeys, reason: "present" };
  }
  if (allowFallback && fs.existsSync(example)) {
    return { file: example, source: "example", missingKeys: [], reason: "missing" };
  }
  return { file: strat, source: "missing", missingKeys: [], reason: allowFallback ? "absent" : "pinned" };
}

export function stratSourceWarning(decision) {
  if (!decision || decision.reason === "test") return null;
  if (decision.reason === "missing") {
    return (
      "strat.conf tidak ditemukan. Memakai strat.conf.example. " +
      "Salin sekali: cp strat.conf.example strat.conf — git pull tidak menimpa strat.conf."
    );
  }
  if (decision.reason === "absent") {
    return "strat.conf dan strat.conf.example tidak ada. Semua kunci memakai default di kode.";
  }
  if (decision.source === "strat" && decision.missingKeys.length > 0) {
    return `Kunci ini tidak ada di strat.conf, memakai default: ${decision.missingKeys.join(", ")}`;
  }
  return null;
}

let warned = false;

function warnStratOnce(decision) {
  if (warned || process.env.NODE_TEST_CONTEXT) return;
  const message = stratSourceWarning(decision);
  if (!message) return;
  warned = true;
  console.warn(`[strat] ${message}`);
}

// stratFile eksplisit, atau STRAT_FILE di env, dipakai apa adanya.
export function loadEnv(stratFile, envFile = ENV_FILE) {
  const pinned = stratFile != null || Boolean(process.env.STRAT_FILE && process.env.STRAT_FILE.trim());
  const decision = resolveStratSource({
    stratFile: stratFile != null ? stratFile : STRAT_FILE,
    allowFallback: !pinned,
    testMode: !pinned && Boolean(process.env.NODE_TEST_CONTEXT),
  });
  warnStratOnce(decision);
  const stratEnv = decision.source === "missing" ? {} : parseEnvFile(decision.file);
  return { ...parseEnvFile(envFile), ...stratEnv };
}

export const bool = (val, def = true) => (val == null ? def : val !== "false");

export const num = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) && val !== "" && val != null ? n : def;
};
