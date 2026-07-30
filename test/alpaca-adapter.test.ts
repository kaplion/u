import { describe, expect, it } from "vitest";
import {
  AlpacaAdapter,
  alpacaDataBase,
  alpacaRestBase,
  createAlpacaAdapterFromEnv,
  mapAlpacaStatus,
  type AlpacaFetchLike,
} from "../src/venues/alpaca/alpaca-adapter.js";
import { Logger } from "../src/monitoring/logger.js";
import type { Order } from "../src/oms/order.js";

const silentLogger = new Logger("PAPER", () => {});

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: StubResponse[]) {
  const requests: Recorded[] = [];
  const fetchFn: AlpacaFetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const stub = responses.shift() ?? {};
    const headerMap = stub.headers ?? {};
    return {
      status: stub.status ?? 200,
      headers: { get: (n: string) => headerMap[n] ?? null },
      json: async () => stub.body ?? {},
      text: async () => JSON.stringify(stub.body ?? {}),
    };
  };
  return { fetchFn, requests };
}

function makeAdapter(responses: StubResponse[], overrides: Record<string, unknown> = {}) {
  const { fetchFn, requests } = fakeFetch(responses);
  const adapter = new AlpacaAdapter({
    mode: "PAPER",
    apiKey: "key",
    apiSecret: "secret",
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
    ...overrides,
  });
  return { adapter, requests };
}

const baseOrder: Order = {
  clientOrderId: "bot-alp-1",
  symbol: "AAPL",
  side: "BUY",
  quantity: 10,
  price: 150,
  reduceOnly: false,
  state: "PENDING_NEW",
  filledQuantity: 0,
};

const activeAccount = { status: "ACTIVE", equity: "30000", daytrade_count: 0, cash: "10000" };
const openClock = { timestamp: "2024-01-02T15:00:00Z", is_open: true };

describe("Faz 5 — Alpaca mod izolasyonu", () => {
  it("yalnızca LIVE gerçek Alpaca'ya gider; PAPER ve DRY_RUN paper ortamına", () => {
    expect(alpacaRestBase("LIVE")).toBe("https://api.alpaca.markets");
    expect(alpacaRestBase("PAPER")).toBe("https://paper-api.alpaca.markets");
    expect(alpacaRestBase("DRY_RUN")).toBe("https://paper-api.alpaca.markets");
  });

  it("PAPER modda hiçbir istek gerçek host'a gitmez ve anahtar başlıkta taşınır", async () => {
    const { adapter, requests } = makeAdapter([{ body: openClock }]);
    await adapter.fetchServerTime();
    for (const req of requests) {
      expect(new URL(req.url).host).toBe("paper-api.alpaca.markets");
      expect(req.headers["APCA-API-KEY-ID"]).toBe("key");
    }
  });

  it("DRY_RUN'da emir gönderimi adaptör seviyesinde reddedilir", async () => {
    const { adapter } = makeAdapter([], { mode: "DRY_RUN" });
    await expect(adapter.submitOrder(baseOrder)).rejects.toThrow(/DRY_RUN/);
  });
});

describe("Faz 5 — connect hesabı doğrular", () => {
  it("bloke hesapla başlatmayı reddeder", async () => {
    const { adapter } = makeAdapter([{ body: { ...activeAccount, trading_blocked: true } }]);
    await expect(adapter.connect()).rejects.toThrow(/bloke/);
  });

  it("aktif hesabı kabul eder", async () => {
    const { adapter } = makeAdapter([{ body: activeAccount }]);
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("boş anahtar constructor'da reddedilir", () => {
    expect(
      () => new AlpacaAdapter({ mode: "PAPER", apiKey: "", apiSecret: "", logger: silentLogger }),
    ).toThrow();
  });
});

describe("Faz 5 — piyasa saatleri zorunluluğu", () => {
  it("seans dışında emir REDDEDİLİR", async () => {
    const { adapter, requests } = makeAdapter([
      { body: activeAccount },
      { body: { ...openClock, is_open: false } }, // clock: kapalı
    ]);
    await expect(adapter.submitOrder(baseOrder)).rejects.toThrow(/piyasa kapalı/);
    // Emir POST'u hiç atılmadı.
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("seans açıkken emir client_order_id ile gönderilir", async () => {
    const { adapter, requests } = makeAdapter([
      { body: activeAccount },
      { body: openClock },
      { body: activeAccount },
      {
        body: {
          id: "srv-1",
          client_order_id: "bot-alp-1",
          symbol: "AAPL",
          side: "buy",
          qty: "10",
          filled_qty: "0",
          limit_price: "150",
          status: "new",
        },
      },
    ]);
    const result = await adapter.submitOrder(baseOrder);
    expect(result.state).toBe("NEW");
    expect(result.clientOrderId).toBe("bot-alp-1");
    const post = requests.find((r) => r.method === "POST");
    expect(post).toBeDefined();
    expect(post!.body).toContain('"client_order_id":"bot-alp-1"'); // idempotency anahtarı
    expect(post!.body).toContain('"limit_price":"150"');
  });
});

describe("Faz 5 — PDT koruması", () => {
  it("hesap < $25k ve 3 gün-içi işlemde yeni emir gönderilmez", async () => {
    const { adapter, requests } = makeAdapter([
      { body: activeAccount },
      { body: openClock },
      { body: { ...activeAccount, equity: "20000", daytrade_count: 3 } },
    ]);
    await expect(adapter.submitOrder(baseOrder)).rejects.toThrow(/PDT/);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("trading_blocked hesapta emir doğrudan reddedilir", async () => {
    const { adapter, requests } = makeAdapter([{ body: { ...activeAccount, trading_blocked: true } }]);
    await expect(adapter.submitOrder(baseOrder)).rejects.toThrow(/bloke/);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("hesap >= $25k ise PDT engeli yok", async () => {
    const { adapter } = makeAdapter([
      { body: activeAccount },
      { body: openClock },
      { body: { ...activeAccount, equity: "26000", daytrade_count: 5 } },
      { body: { client_order_id: "bot-alp-1", symbol: "AAPL", side: "buy", qty: "10", filled_qty: "0", status: "accepted" } },
    ]);
    const result = await adapter.submitOrder(baseOrder);
    expect(result.state).toBe("NEW");
  });
});

describe("Faz 5 — emir sorgusu ve iptal", () => {
  it("queryOrder 404'te undefined döner (emir venue'ya hiç ulaşmamış)", async () => {
    const { adapter } = makeAdapter([{ status: 404, body: { message: "order not found" } }]);
    await expect(adapter.queryOrder("bot-yok")).resolves.toBeUndefined();
  });

  it("cancelOrder önce client_order_id ile bulur, sonra id ile siler", async () => {
    const { adapter, requests } = makeAdapter([
      { body: activeAccount },
      { body: { id: "srv-9", client_order_id: "bot-alp-1", status: "new" } },
      { status: 204 },
    ]);
    await adapter.cancelOrder("bot-alp-1");
    expect(requests[2]!.method).toBe("DELETE");
    expect(requests[2]!.url).toContain("/v2/orders/srv-9");
  });
});

describe("Faz 5 — 429 backoff", () => {
  it("rate limit'te bekler ve tekrarlar", async () => {
    const sleeps: number[] = [];
    const { adapter } = makeAdapter(
      [
        { status: 429, headers: { "Retry-After": "2" } },
        { body: openClock },
      ],
      { sleepFn: async (ms: number) => void sleeps.push(ms) },
    );
    await adapter.fetchServerTime();
    expect(sleeps).toEqual([2_000]);
  });

  it("deneme hakkı bitince hata fırlatır (sonsuz retry yok)", async () => {
    const { adapter } = makeAdapter(
      [{ status: 429 }, { status: 429 }],
      { maxAttempts: 2, sleepFn: async () => {} },
    );
    await expect(adapter.fetchServerTime()).rejects.toThrow(/429/);
  });
});

describe("Faz 5 — durum eşlemesi ve env fabrikası", () => {
  it("Alpaca durumları OMS durum makinesine eşlenir; bilinmeyen UNKNOWN", () => {
    expect(mapAlpacaStatus("new")).toBe("NEW");
    expect(mapAlpacaStatus("accepted")).toBe("NEW");
    expect(mapAlpacaStatus("partially_filled")).toBe("PARTIALLY_FILLED");
    expect(mapAlpacaStatus("filled")).toBe("FILLED");
    expect(mapAlpacaStatus("canceled")).toBe("CANCELED");
    expect(mapAlpacaStatus("rejected")).toBe("REJECTED");
    expect(mapAlpacaStatus("expired")).toBe("EXPIRED");
    expect(mapAlpacaStatus("garip_durum")).toBe("UNKNOWN");
  });

  it("anahtar yoksa undefined (iskelet modu); varsa adaptör döner", () => {
    expect(createAlpacaAdapterFromEnv("PAPER", silentLogger, {})).toBeUndefined();
    expect(
      createAlpacaAdapterFromEnv("PAPER", silentLogger, {
        ALPACA_API_KEY: "k",
        ALPACA_API_SECRET: "s",
      }),
    ).toBeDefined();
    expect(
      createAlpacaAdapterFromEnv("PAPER", silentLogger, {
        APCA_API_KEY_ID: "k",
        APCA_API_SECRET_KEY: "s",
      }),
    ).toBeDefined();
  });

  it("pozisyon ve bakiye eşlemesi", async () => {
    const { adapter } = makeAdapter([
      { body: [{ symbol: "AAPL", qty: "5" }, { symbol: "MSFT", qty: "0" }] },
      { body: activeAccount },
    ]);
    const positions = await adapter.fetchPositions();
    expect(positions).toEqual([{ symbol: "AAPL", quantity: 5 }]);
    const balances = await adapter.fetchBalances();
    expect(balances).toEqual([{ asset: "USD", free: 10_000, locked: 0 }]);
  });

  it("fraksiyonel adet ve fiyat tick size yuvarlaması korunur", async () => {
    const { adapter, requests } = makeAdapter([
      { body: activeAccount },
      { body: openClock },
      { body: { ...activeAccount, equity: "26000", daytrade_count: 0 } },
      {
        body: {
          client_order_id: "bot-alp-1",
          symbol: "AAPL",
          side: "buy",
          qty: "1.234568",
          filled_qty: "0",
          limit_price: "10.13",
          status: "accepted",
        },
      },
    ]);
    await adapter.submitOrder({ ...baseOrder, quantity: 1.23456789, price: 10.129 });
    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toContain('"qty":"1.234568"');
    expect(post?.body).toContain('"limit_price":"10.13"');
  });

  it("REST polling ile son işlemleri fiyat tick'ine çevirir", async () => {
    const { adapter, requests } = makeAdapter([
      {
        body: {
          trades: {
            AAPL: { p: 200.12, t: "2024-01-02T15:00:00Z" },
          },
        },
      },
    ]);
    const ticks = await adapter.fetchLatestPrices!(["AAPL"]);
    expect(ticks).toEqual([
      { symbol: "AAPL", price: 200.12, at: new Date("2024-01-02T15:00:00Z").getTime(), marketOpen: true },
    ]);
    expect(requests[0]?.url).toContain(alpacaDataBase());
  });

  it("venue status piyasa açıklığı ve PDT görünürlüğü döner", async () => {
    const { adapter } = makeAdapter([
      { body: { ...activeAccount, daytrade_count: 2, pattern_day_trader: true } },
      { body: openClock },
    ]);
    await expect(adapter.fetchVenueStatus?.()).resolves.toEqual({
      marketOpen: true,
      accountBlocked: false,
      tradingBlocked: false,
      dayTradeCount: 2,
      patternDayTrader: true,
    });
  });
});
