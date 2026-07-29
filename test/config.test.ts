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
    expect(config.killSwitchFile).toBe("/tmp/ks");
    expect(config.stateDir).toBe("/tmp/state");
    expect(config.staleDataThresholdMs).toBe(5000);
  });

  it("geçersiz eşiği reddeder", () => {
    expect(() => loadConfig({ STALE_DATA_THRESHOLD_MS: "-1" })).toThrow();
    expect(() => loadConfig({ STALE_DATA_THRESHOLD_MS: "abc" })).toThrow();
  });
});
