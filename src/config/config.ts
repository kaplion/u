import { parseMode, type Mode } from "./mode.js";
import {
  assetClassForVenue,
  type AssetClass,
  type SymbolSpec,
  symbolSpecForVenueSymbol,
} from "../venues/asset-class.js";

export type VenueName = "binance" | "alpaca" | "ig";

export interface Config {
  readonly mode: Mode;
  /** Aktif venue adaptörü (Faz 5: ikinci venue). */
  readonly venue: VenueName;
  /** Venue'dan türeyen varsayılan varlık sınıfı. */
  readonly assetClass: AssetClass;
  /** Kill switch dosya yolu — dosya varsa yeni risk durur. */
  readonly killSwitchFile: string;
  /** Kalıcı state dizini. */
  readonly stateDir: string;
  /** Bayat veri eşiği (ms) — beklenen aralığın 3 katı önerilir. */
  readonly staleDataThresholdMs: number;
  /** İzlenecek semboller (ör. BTCUSDT). */
  readonly symbols: readonly string[];
  /** Sembol bazında varlık sınıfı / lot / pip bilgisi. */
  readonly symbolSpecs: readonly SymbolSpec[];
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
  /** REST polling aralığı (özellikle Alpaca/IG). */
  readonly marketDataPollIntervalMs: number;
  /** Forex margin kullanım eşiği — aşılırsa yeni risk durur. */
  readonly forexMarginUsageLimit: number;
  /** Forex margin alarm eşiği — yaklaşırken alarm üretir. */
  readonly forexMarginAlertThreshold: number;
}

/**
 * Config yalnızca environment'tan okunur. API anahtarları da environment'ta
 * durur (repoda, logda, hata mesajında asla) ve venue adaptörleri tarafından
 * doğrudan environment'tan okunur — Config nesnesinde taşınmaz, böylece
 * yanlışlıkla loglanamaz.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const venue = parseVenue(env.VENUE);
  const symbolSpecs = parseSymbols(env.SYMBOLS, venue);
  return {
    mode: parseMode(env.BOT_MODE),
    venue,
    assetClass: assetClassForVenue(venue),
    killSwitchFile: env.KILL_SWITCH_FILE ?? "KILL_SWITCH",
    stateDir: env.STATE_DIR ?? "state",
    staleDataThresholdMs: parsePositiveInt(
      env.STALE_DATA_THRESHOLD_MS,
      15_000,
      "STALE_DATA_THRESHOLD_MS",
    ),
    symbols: symbolSpecs.map((s) => s.symbol),
    symbolSpecs,
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
    marketDataPollIntervalMs: parsePositiveInt(
      env.MARKET_DATA_POLL_INTERVAL_MS,
      5_000,
      "MARKET_DATA_POLL_INTERVAL_MS",
    ),
    forexMarginUsageLimit: parseUnitInterval(
      env.FOREX_MARGIN_USAGE_LIMIT,
      0.5,
      "FOREX_MARGIN_USAGE_LIMIT",
    ),
    forexMarginAlertThreshold: parseUnitInterval(
      env.FOREX_MARGIN_ALERT_THRESHOLD,
      0.4,
      "FOREX_MARGIN_ALERT_THRESHOLD",
    ),
  };
}

function parseVenue(value: string | undefined): VenueName {
  const venue = value === undefined || value === "" ? "binance" : value.toLowerCase();
  if (venue === "binance" || venue === "alpaca" || venue === "ig") return venue;
  throw new Error(`Geçersiz VENUE: "${value}". Geçerli değerler: binance, alpaca, ig`);
}

function parseSymbols(value: string | undefined, venue: VenueName): readonly SymbolSpec[] {
  const raw = value === undefined || value === "" ? "BTCUSDT" : value;
  const symbols = raw
    .split(",")
    .map((s) => symbolSpecForVenueSymbol(s, venue))
    .filter((s) => s.symbol !== "");
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

function parseUnitInterval(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${name} 0 ile 1 arasında olmalı, alınan: "${value}"`);
  }
  return n;
}
