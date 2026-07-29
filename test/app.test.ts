import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App, type FeedLike } from "../src/app.js";
import type { Config } from "../src/config/config.js";
import { AlertManager, type Alert } from "../src/monitoring/alerts.js";
import { Logger } from "../src/monitoring/logger.js";
import { KillSwitch } from "../src/risk/kill-switch.js";
import { StateStore } from "../src/state/state-store.js";
import { StalenessDetector } from "../src/market-data/staleness.js";
import type { Order } from "../src/oms/order.js";
import type { VenueAdapter, VenueBalance, VenuePosition } from "../src/venues/venue-adapter.js";

const silentLogger = new Logger("PAPER", () => {});

class FakeVenue implements VenueAdapter {
  readonly name = "fake";
  positions: VenuePosition[] = [];
  connectRejects = false;

  async connect(): Promise<void> {
    if (this.connectRejects) throw new Error("çekim izni var");
  }
  async fetchPositions(): Promise<readonly VenuePosition[]> {
    return this.positions;
  }
  async fetchOpenOrders(): Promise<readonly Order[]> {
    return [];
  }
  async fetchBalances(): Promise<readonly VenueBalance[]> {
    return [];
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

class FakeFeed implements FeedLike {
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  isConnected(): boolean {
    return this.started && !this.stopped;
  }
}

const dirs: string[] = [];
function setup(opts: { adapter?: VenueAdapter | undefined; killSwitchOn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "app-test-"));
  dirs.push(dir);
  const killSwitchFile = join(dir, "KILL_SWITCH");
  if (opts.killSwitchOn === true) writeFileSync(killSwitchFile, "");
  const config: Config = {
    mode: "PAPER",
    killSwitchFile,
    stateDir: join(dir, "state"),
    staleDataThresholdMs: 15_000,
    symbols: ["BTCUSDT"],
    reconcileIntervalMs: 60_000,
    heartbeatIntervalMs: 10_000,
  };
  const alertsReceived: Alert[] = [];
  const feed = new FakeFeed();
  const stateStore = new StateStore(config.stateDir);
  const app = new App({
    config,
    logger: silentLogger,
    alerts: new AlertManager(silentLogger, [{ send: (a) => void alertsReceived.push(a) }]),
    adapter: "adapter" in opts ? opts.adapter : new FakeVenue(),
    stateStore,
    killSwitch: new KillSwitch(config.killSwitchFile),
    staleness: new StalenessDetector(config.staleDataThresholdMs),
    feed,
  });
  return { app, feed, alertsReceived, stateStore };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("App", () => {
  it("anahtar yoksa iskelet modunda kalır, feed başlatılmaz", async () => {
    const { app, feed } = setup({ adapter: undefined });
    const result = await app.start();
    expect(result.status).toBe("skeleton");
    expect(feed.started).toBe(false);
    app.stop();
  });

  it("normal açılış: reconcile + feed + heartbeat çalışır", async () => {
    const { app, feed, stateStore } = setup();
    const result = await app.start();
    expect(result.status).toBe("running");
    expect(feed.started).toBe(true);
    expect(stateStore.load("expected-state")).toBeDefined();
    expect(stateStore.load("heartbeat")).toBeDefined();
    app.stop();
    expect(feed.stopped).toBe(true);
  });

  it("rekonsiliasyon sapmasında DURUR, feed başlatılmaz", async () => {
    const { app, feed, alertsReceived, stateStore } = setup();
    // Lokal state'e venue'dan farklı pozisyon yaz → açılışta sapma.
    stateStore.save("expected-state", {
      positions: { BTC: 1.5 },
      openOrderIds: [],
      balances: {},
    });
    const result = await app.start();
    expect(result.status).toBe("halted");
    expect(feed.started).toBe(false);
    expect(alertsReceived.some((a) => a.kind === "reconciliation_deviation")).toBe(true);
    app.stop();
  });

  it("açılışta kill switch aktifse alarm çıkar ama bot ayakta kalır", async () => {
    const { app, alertsReceived } = setup({ killSwitchOn: true });
    const result = await app.start();
    expect(result.status).toBe("running");
    expect(alertsReceived.some((a) => a.kind === "kill_switch")).toBe(true);
    app.stop();
  });

  it("connect reddi (ör. çekim izni) başlatmayı durdurur", async () => {
    const venue = new FakeVenue();
    venue.connectRejects = true;
    const { app, feed } = setup({ adapter: venue });
    await expect(app.start()).rejects.toThrow(/çekim izni/);
    expect(feed.started).toBe(false);
    app.stop();
  });
});
