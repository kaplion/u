import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertManager } from "../src/monitoring/alerts.js";
import { Logger } from "../src/monitoring/logger.js";
import { AuditLog } from "../src/oms/audit-log.js";
import { Oms } from "../src/oms/oms.js";
import type { RiskContext } from "../src/risk/risk-gate.js";
import { RiskTracker } from "../src/risk/risk-tracker.js";
import { StateStore } from "../src/state/state-store.js";
import { HoldStrategy, StrategyRunner, type Strategy } from "../src/strategy/strategy.js";

const silentLogger = new Logger("DRY_RUN", () => {});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDryRunOms(ctx: Partial<RiskContext> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strat-"));
  dirs.push(dir);
  return new Oms({
    mode: "DRY_RUN",
    store: new StateStore(join(dir, "state")),
    audit: new AuditLog(join(dir, "state"), "DRY_RUN"),
    logger: silentLogger,
    alerts: new AlertManager(silentLogger),
    riskContext: () => ({
      mode: "DRY_RUN",
      assetClass: "crypto",
      killSwitchActive: false,
      lastPrice: 100,
      dataStale: false,
      currentSymbolNotional: 0,
      currentGrossNotional: 0,
      dailyLoss: 0,
      ordersLastMinute: 0,
      ...ctx,
    }),
  });
}

describe("strateji runtime", () => {
  it("HoldStrategy hiç sinyal üretmez", async () => {
    const runner = new StrategyRunner({
      strategy: new HoldStrategy(),
      oms: makeDryRunOms(),
      mode: "DRY_RUN",
      logger: silentLogger,
    });
    const result = await runner.evaluate({ symbol: "BTCUSDT", lastPrice: 100, position: 2 });
    expect(result).toBeUndefined();
  });

  it("hedef > mevcut → BUY delta emri OMS'ten geçer", async () => {
    const oms = makeDryRunOms();
    const strategy: Strategy = { name: "test", targetPosition: () => 3 };
    const runner = new StrategyRunner({ strategy, oms, mode: "DRY_RUN", logger: silentLogger });
    const result = await runner.evaluate({ symbol: "BTCUSDT", lastPrice: 100, position: 1 });
    expect(result?.accepted).toBe(true);
    if (result?.accepted === true) {
      expect(result.order.side).toBe("BUY");
      expect(result.order.quantity).toBe(2);
      expect(result.order.reduceOnly).toBe(false);
    }
  });

  it("pozisyon küçültme reduceOnly işaretlenir (kill switch altında bile geçer)", async () => {
    const oms = makeDryRunOms({ killSwitchActive: true });
    const strategy: Strategy = { name: "test", targetPosition: () => 1 };
    const runner = new StrategyRunner({ strategy, oms, mode: "DRY_RUN", logger: silentLogger });
    const result = await runner.evaluate({ symbol: "BTCUSDT", lastPrice: 100, position: 3 });
    expect(result?.accepted).toBe(true);
    if (result?.accepted === true) {
      expect(result.order.side).toBe("SELL");
      expect(result.order.reduceOnly).toBe(true);
    }
  });

  it("risk kapısı stratejiyi EZER: limit üstü hedef reddedilir", async () => {
    const oms = makeDryRunOms();
    const strategy: Strategy = { name: "açgözlü", targetPosition: () => 1_000 }; // 100k USD >> limit
    const runner = new StrategyRunner({ strategy, oms, mode: "DRY_RUN", logger: silentLogger });
    const result = await runner.evaluate({ symbol: "BTCUSDT", lastPrice: 100, position: 0 });
    expect(result?.accepted).toBe(false);
  });

  it("LIVE modda doğrulama raporu (Deflated Sharpe + PBO) olmayan strateji çalıştırılmaz", () => {
    expect(
      () =>
        new StrategyRunner({
          strategy: { name: "dogrulanmamis", targetPosition: () => 0 },
          oms: makeDryRunOms(),
          mode: "LIVE",
          logger: silentLogger,
        }),
    ).toThrow(/Deflated Sharpe/);

    // Doğrulama raporu olan strateji kabul edilir.
    expect(
      () =>
        new StrategyRunner({
          strategy: {
            name: "dogrulanmis",
            validation: { deflatedSharpe: 1.1, pbo: 0.2 },
            targetPosition: () => 0,
          },
          oms: makeDryRunOms(),
          mode: "LIVE",
          logger: silentLogger,
        }),
    ).not.toThrow();
  });
});

describe("risk tracker", () => {
  it("fill'ler pozisyonu ve ortalama girişi günceller", () => {
    const t = new RiskTracker();
    t.recordFill("BTCUSDT", "BUY", 1, 100);
    t.recordFill("BTCUSDT", "BUY", 1, 110);
    expect(t.position("BTCUSDT")).toBe(2);
    expect(t.symbolNotional("BTCUSDT", 105)).toBe(210);
  });

  it("kapanan pozisyon gerçekleşen PnL üretir; zarar dailyLoss'a yansır", () => {
    const t = new RiskTracker();
    t.recordFill("BTCUSDT", "BUY", 2, 100);
    t.recordFill("BTCUSDT", "SELL", 2, 90); // -20 zarar
    expect(t.position("BTCUSDT")).toBe(0);
    expect(t.realizedPnl()).toBe(-20);
    expect(t.dailyLoss()).toBe(20);
  });

  it("kâr dailyLoss'u artırmaz", () => {
    const t = new RiskTracker();
    t.recordFill("BTCUSDT", "BUY", 1, 100);
    t.recordFill("BTCUSDT", "SELL", 1, 120); // +20 kâr
    expect(t.realizedPnl()).toBe(20);
    expect(t.dailyLoss()).toBe(0);
  });

  it("gün dönünce günlük sayaç sıfırlanır", () => {
    let nowMs = Date.UTC(2024, 0, 1, 12);
    const t = new RiskTracker(() => nowMs);
    t.recordFill("BTCUSDT", "BUY", 1, 100);
    t.recordFill("BTCUSDT", "SELL", 1, 50); // -50
    expect(t.dailyLoss()).toBe(50);
    nowMs = Date.UTC(2024, 0, 2, 12); // ertesi gün
    expect(t.dailyLoss()).toBe(0);
  });

  it("dakikadaki emir sayacı eski kayıtları düşürür", () => {
    let nowMs = 0;
    const t = new RiskTracker(() => nowMs);
    t.recordOrderAttempt();
    t.recordOrderAttempt();
    expect(t.ordersLastMinute()).toBe(2);
    nowMs = 61_000;
    expect(t.ordersLastMinute()).toBe(0);
  });

  it("brüt notional tüm sembolleri toplar", () => {
    const t = new RiskTracker();
    t.recordFill("BTCUSDT", "BUY", 1, 100);
    t.recordFill("ETHUSDT", "SELL", 2, 50); // short da brüte sayılır
    expect(t.grossNotional((s) => (s === "BTCUSDT" ? 100 : 50))).toBe(200);
  });
});
