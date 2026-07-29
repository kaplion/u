import { describe, expect, it } from "vitest";
import {
  canTransition,
  isTerminal,
  transition,
  type Order,
} from "../src/oms/order.js";
import { newClientOrderId } from "../src/oms/client-order-id.js";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    clientOrderId: newClientOrderId(),
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

describe("emir durum makinesi", () => {
  it("normal yaşam döngüsünü izler", () => {
    let order = makeOrder();
    order = transition(order, "NEW");
    order = transition(order, "PARTIALLY_FILLED");
    order = transition(order, "FILLED");
    expect(order.state).toBe("FILLED");
    expect(isTerminal(order.state)).toBe(true);
  });

  it("timeout'ta UNKNOWN'a geçer ve venue cevabıyla her duruma dönebilir", () => {
    let order = makeOrder();
    order = transition(order, "UNKNOWN");
    expect(canTransition("UNKNOWN", "FILLED")).toBe(true);
    expect(canTransition("UNKNOWN", "REJECTED")).toBe(true);
    order = transition(order, "NEW");
    expect(order.state).toBe("NEW");
  });

  it("geçersiz geçişleri reddeder", () => {
    const filled = makeOrder({ state: "FILLED" });
    expect(() => transition(filled, "NEW")).toThrow(/Geçersiz emir durum geçişi/);
    expect(canTransition("PENDING_NEW", "FILLED")).toBe(false);
  });

  it("terminal durumlardan çıkış yoktur", () => {
    for (const s of ["FILLED", "REJECTED", "CANCELED", "EXPIRED"] as const) {
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal("UNKNOWN")).toBe(false);
  });
});

describe("clientOrderId", () => {
  it("benzersiz ID üretir", () => {
    const a = newClientOrderId();
    const b = newClientOrderId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^bot-/);
  });
});
