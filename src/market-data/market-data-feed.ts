import type { Logger } from "../monitoring/logger.js";
import type { AlertManager } from "../monitoring/alerts.js";
import { SequenceTracker } from "./sequence.js";
import { StalenessDetector } from "./staleness.js";
import { WsManager, type WsFactory } from "./ws-manager.js";

export interface PriceTick {
  readonly symbol: string;
  readonly price: number;
  readonly at: number;
}

export interface MarketDataFeedOptions {
  readonly symbols: readonly string[];
  /** ör. wss://stream.testnet.binance.vision */
  readonly streamBase: string;
  /** ör. https://testnet.binance.vision — REST snapshot resync için. */
  readonly restBase: string;
  readonly logger: Logger;
  readonly alerts: AlertManager;
  readonly staleness: StalenessDetector;
  readonly wsFactory?: WsFactory;
  readonly fetchFn?: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
  readonly heartbeatTimeoutMs?: number;
}

interface CombinedStreamMessage {
  stream?: string;
  data?: { e?: string; s?: string; p?: string; T?: number; t?: number };
}

/**
 * Binance combined trade stream tüketicisi. Faz 1'in özü:
 * bağlan, veriyi al, durumu tut, kopunca toparlan.
 * - Reconnect'te REST snapshot ile fiyatlar resync edilir.
 * - Trade id sequence'ı ile boşluk tespit edilir (kaçan mesaj → alarm).
 * - Her tick staleness dedektörünü besler.
 */
export class MarketDataFeed {
  private readonly prices = new Map<string, PriceTick>();
  private readonly sequences = new Map<string, SequenceTracker>();
  private readonly manager: WsManager;
  private readonly fetchFn: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

  constructor(private readonly options: MarketDataFeedOptions) {
    if (options.symbols.length === 0) {
      throw new Error("En az bir sembol gerekli");
    }
    this.fetchFn = options.fetchFn ?? (fetch as unknown as MarketDataFeedOptions["fetchFn"])!;
    const streams = options.symbols.map((s) => `${s.toLowerCase()}@trade`).join("/");
    this.manager = new WsManager({
      url: `${options.streamBase}/stream?streams=${streams}`,
      logger: options.logger,
      onMessage: (data) => this.handleMessage(data),
      onResync: () => this.resyncFromRest(),
      onFatal: (reason) =>
        options.alerts.raise("fatal", "market data bağlantısı kalıcı olarak düştü", { reason }),
      ...(options.wsFactory !== undefined ? { factory: options.wsFactory } : {}),
      ...(options.heartbeatTimeoutMs !== undefined
        ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
        : {}),
    });
  }

  start(): void {
    this.manager.start();
  }

  stop(): void {
    this.manager.stop();
  }

  isConnected(): boolean {
    return this.manager.isConnected();
  }

  lastPrice(symbol: string): PriceTick | undefined {
    return this.prices.get(symbol.toUpperCase());
  }

  /**
   * REST snapshot resync — reconnect'te kaldığın yerden devam ettiğini
   * varsayma. Sequence takipçileri de sıfırlanır (yeni akış, yeni takip).
   */
  private async resyncFromRest(): Promise<void> {
    const symbolsParam = encodeURIComponent(
      JSON.stringify(this.options.symbols.map((s) => s.toUpperCase())),
    );
    const res = await this.fetchFn(`${this.options.restBase}/api/v3/ticker/price?symbols=${symbolsParam}`);
    if (res.status !== 200) {
      throw new Error(`snapshot alınamadı: HTTP ${res.status}`);
    }
    const tickers = (await res.json()) as { symbol: string; price: string }[];
    const at = Date.now();
    for (const t of tickers) {
      this.prices.set(t.symbol.toUpperCase(), { symbol: t.symbol.toUpperCase(), price: Number(t.price), at });
    }
    for (const tracker of this.sequences.values()) tracker.reset();
    this.options.staleness.onTick();
    this.options.logger.info("REST snapshot resync tamam", { symbols: tickers.length });
  }

  private handleMessage(raw: string): void {
    let parsed: CombinedStreamMessage;
    try {
      parsed = JSON.parse(raw) as CombinedStreamMessage;
    } catch {
      this.options.logger.warn("çözümlenemeyen ws mesajı atlandı");
      return;
    }
    const data = parsed.data;
    if (data?.e !== "trade" || data.s === undefined || data.p === undefined) return;

    const symbol = data.s.toUpperCase();
    const price = Number(data.p);
    if (!Number.isFinite(price) || price <= 0) {
      this.options.logger.warn("geçersiz fiyat atlandı", { symbol, raw: data.p });
      return;
    }

    if (data.t !== undefined) {
      let tracker = this.sequences.get(symbol);
      if (tracker === undefined) {
        tracker = new SequenceTracker();
        this.sequences.set(symbol, tracker);
      }
      const check = tracker.next(data.t);
      if (check === "gap") {
        // Trade akışında boşluk: fiyat için kritik değil ama görünür olmalı.
        this.options.alerts.raise("ws_gap", "trade akışında sequence boşluğu", {
          symbol,
          tradeId: data.t,
        });
      } else if (check === "duplicate") {
        return; // aynı trade iki kez işlenmez
      }
    }

    this.prices.set(symbol, { symbol, price, at: data.T ?? Date.now() });
    this.options.staleness.onTick();
  }
}
