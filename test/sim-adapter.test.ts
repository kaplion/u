import { describe, it, expect } from "vitest";
import { createAdapter } from "../src/index.js";
import { loadConfig } from "../src/config/config.js";
import { Logger } from "../src/monitoring/logger.js";
import { SimVenueAdapter } from "../src/venues/sim/sim-adapter.js";

const logger = new Logger("DRY_RUN");

describe("SimVenueAdapter", () => {
  it("yalnızca DRY_RUN'da oluşturulabilir", () => {
    expect(() => new SimVenueAdapter("PAPER")).toThrow();
    expect(() => new SimVenueAdapter("LIVE")).toThrow();
    expect(new SimVenueAdapter("DRY_RUN").name).toBe("sim");
  });

  it("boş gerçeklik döndürür ve emir göndermez", async () => {
    const sim = new SimVenueAdapter("DRY_RUN");
    await sim.connect();
    expect(await sim.fetchPositions()).toEqual([]);
    expect(await sim.fetchOpenOrders()).toEqual([]);
    expect(await sim.fetchBalances()).toEqual([]);
    expect(await sim.queryOrder("c1", "BTCUSDT")).toBeUndefined();
    expect(Math.abs((await sim.fetchServerTime()) - Date.now())).toBeLessThan(5_000);
    await expect(
      sim.submitOrder({
        clientOrderId: "c1",
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 1,
        reduceOnly: false,
        state: "PENDING_NEW",
        filledQuantity: 0,
      }),
    ).rejects.toThrow();
    await expect(sim.cancelOrder("c1", "BTCUSDT")).rejects.toThrow();
  });
});

describe("createAdapter", () => {
  it("anahtar yoksa DRY_RUN'da simülasyon adaptörü verir", () => {
    const config = loadConfig({ BOT_MODE: "DRY_RUN" });
    expect(createAdapter(config, logger)).toBeInstanceOf(SimVenueAdapter);
  });

  it("anahtar yoksa PAPER/LIVE'da adaptör vermez (iskelet modu)", () => {
    expect(createAdapter(loadConfig({ BOT_MODE: "PAPER" }), logger)).toBeUndefined();
    expect(createAdapter(loadConfig({ BOT_MODE: "LIVE" }), logger)).toBeUndefined();
  });

  it("anahtar varsa gerçek venue adaptörünü verir", () => {
    const config = loadConfig({ BOT_MODE: "DRY_RUN" });
    const adapter = createAdapter(config, logger, {
      BINANCE_API_KEY: "k",
      BINANCE_API_SECRET: "s",
    });
    expect(adapter?.name).toBe("binance");
  });
});
