import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/core -> src -> project root
export const SRC_DIR = path.resolve(__dirname, "..");
export const ROOT = path.resolve(SRC_DIR, "..");

// Path data bisa di-override lewat env (dipakai test agar tidak menyentuh
// file produksi).
function resolveFile(envName, fallbackName) {
  const override = process.env[envName];
  return override && override.trim() ? override : path.resolve(ROOT, fallbackName);
}

export const ENV_FILE = path.join(ROOT, ".env");
// strat.conf = tuning lokal (gitignored, tidak ditimpa git pull).
// STRAT_FILE di env menunjuk file lain; kalau di-set, tidak ada fallback.
export const STRAT_FILE = resolveFile("STRAT_FILE", "strat.conf");
// Template yang di-commit. Dipakai bila strat.conf belum ada.
export const STRAT_EXAMPLE_FILE = path.resolve(ROOT, "strat.conf.example");
export const LOG_DIR = path.join(ROOT, "logs");
export const IMPORTANT_LOG_FILE = resolveFile("IMPORTANT_LOG_FILE", path.join("logs", "important.log"));
export const IMPORTANT_EVENTS_FILE = resolveFile("IMPORTANT_EVENTS_FILE", path.join("logs", "important-events.jsonl"));
export const STATE_FILE = resolveFile("STATE_FILE", "state.json");
export const DECISION_LOG_FILE = resolveFile("DECISION_LOG_FILE", "decision-log.json");
export const PNL_HISTORY_FILE = resolveFile("PNL_HISTORY_FILE", "pnl-history.json");
// Antrean klik Telegram. Worker telegram menulis; worker exit membaca.
// Bukan state.json — worker telegram tidak boleh menulis state posisi.
export const TELEGRAM_COMMANDS_FILE = resolveFile(
  "TELEGRAM_COMMANDS_FILE",
  path.join("state", "telegram-commands.json")
);
export const TELEGRAM_OFFSET_FILE = resolveFile("TELEGRAM_OFFSET_FILE", path.join("state", "telegram-offset.json"));
export const TELEGRAM_BUTTONS_FILE = resolveFile("TELEGRAM_BUTTONS_FILE", path.join("state", "telegram-buttons.json"));
export const RUNTIME_STATE_FILE = resolveFile(
  "RUNTIME_STATE_FILE",
  process.env.STATE_FILE && process.env.STATE_FILE.trim()
    ? path.join(path.dirname(process.env.STATE_FILE.trim()), "runtime-state.json")
    : "runtime-state.json"
);
