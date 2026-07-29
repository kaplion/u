import { parseMode, type Mode } from "./mode.js";

export type VenueName = "binance" | "alpaca";

export interface Config {
  readonly mode: Mode;
  /** Aktif venue adaptörü (Faz 5: ikinci venue). */
  readonly venue: VenueName;
  /** Kill switch dosya yolu — dosya varsa yeni risk durur. */
  readonly killSwitchFile: string;
  /** Kalıcı state dizini. */
  readonly stateDir: string;
  /** Bayat veri eşiği (ms) — beklenen aralığın 3 katı önerilir. */
  readonly staleDataThresholdMs: number;
  /** İzlenecek semboller (ör. BTCUSDT). */
  readonly symbols: readonly string[];
  /** Periyodik rekonsiliasyon aralığı (ms) — spec gereği en fazla 60sn. */
  readonly reconcileIntervalMs: number;
  /** Heartbeat yazma aralığı (ms). */
  readonly heartbeatIntervalMs: number;
  /** Emir gönderim timeout'u (ms) — aşılırsa UNKNOWN + venue sorgusu. */
  readonly orderTimeoutMs: number;
  /** Kısmi dolum karar süresi (ms) — aşılırsa politika uygulanır. */
  readonly partialFillTimeoutMs: number;
  /** Dashboard portu — 0 ise dashboard kapalı. */
  readonly dashboardPort: number;
  /** Dashboard host'u — varsayılan yalnızca loopback. */
  readonly dashboardHost: string;
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
    venue: parseVenue(env.VENUE),
    killSwitchFile: env.KILL_SWITCH_FILE ?? "KILL_SWITCH",
    stateDir: env.STATE_DIR ?? "state",
    staleDataThresholdMs: parsePositiveInt(
      env.STALE_DATA_THRESHOLD_MS,
      15_000,
      "STALE_DATA_THRESHOLD_MS",
    ),
    symbols: parseSymbols(env.SYMBOLS),
    reconcileIntervalMs: Math.min(
      parsePositiveInt(env.RECONCILE_INTERVAL_MS, 60_000, "RECONCILE_INTERVAL_MS"),
      60_000, // spec: rekonsiliasyon aralığı ≤ 60sn
    ),
    heartbeatIntervalMs: parsePositiveInt(
      env.HEARTBEAT_INTERVAL_MS,
      10_000,
      "HEARTBEAT_INTERVAL_MS",
    ),
    orderTimeoutMs: parsePositiveInt(env.ORDER_TIMEOUT_MS, 5_000, "ORDER_TIMEOUT_MS"),
    partialFillTimeoutMs: parsePositiveInt(
      env.PARTIAL_FILL_TIMEOUT_MS,
      30_000,
      "PARTIAL_FILL_TIMEOUT_MS",
    ),
    dashboardPort: parseNonNegativeInt(env.DASHBOARD_PORT, 0, "DASHBOARD_PORT"),
    dashboardHost: env.DASHBOARD_HOST ?? "127.0.0.1",
  };
}

function parseVenue(value: string | undefined): VenueName {
  const venue = value === undefined || value === "" ? "binance" : value.toLowerCase();
  if (venue === "binance" || venue === "alpaca") return venue;
  throw new Error(`Geçersiz VENUE: "${value}". Geçerli değerler: binance, alpaca`);
}

function parseSymbols(value: string | undefined): readonly string[] {
  const raw = value === undefined || value === "" ? "BTCUSDT" : value;
  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "");
  if (symbols.length === 0) {
    throw new Error(`SYMBOLS en az bir sembol içermeli, alınan: "${value}"`);
  }
  return symbols;
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

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} negatif olmayan bir tam sayı olmalı, alınan: "${value}"`);
  }
  return n;
}
