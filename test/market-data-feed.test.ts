import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketDataFeed } from "../src/market-data/market-data-feed.js";
import { StalenessDetector } from "../src/market-data/staleness.js";
import type { WsTransport } from "../src/market-data/ws-manager.js";
import { AlertManager, type Alert } from "../src/monitoring/alerts.js";
import { Logger } from "../src/monitoring/logger.js";

const silentLogger = new Logger("PAPER", () => {});

class FakeWs implements WsTransport {
  onopen: (() => void) | undefined;
  onmessage: ((data: string) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: ((err: unknown) => void) | undefined;
  send(): void {}
  close(): void {}
  open(): void {
    this.onopen?.();
  }
  trade(symbol: string, price: string, tradeId: number): void {
    this.onmessage?.(
      JSON.stringify({
        stream: `${symbol.toLowerCase()}@trade`,
        data: { e: "trade", s: symbol, p: price, T: 1_700_000_000_000, t: tradeId },
      }),
    );
  }
}

function setup(snapshotPrices: Record<string, string> = { BTCUSDT: "50000" }) {
  const sockets: FakeWs[] = [];
  const alertsReceived: Alert[] = [];
  const urls: string[] = [];
  const staleness = new StalenessDetector(60_000);
  const feed = new MarketDataFeed({
    symbols: ["BTCUSDT"],
    streamBase: "wss://stream.testnet.binance.vision",
    restBase: "https://testnet.binance.vision",
    logger: silentLogger,
    alerts: new AlertManager(silentLogger, [{ send: (a) => void alertsReceived.push(a) }]),
    staleness,
    wsFactory: (url) => {
      urls.push(url);
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    fetchFn: async (url) => {
      urls.push(url);
      return {
        status: 200,
        json: async () =>
          Object.entries(snapshotPrices).map(([symbol, price]) => ({ symbol, price })),
      };
    },
  });
  return { feed, sockets, alertsReceived, urls, staleness };
}

describe("MarketDataFeed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bağlanınca REST snapshot ile fiyatları doldurur (resync)", async () => {
    const { feed, sockets, urls } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(feed.isConnected()).toBe(true);
    expect(feed.lastPrice("BTCUSDT")?.price).toBe(50_000);
    expect(urls.some((u) => u.includes("/stream?streams=btcusdt@trade"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/v3/ticker/price"))).toBe(true);
    feed.stop();
  });

  it("trade mesajı fiyatı günceller ve staleness'ı besler", async () => {
    const { feed, sockets, staleness } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();

    sockets[0]!.trade("BTCUSDT", "51000.5", 100);
    expect(feed.lastPrice("BTCUSDT")?.price).toBe(51_000.5);
    expect(staleness.isStale()).toBe(false);
    feed.stop();
  });

  it("sequence boşluğunda alarm çıkarır", async () => {
    const { feed, sockets, alertsReceived } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();

    sockets[0]!.trade("BTCUSDT", "51000", 100);
    sockets[0]!.trade("BTCUSDT", "51001", 101);
    sockets[0]!.trade("BTCUSDT", "51005", 105); // boşluk: 102-104 kayıp
    expect(alertsReceived.some((a) => a.kind === "ws_gap")).toBe(true);
    feed.stop();
  });

  it("duplicate trade işlenmez", async () => {
    const { feed, sockets } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();

    sockets[0]!.trade("BTCUSDT", "51000", 100);
    sockets[0]!.trade("BTCUSDT", "99999", 100); // aynı trade id
    expect(feed.lastPrice("BTCUSDT")?.price).toBe(51_000);
    feed.stop();
  });

  it("geçersiz fiyat ve bozuk mesaj atlanır", async () => {
    const { feed, sockets } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();

    sockets[0]!.onmessage?.("bu json değil");
    sockets[0]!.trade("BTCUSDT", "-5", 200);
    sockets[0]!.trade("BTCUSDT", "abc", 201);
    expect(feed.lastPrice("BTCUSDT")?.price).toBe(50_000); // snapshot değeri korunur
    feed.stop();
  });

  it("kopma sonrası reconnect'te yeniden snapshot çeker ve sequence sıfırlanır", async () => {
    const { feed, sockets, urls, alertsReceived } = setup();
    feed.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    sockets[0]!.trade("BTCUSDT", "51000", 100);

    sockets[0]!.onclose?.(); // bağlantı düştü
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(feed.isConnected()).toBe(true);

    const snapshotCalls = urls.filter((u) => u.includes("/api/v3/ticker/price"));
    expect(snapshotCalls).toHaveLength(2);

    // Yeni akışta trade id çok farklı olabilir — reset sonrası gap alarmı YOK.
    sockets[1]!.trade("BTCUSDT", "52000", 5_000);
    expect(alertsReceived.filter((a) => a.kind === "ws_gap")).toHaveLength(0);
    feed.stop();
  });

  it("sembol olmadan feed kurulamaz", () => {
    expect(
      () =>
        new MarketDataFeed({
          symbols: [],
          streamBase: "wss://x",
          restBase: "https://x",
          logger: silentLogger,
          alerts: new AlertManager(silentLogger),
          staleness: new StalenessDetector(1000),
        }),
    ).toThrow(/sembol/);
  });
});
