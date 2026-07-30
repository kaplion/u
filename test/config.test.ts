import { describe, expect, it } from "vitest";
import { parseMode } from "../src/config/mode.js";
import { loadConfig } from "../src/config/config.js";

describe("parseMode", () => {
  it("varsayılan olarak DRY_RUN döner — asla LIVE değil", () => {
    expect(parseMode(undefined)).toBe("DRY_RUN");
    expect(parseMode("")).toBe("DRY_RUN");
  });

  it("geçerli modları kabul eder", () => {
    expect(parseMode("DRY_RUN")).toBe("DRY_RUN");
    expect(parseMode("PAPER")).toBe("PAPER");
    expect(parseMode("LIVE")).toBe("LIVE");
  });

  it("geçersiz modu reddeder", () => {
    expect(() => parseMode("live")).toThrow(/Geçersiz mod/);
    expect(() => parseMode("PROD")).toThrow(/Geçersiz mod/);
  });
});

describe("loadConfig", () => {
  it("environment'tan okur", () => {
    const config = loadConfig({
      BOT_MODE: "PAPER",
      KILL_SWITCH_FILE: "/tmp/ks",
      STATE_DIR: "/tmp/state",
      STALE_DATA_THRESHOLD_MS: "5000",
    });
    expect(config.mode).toBe("PAPER");
    expect(config.venue).toBe("binance");
    expect(config.assetClass).toBe("crypto");
    expect(config.killSwitchFile).toBe("/tmp/ks");
    expect(config.stateDir).toBe("/tmp/state");
    expect(config.staleDataThresholdMs).toBe(5000);
    expect(config.marketDataPollIntervalMs).toBe(5000);
  });

  it("geçersiz eşiği reddeder", () => {
    expect(() => loadConfig({ STALE_DATA_THRESHOLD_MS: "-1" })).toThrow();
    expect(() => loadConfig({ STALE_DATA_THRESHOLD_MS: "abc" })).toThrow();
  });

  it("ig venue ve forex sembol normalizasyonunu kabul eder", () => {
    const config = loadConfig({
      VENUE: "ig",
      SYMBOLS: "eur/usd, gbpusd",
      MARKET_DATA_POLL_INTERVAL_MS: "2000",
      FOREX_MARGIN_USAGE_LIMIT: "0.7",
      FOREX_MARGIN_ALERT_THRESHOLD: "0.5",
    });
    expect(config.venue).toBe("ig");
    expect(config.assetClass).toBe("forex");
    expect(config.symbols).toEqual(["EURUSD", "GBPUSD"]);
    expect(config.symbolSpecs.map((spec) => spec.pipSize)).toEqual([0.0001, 0.0001]);
    expect(config.marketDataPollIntervalMs).toBe(2000);
    expect(config.forexMarginUsageLimit).toBe(0.7);
    expect(config.forexMarginAlertThreshold).toBe(0.5);
  });
});
