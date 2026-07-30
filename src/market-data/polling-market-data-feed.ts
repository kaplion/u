import type { Logger } from "../monitoring/logger.js";
import type { AlertManager } from "../monitoring/alerts.js";
import { StalenessDetector } from "./staleness.js";
import type { PriceTick } from "./market-data-feed.js";
import type { VenuePriceTick } from "../venues/venue-adapter.js";

export interface PollingMarketDataFeedOptions {
  readonly symbols: readonly string[];
  readonly pollIntervalMs: number;
  readonly logger: Logger;
  readonly alerts: AlertManager;
  readonly staleness: StalenessDetector;
  readonly fetchLatestPrices: (symbols: readonly string[]) => Promise<readonly VenuePriceTick[]>;
}

/**
 * REST polling feed'i. TODO(IG): Lightstreamer entegrasyonu aynı arayüzün
 * arkasına takılmalı; ilk aşamada polling yeterlidir.
 */
export class PollingMarketDataFeed {
  private readonly prices = new Map<string, PriceTick>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private connected = false;
  private polling = false;

  constructor(private readonly options: PollingMarketDataFeedOptions) {
    if (options.symbols.length === 0) {
      throw new Error("En az bir sembol gerekli");
    }
  }

  start(): void {
    this.stop();
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastPrice(symbol: string): PriceTick | undefined {
    return this.prices.get(symbol.toUpperCase());
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const ticks = await this.options.fetchLatestPrices(this.options.symbols);
      for (const tick of ticks) {
        this.prices.set(tick.symbol.toUpperCase(), {
          symbol: tick.symbol.toUpperCase(),
          price: tick.price,
          at: tick.at,
        });
      }
      if (ticks.length > 0) {
        this.connected = true;
        this.options.staleness.onTick();
      }
    } catch (err) {
      this.connected = false;
      this.options.logger.warn("polling fiyat güncellemesi başarısız", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.polling = false;
    }
  }
}
