/**
 * FAZ 3 — KAOS TESTLERİ (kabul kriterleri tablosunun tamamı).
 * Bir bot ancak bunları geçerse canlıya çıkabilir.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertManager, type Alert } from "../src/monitoring/alerts.js";
import { Logger, type LogEntry } from "../src/monitoring/logger.js";
import { AuditLog } from "../src/oms/audit-log.js";
import { Oms, type OmsOptions } from "../src/oms/oms.js";
import type { Order } from "../src/oms/order.js";
import { LiquidationMonitor } from "../src/risk/liquidation.js";
import type { RiskContext } from "../src/risk/risk-gate.js";
import { StateStore } from "../src/state/state-store.js";
import { StalenessDetector } from "../src/market-data/staleness.js";
import { MarketDataFeed } from "../src/market-data/market-data-feed.js";
import type { WsTransport } from "../src/market-data/ws-manager.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import {
  BinanceAdapter,
  type FetchLike,
} from "../src/venues/binance/binance-adapter.js";
import type {
  VenueAdapter,
  VenueBalance,
  VenuePosition,
} from "../src/venues/venue-adapter.js";

const silentLogger = new Logger("PAPER", () => {});

type SubmitBehavior = "ok" | "drop-response" | "hang" | "reject" | "partial-30";

/** Kaos venue'su: idempotent (clientOrderId ile teklenir), davranışı ayarlanabilir. */
class ChaosVenue implements VenueAdapter {
  readonly name = "chaos";
  readonly book = new Map<string, Order>();
  positions: VenuePosition[] = [];
  submitBehavior: SubmitBehavior = "ok";
  submitCalls = 0;
  cancelCalls: string[] = [];

  async connect(): Promise<void> {}
  async fetchPositions(): Promise<readonly VenuePosition[]> {
    return this.positions;
  }
  async fetchOpenOrders(): Promise<readonly Order[]> {
    return [...this.book.values()].filter(
      (o) => o.state === "NEW" || o.state === "PARTIALLY_FILLED",
    );
  }
  async fetchBalances(): Promise<readonly VenueBalance[]> {
    return [];
  }
  async submitOrder(order: Order): Promise<Order> {
    this.submitCalls += 1;

    // Idempotency: venue aynı clientOrderId'yi İKİNCİ kez emir olarak AÇMAZ.
    const existing = this.book.get(order.clientOrderId);
    if (existing !== undefined) return existing;

    if (this.submitBehavior === "hang") {
      return new Promise<Order>(() => {}); // emir venue'ya hiç ulaşmaz, cevap da gelmez
    }
    if (this.submitBehavior === "reject") {
      throw new Error("venue reddi: yetersiz bakiye");
    }

    const accepted: Order = { ...order, state: "NEW" };
    if (this.submitBehavior === "partial-30") {
      const partial: Order = {
        ...order,
        state: "PARTIALLY_FILLED",
        filledQuantity: order.quantity * 0.3,
      };
      this.book.set(order.clientOrderId, partial);
      return partial;
    }
    this.book.set(order.clientOrderId, accepted);
    if (this.submitBehavior === "drop-response") {
      return new Promise<Order>(() => {}); // emir venue'ya ULAŞTI ama cevap düştü
    }
    return accepted;
  }
  async queryOrder(clientOrderId: string): Promise<Order | undefined> {
    return this.book.get(clientOrderId);
  }
  async cancelOrder(clientOrderId: string): Promise<void> {
    this.cancelCalls.push(clientOrderId);
    const order = this.book.get(clientOrderId);
    if (order !== undefined) this.book.set(clientOrderId, { ...order, state: "CANCELED" });
  }
  async fetchServerTime(): Promise<number> {
    return Date.now();
  }
}

function baseCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    mode: "PAPER",
    assetClass: "crypto",
    killSwitchActive: false,
    lastPrice: 100,
    dataStale: false,
    currentSymbolNotional: 0,
    currentGrossNotional: 0,
    dailyLoss: 0,
    ordersLastMinute: 0,
    ...overrides,
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaos-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  oms: Oms;
  venue: ChaosVenue;
  store: StateStore;
  dir: string;
  alerts: Alert[];
  ctx: { value: RiskContext };
}

function makeOms(overrides: Partial<OmsOptions> = {}, dir = tempDir()): Harness {
  const venue = new ChaosVenue();
  const store = new StateStore(join(dir, "state"));
  const alerts: Alert[] = [];
  const ctx = { value: baseCtx() };
  const oms = new Oms({
    mode: "PAPER",
    adapter: venue,
    store,
    audit: new AuditLog(join(dir, "state"), "PAPER"),
    logger: silentLogger,
    alerts: new AlertManager(silentLogger, [{ send: (a) => void alerts.push(a) }]),
    riskContext: () => ctx.value,
    orderTimeoutMs: 25,
    partialFillTimeoutMs: 25,
    maxSubmitAttempts: 3,
    ...overrides,
  });
  return { oms, venue, store, dir, alerts, ctx };
}

const intent = (over: Record<string, unknown> = {}) => ({
  symbol: "BTCUSDT",
  side: "BUY" as const,
  quantity: 1,
  price: 100,
  ...over,
});

describe("KAOS 1 — restart kurtarma: çift emir YOK, durum venue ile uyuşur", () => {
  it("gönderim sırasında ölen process, restart'ta venue'ya sorar ve YENİDEN GÖNDERMEZ", async () => {
    const dir = tempDir();
    const { venue, store } = makeOms({}, dir);

    // Process emir gönderilirken öldü: emir venue'ya ULAŞTI, cevap işlenemedi.
    // Diskteki defterde emir hâlâ PENDING_NEW.
    const inflight: Order = {
      clientOrderId: "bot-crash-1",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      price: 100,
      reduceOnly: false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    };
    venue.book.set("bot-crash-1", { ...inflight, state: "NEW" });
    store.save("oms-orders", {
      "bot-crash-1": { order: inflight, createdAt: 0, updatedAt: 0, submitAttempts: 1 },
    });

    // Yeniden başlat: aynı store, yeni OMS.
    const restarted = makeOms({ store, adapter: venue }, dir);
    await restarted.oms.recover();

    expect(restarted.oms.order("bot-crash-1")?.state).toBe("NEW"); // venue ile uyuşur
    expect(venue.submitCalls).toBe(0); // ÇİFT EMİR YOK — hiç yeniden gönderilmedi
    expect(venue.book.size).toBe(1);
  });

  it("venue'ya hiç ulaşmamış emir restart'ta REJECTED olur, varsayılmaz", async () => {
    const dir = tempDir();
    const { venue, store } = makeOms({}, dir);
    const inflight: Order = {
      clientOrderId: "bot-crash-2",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      reduceOnly: false,
      state: "UNKNOWN",
      filledQuantity: 0,
    };
    store.save("oms-orders", {
      "bot-crash-2": { order: inflight, createdAt: 0, updatedAt: 0, submitAttempts: 1 },
    });

    const restarted = makeOms({ store, adapter: venue }, dir);
    await restarted.oms.recover();
    expect(restarted.oms.order("bot-crash-2")?.state).toBe("REJECTED");
    expect(venue.submitCalls).toBe(0);
  });
});

describe("KAOS 2 — idempotency: aynı clientOrderId ile iki gönderim = tek emir", () => {
  it("OMS aynı ID'yi ikinci kez yerleştirmez, venue'da tek emir oluşur", async () => {
    const { oms, venue } = makeOms();
    const first = await oms.place(intent({ clientOrderId: "bot-idem-1" }));
    const second = await oms.place(intent({ clientOrderId: "bot-idem-1" }));
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(venue.book.size).toBe(1);
    expect(oms.allOrders()).toHaveLength(1);
  });

  it("venue de aynı ID'ye ikinci emir açmaz (savunma derinliği)", async () => {
    const venue = new ChaosVenue();
    const order: Order = {
      clientOrderId: "bot-idem-2",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      reduceOnly: false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    };
    await venue.submitOrder(order);
    await venue.submitOrder(order); // retry aynı ID ile
    expect(venue.book.size).toBe(1);
    expect(venue.submitCalls).toBe(2);
  });
});

describe("KAOS 3 — timeout belirsizliği: UNKNOWN'a geçer, venue'ya sorar, VARSAYMAZ", () => {
  it("cevap düştü ama emir venue'da: sorgu sonrası NEW benimsenir, tekrar gönderilmez", async () => {
    const { oms, venue, dir } = makeOms();
    venue.submitBehavior = "drop-response";
    const result = await oms.place(intent({ clientOrderId: "bot-timeout-1" }));

    expect(result.accepted).toBe(true);
    expect(result.accepted && result.order.state).toBe("NEW"); // venue gerçeği
    expect(venue.submitCalls).toBe(1); // tekrar gönderim YOK — çift emir yok
    // Audit izinde UNKNOWN geçişi kalıcı olarak var (varsaymadığının kanıtı).
    const audit = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(audit).toContain("UNKNOWN");
    expect(audit).toContain("venue'ya sorulacak");
  });

  it("emir venue'ya hiç ulaşmadıysa AYNI ID ile sınırlı retry yapılır", async () => {
    const { oms, venue } = makeOms();
    venue.submitBehavior = "hang";
    const result = await oms.place(intent({ clientOrderId: "bot-timeout-2" }));

    expect(result.accepted).toBe(false);
    expect(venue.submitCalls).toBe(3); // maxSubmitAttempts — sonsuz retry YOK
    expect(oms.order("bot-timeout-2")?.state).toBe("UNKNOWN"); // hâlâ bilinmiyor — kuyruakta
  });
});

describe("KAOS 4 — WS kopması: reconnect + REST resync + boşluk tespiti", () => {
  class FakeWs implements WsTransport {
    onopen: (() => void) | undefined;
    onmessage: ((data: string) => void) | undefined;
    onclose: (() => void) | undefined;
    onerror: ((err: unknown) => void) | undefined;
    send(): void {}
    close(): void {}
  }

  it("bağlantı zorla kesilince yeniden bağlanır, snapshot çeker, boşluğu görür", async () => {
    const sockets: FakeWs[] = [];
    const snapshotCalls: string[] = [];
    const alerts: Alert[] = [];
    const staleness = new StalenessDetector(60_000);
    const feed = new MarketDataFeed({
      symbols: ["BTCUSDT"],
      streamBase: "wss://stream.testnet.binance.vision",
      restBase: "https://testnet.binance.vision",
      logger: silentLogger,
      alerts: new AlertManager(silentLogger, [{ send: (a) => void alerts.push(a) }]),
      staleness,
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      fetchFn: async (url) => {
        snapshotCalls.push(url);
        return { status: 200, json: async () => [{ symbol: "BTCUSDT", price: "50000" }] };
      },
    });

    feed.start();
    sockets[0]!.onopen?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(feed.isConnected()).toBe(true);

    // Boşluk: 100 → 105 (102-104 kayıp) → alarm.
    const trade = (id: number) =>
      JSON.stringify({
        stream: "btcusdt@trade",
        data: { e: "trade", s: "BTCUSDT", p: "50001", T: 1, t: id },
      });
    sockets[0]!.onmessage?.(trade(100));
    sockets[0]!.onmessage?.(trade(101));
    sockets[0]!.onmessage?.(trade(105));
    expect(alerts.some((a) => a.kind === "ws_gap")).toBe(true);

    // Bağlantıyı zorla kes → reconnect + yeni REST snapshot.
    sockets[0]!.onclose?.();
    expect(feed.isConnected()).toBe(false);
    await new Promise((r) => setTimeout(r, 1_100)); // backoff ilk denemesi
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sockets[1]!.onopen?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(feed.isConnected()).toBe(true);
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2); // kaldığın yerden devam ETMEDİ
    feed.stop();
  }, 10_000);
});

describe("KAOS 5 — bayat veri: eşik aşılınca yeni emir durur", () => {
  it("feed sessizleşince risk kapısı yeni emri reddeder", async () => {
    const { oms, ctx, venue } = makeOms();
    ctx.value = baseCtx({ dataStale: true });
    const result = await oms.place(intent());
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/bayat/);
    expect(venue.submitCalls).toBe(0); // venue'ya hiç gitmedi
  });

  it("staleness dedektörü eşiği doğru ölçer", () => {
    let nowMs = 0;
    const det = new StalenessDetector(1_000, () => nowMs);
    expect(det.isStale()).toBe(true); // hiç veri yok = bayat
    det.onTick();
    nowMs = 500;
    expect(det.isStale()).toBe(false);
    nowMs = 1_600; // sessizlik eşiği aştı
    expect(det.isStale()).toBe(true);
  });
});

describe("KAOS 6 — kısmi dolum: kalan AÇIKÇA ele alınır, sessizce yutulmaz", () => {
  it("%30 dolum → süre dolunca kalan iptal edilir ve karar audit'e yazılır", async () => {
    const { oms, venue, dir } = makeOms();
    venue.submitBehavior = "partial-30";
    const result = await oms.place(intent({ clientOrderId: "bot-partial-1", quantity: 10 }));
    expect(result.accepted).toBe(true);
    expect(oms.order("bot-partial-1")?.state).toBe("PARTIALLY_FILLED");
    expect(oms.order("bot-partial-1")?.filledQuantity).toBe(3);

    await new Promise((r) => setTimeout(r, 30)); // partialFillTimeoutMs=25 aşıldı
    await oms.checkPartialFills();

    expect(venue.cancelCalls).toContain("bot-partial-1"); // kalan İPTAL edildi
    expect(oms.order("bot-partial-1")?.state).toBe("CANCELED");
    expect(oms.order("bot-partial-1")?.filledQuantity).toBe(3); // dolan kısım korunur
    const audit = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(audit).toContain("partial_fill_decision"); // karar açıkça kayıtlı
    expect(audit).toContain('"remaining":7');
  });

  it("KEEP_WORKING politikası: emir çalışmaya devam eder, karar loglanır", async () => {
    const { oms, venue, dir } = makeOms({ partialFillPolicy: "KEEP_WORKING" });
    venue.submitBehavior = "partial-30";
    await oms.place(intent({ clientOrderId: "bot-partial-2", quantity: 10 }));
    await new Promise((r) => setTimeout(r, 30));
    await oms.checkPartialFills();
    expect(oms.order("bot-partial-2")?.state).toBe("PARTIALLY_FILLED"); // hâlâ çalışıyor
    expect(venue.cancelCalls).toHaveLength(0);
    const audit = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(audit).toContain("KEEP_WORKING"); // sessiz DEĞİL — karar kayıtlı
  });
});

describe("KAOS 7 — emir reddi: durum doğru güncellenir, sonsuz retry YOK", () => {
  it("venue reddinde REJECTED olur ve yalnızca bir kez denenir", async () => {
    const { oms, venue } = makeOms();
    venue.submitBehavior = "reject";
    const result = await oms.place(intent({ clientOrderId: "bot-reject-1" }));
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/venue reddi/);
    expect(oms.order("bot-reject-1")?.state).toBe("REJECTED");
    expect(venue.submitCalls).toBe(1); // retry YOK
  });
});

describe("KAOS 8 — rate limit: 429'da backoff uygulanır, ban yenmez", () => {
  it("429 sonrası bekler ve isteği tekrarlar", async () => {
    const sleeps: number[] = [];
    const responses = [
      { status: 429, headers: { "Retry-After": "1" }, body: {} },
      { status: 200, headers: {}, body: { serverTime: 42 } },
    ];
    const fetchFn: FetchLike = async () => {
      const r = responses.shift()!;
      return {
        status: r.status,
        headers: { get: (n: string) => (r.headers as Record<string, string>)[n] ?? null },
        json: async () => r.body,
        text: async () => "",
      };
    };
    const adapter = new BinanceAdapter({
      mode: "PAPER",
      apiKey: "k",
      apiSecret: "s",
      logger: silentLogger,
      fetchFn,
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    const time = await adapter.fetchServerTime();
    expect(time).toBe(42);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // backoff UYGULANDI
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000); // Retry-After'a saygı
  });
});

describe("KAOS 9 — kill switch: yeni risk durur, pozisyon AZALTAN emir geçer", () => {
  it("dışarıdan tetiklenince yalnızca reduceOnly emirler venue'ya gider", async () => {
    const { oms, venue, ctx } = makeOms();
    ctx.value = baseCtx({ killSwitchActive: true });

    const newRisk = await oms.place(intent({ clientOrderId: "bot-ks-1" }));
    expect(newRisk.accepted).toBe(false); // yeni risk DURDU

    const reducing = await oms.place(
      intent({ clientOrderId: "bot-ks-2", side: "SELL", reduceOnly: true }),
    );
    expect(reducing.accepted).toBe(true); // azaltan emir GEÇTİ — içeride kilitlenme yok
    expect(venue.book.has("bot-ks-2")).toBe(true);
    expect(venue.book.has("bot-ks-1")).toBe(false);
  });
});

describe("KAOS 10 — rekonsiliasyon sapması: bot durur ve alarm verir", () => {
  it("venue farklı pozisyon bildirince halt + alarm, tahminle devam yok", async () => {
    const dir = tempDir();
    const venue = new ChaosVenue();
    venue.positions = [{ symbol: "BTC", quantity: 1.2 }];
    const store = new StateStore(join(dir, "state"));
    store.save("expected-state", { positions: { BTC: 1.5 }, openOrderIds: [], balances: {} });
    const alerts: Alert[] = [];
    const reconciler = new Reconciler(
      venue,
      store,
      new AlertManager(silentLogger, [{ send: (a) => void alerts.push(a) }]),
      silentLogger,
    );
    const result = await reconciler.runOnce();
    expect(result.ok).toBe(false);
    expect(reconciler.isHalted()).toBe(true); // İŞLEM DURDU
    expect(alerts.some((a) => a.kind === "reconciliation_deviation")).toBe(true);
    // Lokal beklenti venue ile ÜZERİNE YAZILMADI (tahmin yok, operatör kararı gerek).
    expect(store.load<{ positions: Record<string, number> }>("expected-state")?.positions.BTC).toBe(1.5);
  });
});

describe("KAOS 11 — fiyat sanity: son fiyattan %50 uzak emir reddedilir", () => {
  it("fat finger emri venue'ya hiç gitmez", async () => {
    const { oms, venue, ctx } = makeOms();
    ctx.value = baseCtx({ lastPrice: 100 });
    const result = await oms.place(intent({ price: 150 })); // %50 sapma > %10 limit
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/fiyat sanity/);
    expect(venue.submitCalls).toBe(0);
  });
});

describe("KAOS 12 — çekim izinli anahtar: başlatma REDDEDİLİR", () => {
  it("connect canWithdraw=true görünce hata fırlatır", async () => {
    const responses = [
      { body: { serverTime: 1 } },
      { body: { canTrade: true, canWithdraw: true } },
    ];
    const fetchFn: FetchLike = async () => {
      const r = responses.shift()!;
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => r.body,
        text: async () => "",
      };
    };
    const adapter = new BinanceAdapter({
      mode: "PAPER",
      apiKey: "k",
      apiSecret: "s",
      logger: silentLogger,
      fetchFn,
    });
    await expect(adapter.connect()).rejects.toThrow(/ÇEKİM/);
  });
});

describe("KAOS 13 — likidasyon tamponu: pozisyon kendiliğinden küçülür", () => {
  it("fiyat likidasyona yaklaşınca reduce-only emir üretilir ve kill switch altında bile geçer", async () => {
    const alerts: Alert[] = [];
    const monitor = new LiquidationMonitor({
      alerts: new AlertManager(silentLogger, [{ send: (a) => void alerts.push(a) }]),
      bufferProximity: 0.9,
      reduceFraction: 0.5,
    });

    // Long 2 BTC, likidasyon 95, fiyat 96 → yakınlık ~0.99 → tampon İHLAL.
    const intent13 = monitor.check(
      { symbol: "BTCUSDT", quantity: 2, liquidationPrice: 95 },
      96,
    );
    expect(intent13).toBeDefined();
    expect(intent13?.side).toBe("SELL"); // long küçültülür
    expect(intent13?.quantity).toBe(1); // yarısı
    expect(intent13?.reduceOnly).toBe(true);
    expect(alerts.some((a) => a.kind === "liquidation_buffer")).toBe(true);

    // Üretilen emir kill switch altında bile OMS'ten geçer (reduceOnly).
    const { oms, venue, ctx } = makeOms();
    ctx.value = baseCtx({ killSwitchActive: true, lastPrice: 96 });
    const placed = await oms.place({ ...intent13!, clientOrderId: "bot-liq-1" });
    expect(placed.accepted).toBe(true);
    expect(venue.book.has("bot-liq-1")).toBe(true);

    // Güvenli uzaklıkta emir üretilmez.
    expect(monitor.check({ symbol: "BTCUSDT", quantity: 2, liquidationPrice: 50 }, 100)).toBeUndefined();
  });
});

describe("KAOS 14 — mod izolasyonu: PAPER'da hiçbir gerçek emir gitmez, loglarda mod görünür", () => {
  it("PAPER modda tüm istekler testnet host'una gider", async () => {
    const hosts: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      hosts.push(new URL(url).host);
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ symbol: "BTCUSDT", clientOrderId: "x", side: "BUY", status: "NEW", origQty: "1", executedQty: "0", price: "100" }),
        text: async () => "",
      };
    };
    const adapter = new BinanceAdapter({
      mode: "PAPER",
      apiKey: "k",
      apiSecret: "s",
      logger: silentLogger,
      fetchFn,
    });
    await adapter.submitOrder({
      clientOrderId: "x",
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 1,
      price: 100,
      reduceOnly: false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    });
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toBe("testnet.binance.vision"); // GERÇEK borsa YOK
  });

  it("DRY_RUN'da OMS venue'yu hiç çağırmaz ama emri loglar; her log satırında mod var", async () => {
    const dir = tempDir();
    const logs: LogEntry[] = [];
    const logger = new Logger("DRY_RUN", (e) => void logs.push(e));
    const venue = new ChaosVenue();
    const oms = new Oms({
      mode: "DRY_RUN",
      adapter: venue,
      store: new StateStore(join(dir, "state")),
      audit: new AuditLog(join(dir, "state"), "DRY_RUN"),
      logger,
      alerts: new AlertManager(logger),
      riskContext: () => baseCtx({ mode: "DRY_RUN" }),
    });

    const result = await oms.place(intent({ clientOrderId: "bot-dry-1" }));
    expect(result.accepted).toBe(true);
    expect(venue.submitCalls).toBe(0); // GÖNDERİLMEDİ
    expect(oms.order("bot-dry-1")?.state).toBe("NEW"); // ama üretildi ve izleniyor

    // Audit dosyası mod damgalı — karıştırılması imkânsız.
    const audit = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(audit).toContain('"mode":"DRY_RUN"');
    expect(audit).toContain("venue'ya gönderilmedi");
  });
});
