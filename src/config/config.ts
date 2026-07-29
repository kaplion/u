import { parseMode, type Mode } from "./mode.js";

export interface Config {
  readonly mode: Mode;
  /** Kill switch dosya yolu — dosya varsa yeni risk durur. */
  readonly killSwitchFile: string;
  /** Kalıcı state dizini. */
  readonly stateDir: string;
  /** Bayat veri eşiği (ms) — beklenen aralığın 3 katı önerilir. */
  readonly staleDataThresholdMs: number;
}

/**
 * Config yalnızca environment'tan okunur. API anahtarları da environment'ta
 * durur (repoda, logda, hata mesajında asla) ve venue adaptörleri tarafından
 * doğrudan environment'tan okunur — Config nesnesinde taşınmaz, böylece
 * yanlışlıkla loglanamaz.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mode: parseMode(env.BOT_MODE),
    killSwitchFile: env.KILL_SWITCH_FILE ?? "KILL_SWITCH",
    stateDir: env.STATE_DIR ?? "state",
    staleDataThresholdMs: parsePositiveInt(
      env.STALE_DATA_THRESHOLD_MS,
      15_000,
      "STALE_DATA_THRESHOLD_MS",
    ),
  };
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} pozitif bir tam sayı olmalı, alınan: "${value}"`);
  }
  return n;
}
