import { describe, expect, it, vi } from "vitest";
import { AlertManager, type Alert } from "../src/monitoring/alerts.js";
import { ClockDriftMonitor } from "../src/monitoring/clock-drift.js";
import { Heartbeat } from "../src/monitoring/heartbeat.js";
import { Logger, type LogEntry } from "../src/monitoring/logger.js";
import { StateStore } from "../src/state/state-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: new Logger("DRY_RUN", (e) => entries.push(e)), entries };
}

describe("AlertManager", () => {
  it("alarmı loglar ve kanallara dağıtır", () => {
    const { logger, entries } = captureLogger();
    const received: Alert[] = [];
    const manager = new AlertManager(logger, [{ send: (a) => void received.push(a) }]);
    manager.raise("stale_data", "feed sessiz", { silentForMs: 5000 });
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("stale_data");
    expect(entries.some((e) => e.level === "error" && e.msg.includes("stale_data"))).toBe(true);
  });

  it("kanal hatası botu düşürmez", () => {
    const { logger } = captureLogger();
    const manager = new AlertManager(logger, [
      {
        send: () => {
          throw new Error("kanal çöktü");
        },
      },
    ]);
    expect(() => manager.raise("fatal", "test")).not.toThrow();
  });

  it("async kanal reddi botu düşürmez", async () => {
    const { logger, entries } = captureLogger();
    const manager = new AlertManager(logger, [
      { send: () => Promise.reject(new Error("ağ yok")) },
    ]);
    manager.raise("fatal", "test");
    await new Promise((r) => setTimeout(r, 0));
    expect(entries.some((e) => e.msg.includes("alarm kanalı hatası"))).toBe(true);
  });
});

describe("ClockDriftMonitor", () => {
  it("drift'i ölçer ve eşiği uygular", async () => {
    let localNow = 1_000_000;
    const monitor = new ClockDriftMonitor(
      async () => 1_000_000 + 5_000, // venue 5sn ileride
      1_000,
      () => localNow,
    );
    const result = await monitor.check();
    expect(result.driftMs).toBe(5_000);
    expect(result.ok).toBe(false);

    const okMonitor = new ClockDriftMonitor(async () => localNow + 100, 1_000, () => localNow);
    expect((await okMonitor.check()).ok).toBe(true);
  });
});

describe("Heartbeat", () => {
  it("dışarıdan izlenebilir heartbeat dosyası yazar", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-test-"));
    try {
      const store = new StateStore(dir);
      const beat = new Heartbeat(store, () => 1_700_000_000_000);
      beat.beat({ feedConnected: true });
      const saved = store.load<{ at: string; feedConnected: boolean }>("heartbeat");
      expect(saved?.at).toBe(new Date(1_700_000_000_000).toISOString());
      expect(saved?.feedConnected).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
