import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../src/monitoring/logger.js";
import type { Order } from "../src/oms/order.js";
import { StateStore } from "../src/state/state-store.js";
import {
  createIgAdapterFromEnv,
  IgAdapter,
  igRestBase,
  mapIgStatus,
  type IgFetchLike,
} from "../src/venues/ig/ig-adapter.js";

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

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(responses: StubResponse[]) {
  const requests: Recorded[] = [];
  const fetchFn: IgFetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
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
  const dir = mkdtempSync(join(tmpdir(), "ig-test-"));
  dirs.push(dir);
  const { fetchFn, requests } = fakeFetch(responses);
  const adapter = new IgAdapter({
    mode: "PAPER",
    apiKey: "ig-key",
    username: "ig-user",
    password: "ig-pass",
    accountId: "ACC-1",
    logger: silentLogger,
    fetchFn,
    sleepFn: async () => {},
    stateStore: new StateStore(join(dir, "state")),
    ...overrides,
  });
  return { adapter, requests, dir };
}

const baseOrder: Order = {
  clientOrderId: "bot-ig-1",
  symbol: "EURUSD",
  side: "BUY",
  quantity: 0.1,
  price: 1.1,
  reduceOnly: false,
  state: "PENDING_NEW",
  filledQuantity: 0,
};

describe("IG mod izolasyonu", () => {
  it("yalnızca LIVE gerçek host'a gider; PAPER ve DRY_RUN demo'ya gider", () => {
    expect(igRestBase("LIVE")).toBe("https://api.ig.com/gateway/deal");
    expect(igRestBase("PAPER")).toBe("https://demo-api.ig.com/gateway/deal");
    expect(igRestBase("DRY_RUN")).toBe("https://demo-api.ig.com/gateway/deal");
  });
});

describe("IG kimlik doğrulama ve sorgular", () => {
  it("oturum açar ve token süresi dolunca bir kez yeniden oturum açar", async () => {
    const { adapter, requests } = makeAdapter([
      { headers: { CST: "cst-1", "X-SECURITY-TOKEN": "xst-1" } },
      { status: 401, body: { errorCode: "error.security.client-token-invalid" } },
      { headers: { CST: "cst-2", "X-SECURITY-TOKEN": "xst-2" } },
      {
        body: {
          accounts: [{ accountId: "ACC-1", currency: "USD", balance: { balance: 1000, available: 900, deposit: 100 } }],
        },
      },
    ]);
    const status = await adapter.fetchVenueStatus!([]);
    expect(status.marginUsage).toBeCloseTo(0.1);
    expect(requests.filter((request) => request.url.endsWith("/session"))).toHaveLength(2);
  });

  it("pozisyon, bakiye ve polling fiyatını eşler", async () => {
    const { adapter } = makeAdapter([
      { headers: { CST: "cst-1", "X-SECURITY-TOKEN": "xst-1" } },
      {
        body: {
          positions: [
            { position: { direction: "BUY", size: 0.2, level: 1.1 }, market: { epic: "CS.D.EURUSD.CFD.IP" } },
          ],
        },
      },
      {
        body: {
          accounts: [{ accountId: "ACC-1", currency: "USD", balance: { balance: 1000, available: 800, deposit: 200 } }],
        },
      },
      { body: { snapshot: { bid: 1.1, offer: 1.1002, marketStatus: "TRADEABLE" } } },
    ]);
    await expect(adapter.fetchPositions()).resolves.toEqual([
      { symbol: "EURUSD", quantity: 0.2, avgPrice: 1.1, assetClass: "forex" },
    ]);
    await expect(adapter.fetchBalances()).resolves.toEqual([{ asset: "USD", free: 800, locked: 200 }]);
    await expect(adapter.fetchLatestPrices!(["EUR/USD"])).resolves.toEqual([
      { symbol: "EURUSD", price: 1.1001, at: expect.any(Number), marketOpen: true },
    ]);
  });
});

describe("IG emir yaşam döngüsü", () => {
  it("dealReference eşlemesini kalıcı yazar ve restart sonrası queryOrder bunu kullanır", async () => {
    const { adapter, dir, requests } = makeAdapter([
      { headers: { CST: "cst-1", "X-SECURITY-TOKEN": "xst-1" } },
      { body: { snapshot: { bid: 1.1, offer: 1.1002, marketStatus: "TRADEABLE" } } },
      { body: { dealReference: "REF-1" } },
      { body: { dealReference: "REF-1", dealStatus: "ACCEPTED", direction: "BUY", epic: "CS.D.EURUSD.CFD.IP", size: 0.1, level: 1.1 } },
    ]);
    const created = await adapter.submitOrder(baseOrder);
    expect(created.state).toBe("FILLED");
    expect(requests.some((request) => request.url.endsWith("/confirms/REF-1"))).toBe(true);

    const { fetchFn, requests: restartRequests } = fakeFetch([
      { headers: { CST: "cst-2", "X-SECURITY-TOKEN": "xst-2" } },
      { body: { dealReference: "REF-1", dealStatus: "ACCEPTED", direction: "BUY", epic: "CS.D.EURUSD.CFD.IP", size: 0.1, level: 1.1 } },
    ]);
    const restarted = new IgAdapter({
      mode: "PAPER",
      apiKey: "ig-key",
      username: "ig-user",
      password: "ig-pass",
      accountId: "ACC-1",
      logger: silentLogger,
      fetchFn,
      sleepFn: async () => {},
      stateStore: new StateStore(join(dir, "state")),
    });
    const queried = await restarted.queryOrder("bot-ig-1", "EURUSD");
    expect(queried?.state).toBe("FILLED");
    expect(restartRequests.some((request) => request.url.endsWith("/confirms/REF-1"))).toBe(true);
  });

  it("429 yanıtında bekler ve yeniden dener", async () => {
    const sleeps: number[] = [];
    const { adapter } = makeAdapter(
      [
        { headers: { CST: "cst-1", "X-SECURITY-TOKEN": "xst-1" } },
        { status: 429, headers: { "Retry-After": "2" } },
        {
          body: {
            accounts: [{ accountId: "ACC-1", currency: "USD", balance: { balance: 1000, available: 900, deposit: 100 } }],
          },
        },
      ],
      { sleepFn: async (ms: number) => void sleeps.push(ms) },
    );
    await adapter.fetchVenueStatus!([]);
    expect(sleeps).toEqual([2_000]);
  });
});

describe("IG hata güvenliği ve env fabrikası", () => {
  it("hata mesajında sır sızdırmaz", async () => {
    const { adapter } = makeAdapter([
      { headers: { CST: "cst-1", "X-SECURITY-TOKEN": "xst-1" } },
      { status: 400, body: { errorCode: "bad.request" } },
    ]);
    try {
      await adapter.fetchVenueStatus!([]);
      expect.unreachable();
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("bad.request");
      expect(msg).not.toContain("ig-key");
      expect(msg).not.toContain("ig-pass");
      expect(msg).not.toContain("cst-1");
      expect(msg).not.toContain("xst-1");
    }
  });

  it("durum eşlemesi bilinmeyeni UNKNOWN yapar", () => {
    expect(mapIgStatus("ACCEPTED")).toBe("FILLED");
    expect(mapIgStatus("REJECTED")).toBe("REJECTED");
    expect(mapIgStatus("OPEN")).toBe("FILLED");
    expect(mapIgStatus("CLOSED")).toBe("FILLED");
    expect(mapIgStatus("DELETED")).toBe("CANCELED");
    expect(mapIgStatus("AMENDED")).toBe("FILLED");
    expect(mapIgStatus("garip")).toBe("UNKNOWN");
  });

  it("anahtarlar eksikse undefined döner", () => {
    expect(createIgAdapterFromEnv("PAPER", silentLogger, {})).toBeUndefined();
    expect(
      createIgAdapterFromEnv("PAPER", silentLogger, {
        IG_API_KEY: "k",
        IG_USERNAME: "u",
        IG_PASSWORD: "p",
        IG_ACCOUNT_ID: "a",
      }),
    ).toBeDefined();
  });
});
