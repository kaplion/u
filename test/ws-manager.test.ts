import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SequenceTracker } from "../src/market-data/sequence.js";
import { WsManager, type WsTransport } from "../src/market-data/ws-manager.js";
import { Logger } from "../src/monitoring/logger.js";

const silentLogger = new Logger("DRY_RUN", () => {});

/** Test için kontrol edilebilir sahte WebSocket. */
class FakeWs implements WsTransport {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | undefined;
  onmessage: ((data: string) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: ((err: unknown) => void) | undefined;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.(data);
  }
  drop(): void {
    this.onclose?.();
  }
}

describe("SequenceTracker", () => {
  it("ardışık akışı ok sayar, boşluğu ve tekrarı yakalar", () => {
    const t = new SequenceTracker();
    expect(t.next(10)).toBe("ok");
    expect(t.next(11)).toBe("ok");
    expect(t.next(13)).toBe("gap");
    expect(t.next(13)).toBe("duplicate");
    t.reset();
    expect(t.next(100)).toBe("ok");
  });
});

describe("WsManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<ConstructorParameters<typeof WsManager>[0]> = {}) {
    const sockets: FakeWs[] = [];
    const messages: string[] = [];
    const resyncs: number[] = [];
    const fatals: string[] = [];
    const manager = new WsManager({
      url: "wss://test.local/stream",
      logger: silentLogger,
      onMessage: (d) => void messages.push(d),
      onResync: () => void resyncs.push(Date.now()),
      onFatal: (r) => void fatals.push(r),
      factory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      heartbeatTimeoutMs: 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      maxConsecutiveFailures: 3,
      ...overrides,
    });
    return { manager, sockets, messages, resyncs, fatals };
  }

  it("bağlanır, resync yapar, mesaj iletir", async () => {
    const { manager, sockets, messages, resyncs } = setup();
    manager.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(resyncs).toHaveLength(1);
    expect(manager.isConnected()).toBe(true);
    sockets[0]!.message("tick");
    expect(messages).toEqual(["tick"]);
    manager.stop();
  });

  it("kopunca exponential backoff ile reconnect eder ve yeniden resync yapar", async () => {
    const { manager, sockets, resyncs } = setup();
    manager.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(manager.isConnected()).toBe(true);

    sockets[0]!.drop();
    expect(manager.isConnected()).toBe(false);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100); // baseBackoffMs
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(manager.isConnected()).toBe(true);
    expect(resyncs).toHaveLength(2); // her reconnect'te resync
    manager.stop();
  });

  it("feed sessizleşince bağlantıyı zorla yeniler", async () => {
    const { manager, sockets } = setup();
    manager.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(manager.isConnected()).toBe(true);

    // 1sn heartbeat eşiği — hiç mesaj gelmeden zaman ilerlet.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets[0]!.closed).toBe(true);
    expect(manager.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    manager.stop();
  });

  it("mesaj akarken sessizlik tetiklenmez", async () => {
    const { manager, sockets } = setup();
    manager.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
      sockets[0]!.message("tick");
    }
    expect(manager.isConnected()).toBe(true);
    expect(sockets).toHaveLength(1);
    manager.stop();
  });

  it("restart döngüsü koruması: üst üste başarısızlıkta durur ve onFatal çağrılır", async () => {
    const { manager, sockets, fatals } = setup();
    manager.start();
    // Hiç open olmadan sürekli düşür.
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(100);
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(200);
    sockets[2]!.drop(); // 3. başarısızlık = maxConsecutiveFailures
    expect(fatals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(3); // yeni deneme yok
  });

  it("resync hatası bağlantıyı başarısız sayar", async () => {
    const { manager, sockets } = setup({
      onResync: () => {
        throw new Error("snapshot alınamadı");
      },
    });
    manager.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    expect(manager.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    manager.stop();
  });

  it("stop sonrası reconnect denemez", async () => {
    const { manager, sockets } = setup();
    manager.start();
    sockets[0]!.open();
    await vi.runOnlyPendingTimersAsync();
    manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
