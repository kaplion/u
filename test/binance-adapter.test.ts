import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BinanceAdapter,
  binanceRestBase,
  binanceStreamBase,
  createBinanceAdapterFromEnv,
  mapBinanceStatus,
  type FetchLike,
} from "../src/venues/binance/binance-adapter.js";
import { Logger } from "../src/monitoring/logger.js";
import { RateLimiter } from "../src/venues/binance/rate-limiter.js";
import type { Order } from "../src/oms/order.js";

const silentLogger = new Logger("PAPER", () => {});

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fakeFetch(responses: StubResponse[]): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    const stub = responses.shift() ?? {};
    const headerMap = stub.headers ?? {};
    return {
      status: stub.status ?? 200,
      headers: { get: (name: string) => headerMap[name] ?? null },
      json: async () => stub.body ?? {},
      text: async () => JSON.stringify(stub.body ?? {}),
    };
  };
  return { fetchFn, requests };
}

function makeAdapter(responses: StubResponse[], overrides: Record<string, unknown> = {}) {
  const { fetchFn, requests } = fakeFetch(responses);
  const adapter = new BinanceAdapter({
    mode: "PAPER",
    apiKey: "test-key",
    apiSecret: "test-secret",
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { adapter, requests };
}

describe("mod izolasyonu", () => {
  it("yalnızca LIVE gerçek borsaya gider; PAPER ve DRY_RUN testnet'e", () => {
    expect(binanceRestBase("LIVE")).toBe("https://api.binance.com");
    expect(binanceRestBase("PAPER")).toBe("https://testnet.binance.vision");
    expect(binanceRestBase("DRY_RUN")).toBe("https://testnet.binance.vision");
    expect(binanceStreamBase("PAPER")).toContain("testnet");
    expect(binanceStreamBase("LIVE")).toContain("stream.binance.com");
  });

  it("PAPER modda hiçbir istek gerçek borsa host'una gitmez", async () => {
    const { adapter, requests } = makeAdapter([{ body: { serverTime: 1 } }]);
    await adapter.fetchServerTime();
    for (const req of requests) {
      expect(new URL(req.url).host).toBe("testnet.binance.vision");
    }
  });

  it("DRY_RUN modda emir gönderimi adaptör seviyesinde reddedilir", async () => {
    const { adapter } = makeAdapter([], { mode: "DRY_RUN" });
    const order: Order = {
      clientOrderId: "x",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      reduceOnly: false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    };
    await expect(adapter.submitOrder(order)).rejects.toThrow(/DRY_RUN/);
    await expect(adapter.cancelOrder("x", "BTCUSDT")).rejects.toThrow(/DRY_RUN/);
  });
});

describe("connect — anahtar izin kontrolü", () => {
  it("çekim izinli anahtarla başlatmayı reddeder", async () => {
    const { adapter } = makeAdapter([
      { body: { serverTime: 1 } },
      { body: { canTrade: true, canWithdraw: true, balances: [] } },
    ]);
    await expect(adapter.connect()).rejects.toThrow(/ÇEKİM/);
  });

  it("işlem izinli, çekimsiz anahtarı kabul eder", async () => {
    const { adapter } = makeAdapter([
      { body: { serverTime: 1 } },
      { body: { canTrade: true, canWithdraw: false, balances: [] } },
    ]);
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("boş anahtar constructor'da reddedilir", () => {
    expect(
      () =>
        new BinanceAdapter({
          mode: "PAPER",
          apiKey: "",
          apiSecret: "",
          logger: silentLogger,
        }),
    ).toThrow();
  });
});

describe("imzalama", () => {
  it("signed istekte doğru HMAC-SHA256 imzası ve API key başlığı bulunur", async () => {
    const { adapter, requests } = makeAdapter([{ body: { balances: [] } }]);
    await adapter.fetchBalances();
    const req = requests[0]!;
    expect(req.headers["X-MBX-APIKEY"]).toBe("test-key");
    const url = new URL(req.url);
    const signature = url.searchParams.get("signature")!;
    url.searchParams.delete("signature");
    const query = url.search.slice(1);
    const expected = createHmac("sha256", "test-secret").update(query).digest("hex");
    expect(signature).toBe(expected);
    expect(query).toContain("timestamp=1700000000000");
    expect(query).toContain("recvWindow=5000");
  });
});

describe("emir işlemleri", () => {
  it("submitOrder clientOrderId'yi newClientOrderId olarak gönderir (idempotency)", async () => {
    const { adapter, requests } = makeAdapter([
      {
        body: {
          symbol: "BTCUSDT",
          clientOrderId: "bot-abc",
          side: "BUY",
          status: "NEW",
          origQty: "1",
          executedQty: "0",
          price: "100",
        },
      },
    ]);
    const order: Order = {
      clientOrderId: "bot-abc",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      price: 100,
      reduceOnly: false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    };
    const result = await adapter.submitOrder(order);
    expect(requests[0]!.url).toContain("newClientOrderId=bot-abc");
    expect(requests[0]!.method).toBe("POST");
    expect(result.state).toBe("NEW");
    expect(result.clientOrderId).toBe("bot-abc");
  });

  it("queryOrder: venue emri tanımıyorsa (-2013) undefined döner — emir hiç gitmemiş", async () => {
    const { adapter } = makeAdapter([
      { status: 400, body: { code: -2013, msg: "Order does not exist." } },
    ]);
    const result = await adapter.queryOrder("bot-yok", "BTCUSDT");
    expect(result).toBeUndefined();
  });

  it("queryOrder durumu doğru eşler", async () => {
    const { adapter } = makeAdapter([
      {
        body: {
          symbol: "BTCUSDT",
          clientOrderId: "bot-abc",
          side: "SELL",
          status: "PARTIALLY_FILLED",
          origQty: "10",
          executedQty: "3",
          price: "100",
        },
      },
    ]);
    const result = await adapter.queryOrder("bot-abc", "BTCUSDT");
    expect(result?.state).toBe("PARTIALLY_FILLED");
    expect(result?.filledQuantity).toBe(3);
  });

  it("bilinmeyen venue durumu UNKNOWN'a eşlenir — asla varsayılmaz", () => {
    expect(mapBinanceStatus("YEPYENI_DURUM")).toBe("UNKNOWN");
    expect(mapBinanceStatus("EXPIRED_IN_MATCH")).toBe("EXPIRED");
    expect(mapBinanceStatus("PENDING_CANCEL")).toBe("NEW");
  });
});

describe("rate limit davranışı", () => {
  function clockedLimiter() {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(6_000, () => clock);
    const sleepFn = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    };
    return { limiter, sleepFn, sleeps };
  }

  it("429'da backoff uygulayıp yeniden dener, Retry-After'a uyar", async () => {
    const { limiter, sleepFn, sleeps } = clockedLimiter();
    const { adapter } = makeAdapter(
      [
        { status: 429, headers: { "Retry-After": "2" } },
        { body: { serverTime: 42 } },
      ],
      { sleepFn, limiter },
    );
    const time = await adapter.fetchServerTime();
    expect(time).toBe(42);
    expect(sleeps).toEqual([2_000]);
  });

  it("deneme hakkı bitince hata fırlatır, sonsuz retry yok", async () => {
    const { limiter, sleepFn } = clockedLimiter();
    const stubs = Array.from({ length: 10 }, () => ({ status: 429 as const }));
    const { adapter } = makeAdapter(stubs, { maxAttempts: 3, sleepFn, limiter });
    await expect(adapter.fetchServerTime()).rejects.toThrow(/deneme hakkı bitti/);
  });
});

describe("bakiye ve pozisyon", () => {
  it("sıfır olmayan bakiyeleri pozisyon olarak döner", async () => {
    const account = {
      balances: [
        { asset: "BTC", free: "1.5", locked: "0.5" },
        { asset: "USDT", free: "0", locked: "0" },
        { asset: "ETH", free: "0.000", locked: "0" },
      ],
    };
    const { adapter } = makeAdapter([{ body: account }, { body: account }]);
    const balances = await adapter.fetchBalances();
    expect(balances).toEqual([{ asset: "BTC", free: 1.5, locked: 0.5 }]);
    const positions = await adapter.fetchPositions();
    expect(positions).toEqual([{ symbol: "BTC", quantity: 2 }]);
  });
});

describe("hata gövdesi", () => {
  it("hata mesajında anahtar veya imza yer almaz", async () => {
    const { adapter } = makeAdapter([
      { status: 400, body: { code: -1013, msg: "Filter failure" } },
    ]);
    try {
      await adapter.fetchBalances();
      expect.unreachable();
    } catch (err) {
      const msg = String(err);
      expect(msg).not.toContain("test-key");
      expect(msg).not.toContain("test-secret");
      expect(msg).not.toContain("signature");
      expect(msg).toContain("-1013");
    }
  });
});

describe("createBinanceAdapterFromEnv", () => {
  it("anahtar yoksa undefined döner (çevrimdışı iskelet modu)", () => {
    expect(createBinanceAdapterFromEnv("PAPER", silentLogger, {})).toBeUndefined();
    expect(
      createBinanceAdapterFromEnv("PAPER", silentLogger, { BINANCE_API_KEY: "k" }),
    ).toBeUndefined();
  });

  it("anahtar varsa adaptör üretir", () => {
    const adapter = createBinanceAdapterFromEnv("PAPER", silentLogger, {
      BINANCE_API_KEY: "k",
      BINANCE_API_SECRET: "s",
    });
    expect(adapter).toBeInstanceOf(BinanceAdapter);
  });
});
