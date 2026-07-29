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
});
