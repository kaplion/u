import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Reconciler, type ExpectedState } from "../src/reconciliation/reconciler.js";
import { StateStore } from "../src/state/state-store.js";
import { AlertManager, type Alert } from "../src/monitoring/alerts.js";
import { Logger } from "../src/monitoring/logger.js";
import type { Order } from "../src/oms/order.js";
import type { VenueAdapter, VenueBalance, VenuePosition } from "../src/venues/venue-adapter.js";

const silentLogger = new Logger("PAPER", () => {});

class FakeVenue implements VenueAdapter {
  readonly name = "fake";
  positions: VenuePosition[] = [];
  openOrders: Order[] = [];
  balances: VenueBalance[] = [];

  async connect(): Promise<void> {}
  async fetchPositions(): Promise<readonly VenuePosition[]> {
    return this.positions;
  }
  async fetchOpenOrders(): Promise<readonly Order[]> {
    return this.openOrders;
  }
  async fetchBalances(): Promise<readonly VenueBalance[]> {
    return this.balances;
  }
  async submitOrder(order: Order): Promise<Order> {
    return order;
  }
  async queryOrder(): Promise<Order | undefined> {
    return undefined;
  }
  async cancelOrder(): Promise<void> {}
  async fetchServerTime(): Promise<number> {
    return Date.now();
  }
}

function makeOrder(clientOrderId: string): Order {
  return {
    clientOrderId,
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 1,
    reduceOnly: false,
    state: "NEW",
    filledQuantity: 0,
  };
}

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "recon-test-"));
  dirs.push(dir);
  const store = new StateStore(dir);
  const alertsReceived: Alert[] = [];
  const alerts = new AlertManager(silentLogger, [{ send: (a) => void alertsReceived.push(a) }]);
  const venue = new FakeVenue();
  const reconciler = new Reconciler(venue, store, alerts, silentLogger);
  return { store, venue, reconciler, alertsReceived };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Reconciler", () => {
  it("ilk açılışta venue gerçeğini benimser — asla düz pozisyon varsaymaz", async () => {
    const { venue, reconciler, store } = setup();
    venue.positions = [{ symbol: "BTC", quantity: 1.5 }];
    venue.balances = [{ asset: "BTC", free: 1.5, locked: 0 }];
    venue.openOrders = [makeOrder("bot-1")];

    const result = await reconciler.runOnce();
    expect(result.ok).toBe(true);
    expect(result.adoptedTruth).toBe(true);
    const saved = store.load<ExpectedState>("expected-state");
    expect(saved?.positions).toEqual({ BTC: 1.5 });
    expect(saved?.openOrderIds).toEqual(["bot-1"]);
  });

  it("uyum tamsa ok döner ve halted olmaz", async () => {
    const { venue, reconciler } = setup();
    venue.positions = [{ symbol: "BTC", quantity: 1.5 }];
    await reconciler.runOnce(); // benimse
    const result = await reconciler.runOnce(); // karşılaştır
    expect(result.ok).toBe(true);
    expect(reconciler.isHalted()).toBe(false);
  });

  it("pozisyon sapmasında durur ve alarm verir — tahminle devam etmez", async () => {
    const { venue, reconciler, alertsReceived } = setup();
    venue.positions = [{ symbol: "BTC", quantity: 1.5 }];
    await reconciler.runOnce();

    venue.positions = [{ symbol: "BTC", quantity: 1.2 }]; // bot 1.5 sanıyor, borsa 1.2 diyor
    const result = await reconciler.runOnce();
    expect(result.ok).toBe(false);
    expect(result.deviations).toContainEqual({
      kind: "position",
      key: "BTC",
      expected: 1.5,
      actual: 1.2,
    });
    expect(reconciler.isHalted()).toBe(true);
    expect(alertsReceived.some((a) => a.kind === "reconciliation_deviation")).toBe(true);
  });

  it("kaybolan ve beklenmeyen açık emirleri yakalar", async () => {
    const { venue, reconciler } = setup();
    venue.openOrders = [makeOrder("bot-1")];
    await reconciler.runOnce();

    venue.openOrders = [makeOrder("bot-2")];
    const result = await reconciler.runOnce();
    expect(result.ok).toBe(false);
    const kinds = result.deviations.map((d) => `${d.kind}:${d.key}`).sort();
    expect(kinds).toEqual(["open_order:bot-1", "open_order:bot-2"]);
  });

  it("bakiye sapmasını yakalar, epsilon içi farkı yok sayar", async () => {
    const { venue, reconciler } = setup();
    venue.balances = [{ asset: "USDT", free: 1000, locked: 0 }];
    await reconciler.runOnce();

    venue.balances = [{ asset: "USDT", free: 1000 + 1e-12, locked: 0 }];
    expect((await reconciler.runOnce()).ok).toBe(true);

    venue.balances = [{ asset: "USDT", free: 900, locked: 0 }];
    const result = await reconciler.runOnce();
    expect(result.ok).toBe(false);
    expect(result.deviations[0]?.kind).toBe("balance");
  });

  it("operatör onayıyla venue gerçeği benimsenir ve halt kalkar", async () => {
    const { venue, reconciler } = setup();
    venue.positions = [{ symbol: "BTC", quantity: 1.5 }];
    await reconciler.runOnce();
    venue.positions = [{ symbol: "BTC", quantity: 1.2 }];
    await reconciler.runOnce();
    expect(reconciler.isHalted()).toBe(true);

    await reconciler.adoptVenueTruth();
    expect(reconciler.isHalted()).toBe(false);
    const result = await reconciler.runOnce();
    expect(result.ok).toBe(true);
  });

  it("uyumlu turda yeni venue anlık görüntüsü kaydedilir (fill yansır)", async () => {
    const { venue, reconciler, store } = setup();
    venue.positions = [];
    await reconciler.runOnce();
    // Uyumlu tur: pozisyon yok → yok. Store tazelenir.
    await reconciler.runOnce();
    expect(store.load<ExpectedState>("expected-state")?.positions).toEqual({});
  });
});
