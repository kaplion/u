import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollingMarketDataFeed } from "../src/market-data/polling-market-data-feed.js";
import { StalenessDetector } from "../src/market-data/staleness.js";
import { AlertManager } from "../src/monitoring/alerts.js";
import { Logger } from "../src/monitoring/logger.js";

const silentLogger = new Logger("PAPER", () => {});

describe("PollingMarketDataFeed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("REST polling ile fiyatı günceller ve staleness'ı besler", async () => {
    const staleness = new StalenessDetector(60_000, () => 1_000);
    const feed = new PollingMarketDataFeed({
      symbols: ["EURUSD"],
      pollIntervalMs: 5_000,
      logger: silentLogger,
      alerts: new AlertManager(silentLogger),
      staleness,
      fetchLatestPrices: async () => [
        { symbol: "EURUSD", price: 1.1, at: 1_000, marketOpen: true },
      ],
    });
    feed.start();
    await vi.runOnlyPendingTimersAsync();
    expect(feed.isConnected()).toBe(true);
    expect(feed.lastPrice("EURUSD")?.price).toBe(1.1);
    expect(staleness.isStale()).toBe(false);
    feed.stop();
  });
});
