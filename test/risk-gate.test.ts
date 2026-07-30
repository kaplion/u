import { describe, expect, it } from "vitest";
import { checkOrder, HARD_LIMITS, type RiskContext } from "../src/risk/risk-gate.js";
import type { Order } from "../src/oms/order.js";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    clientOrderId: "test-1",
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 1,
    price: 100,
    reduceOnly: false,
    state: "PENDING_NEW",
    filledQuantity: 0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    mode: "DRY_RUN",
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

describe("risk kapısı", () => {
  it("normal emri geçirir", () => {
    expect(checkOrder(makeOrder(), makeCtx())).toEqual({ allowed: true });
  });

  it("kill switch: yeni risk durur, reduceOnly emir geçer", () => {
    const ctx = makeCtx({ killSwitchActive: true });
    const denied = checkOrder(makeOrder(), ctx);
    expect(denied.allowed).toBe(false);
    const allowed = checkOrder(makeOrder({ reduceOnly: true }), ctx);
    expect(allowed.allowed).toBe(true);
  });

  it("bayat veride yeni emir yok", () => {
    const decision = checkOrder(makeOrder(), makeCtx({ dataStale: true }));
    expect(decision.allowed).toBe(false);
  });

  it("fiyat sanity: son fiyattan %50 uzak emir reddedilir", () => {
    const decision = checkOrder(
      makeOrder({ price: 150 }),
      makeCtx({ lastPrice: 100 }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/fiyat sanity/);
  });

  it("günlük zarar limiti aşılınca emir durur", () => {
    const decision = checkOrder(
      makeOrder(),
      makeCtx({ dailyLoss: HARD_LIMITS.maxDailyLoss }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("dakika başına emir limiti (döngü koruması)", () => {
    const decision = checkOrder(
      makeOrder(),
      makeCtx({ ordersLastMinute: HARD_LIMITS.maxOrdersPerMinute }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("sembol başına max notional aşılırsa reddedilir", () => {
    const decision = checkOrder(
      makeOrder({ quantity: 20, price: 100 }), // 2000 > 1000
      makeCtx(),
    );
    expect(decision.allowed).toBe(false);
  });

  it("toplam brüt notional tavanı aşılırsa reddedilir", () => {
    const decision = checkOrder(
      makeOrder({ quantity: 5, price: 100 }),
      makeCtx({ currentGrossNotional: HARD_LIMITS.maxGrossNotional - 100 }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("geçersiz notional reddedilir", () => {
    const decision = checkOrder(makeOrder({ quantity: 0 }), makeCtx());
    expect(decision.allowed).toBe(false);
  });

  it("Faz 6 — LIVE kanarya tavanı: canlıda büyük emir reddedilir, PAPER'da geçer", () => {
    const order = makeOrder({ quantity: 1, price: 100 }); // 100 USD > 50 kanarya
    const live = checkOrder(order, makeCtx({ mode: "LIVE" }));
    expect(live.allowed).toBe(false);
    if (!live.allowed) expect(live.reason).toMatch(/kanarya/);

    const paper = checkOrder(order, makeCtx({ mode: "PAPER" }));
    expect(paper.allowed).toBe(true);

    const smallLive = checkOrder(
      makeOrder({ quantity: 0.4, price: 100 }), // 40 USD ≤ 50
      makeCtx({ mode: "LIVE" }),
    );
    expect(smallLive.allowed).toBe(true);
  });

  it("forex piyasası kapalıysa yeni emir reddedilir", () => {
    const decision = checkOrder(
      makeOrder({ symbol: "EURUSD", quantity: 0.1, price: 1.1 }),
      makeCtx({ assetClass: "forex", contractSize: 100_000, marketOpen: false, lastPrice: 1.1 }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("forex notional hesabı lot ve kontrat boyutunu kullanır", () => {
    const decision = checkOrder(
      makeOrder({ symbol: "EURUSD", quantity: 0.2, price: 1.1 }),
      makeCtx({
        assetClass: "forex",
        contractSize: 100_000,
        pipSize: 0.0001,
        lastPrice: 1.1,
        currentGrossNotional: HARD_LIMITS.maxGrossNotional - 1_000,
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("forex margin kullanım eşiği aşılınca yeni risk durur", () => {
    const decision = checkOrder(
      makeOrder({ symbol: "EURUSD", quantity: 0.01, price: 1.1 }),
      makeCtx({
        assetClass: "forex",
        contractSize: 100_000,
        marketOpen: true,
        lastPrice: 1.1,
        marginUsage: 0.8,
        marginUsageLimit: 0.7,
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/margin/);
  });
});
