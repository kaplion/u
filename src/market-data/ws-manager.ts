import type { Logger } from "../monitoring/logger.js";

/**
 * Test edilebilirlik için enjekte edilebilir WebSocket taşıyıcısı.
 * Varsayılan implementasyon global `WebSocket`'i sarar.
 */
export interface WsTransport {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | undefined;
  onmessage: ((data: string) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: ((err: unknown) => void) | undefined;
}

export type WsFactory = (url: string) => WsTransport;

export const defaultWsFactory: WsFactory = (url) => {
  const ws = new WebSocket(url);
  const transport: WsTransport = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: undefined,
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
  };
  ws.onopen = () => transport.onopen?.();
  ws.onmessage = (ev) => transport.onmessage?.(String(ev.data));
  ws.onclose = () => transport.onclose?.();
  ws.onerror = (ev) => transport.onerror?.(ev);
  return transport;
};

export interface WsManagerOptions {
  readonly url: string;
  readonly logger: Logger;
  readonly onMessage: (data: string) => void;
  /**
   * Her (re)connect'te, normal akış başlamadan ÖNCE çağrılır — REST
   * snapshot ile resync burada yapılır. Kaldığın yerden devam ettiğini
   * varsayma. Hata fırlatırsa bağlantı başarısız sayılır.
   */
  readonly onResync?: () => Promise<void> | void;
  /** Restart döngüsü koruması tetiklenince çağrılır (dur ve alarm ver). */
  readonly onFatal?: (reason: string) => void;
  readonly factory?: WsFactory;
  /** Feed bu süre sessiz kalırsa bağlantı bayat sayılır ve zorla yenilenir. */
  readonly heartbeatTimeoutMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Üst üste bu kadar başarısız denemeden sonra durdur (restart döngüsü koruması). */
  readonly maxConsecutiveFailures?: number;
}

type WsState = "IDLE" | "CONNECTING" | "CONNECTED" | "WAITING_RETRY" | "STOPPED";

/**
 * WebSocket yaşam döngüsü yönetimi: exponential backoff ile reconnect,
 * sessizlik (heartbeat) algısı, reconnect'te resync kancası ve restart
 * döngüsü koruması. Kopunca toparlanmak stratejinin değil bu katmanın işi.
 */
export class WsManager {
  private state: WsState = "IDLE";
  private ws: WsTransport | undefined;
  private consecutiveFailures = 0;
  private lastMessageAt = 0;
  private silenceTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly heartbeatTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly factory: WsFactory;

  constructor(private readonly options: WsManagerOptions) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
    this.factory = options.factory ?? defaultWsFactory;
  }

  start(): void {
    if (this.state !== "IDLE" && this.state !== "STOPPED") return;
    this.state = "IDLE";
    this.connect();
  }

  stop(): void {
    this.state = "STOPPED";
    this.clearTimers();
    this.closeSocket();
  }

  isConnected(): boolean {
    return this.state === "CONNECTED";
  }

  private connect(): void {
    if (this.state === "STOPPED") return;
    this.state = "CONNECTING";
    this.options.logger.info("ws bağlanıyor", {
      url: this.options.url,
      attempt: this.consecutiveFailures + 1,
    });

    let ws: WsTransport;
    try {
      ws = this.factory(this.options.url);
    } catch (err) {
      this.onConnectionLost(`ws oluşturulamadı: ${String(err)}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      void this.handleOpen(ws);
    };
    ws.onmessage = (data) => {
      if (this.ws !== ws) return; // eski bağlantıdan artık mesaj
      this.lastMessageAt = Date.now();
      this.options.onMessage(data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onConnectionLost("ws kapandı");
    };
    ws.onerror = (err) => {
      if (this.ws !== ws) return;
      this.options.logger.warn("ws hatası", { error: String(err) });
    };
  }

  private async handleOpen(ws: WsTransport): Promise<void> {
    if (this.ws !== ws || this.state === "STOPPED") return;
    try {
      // Önce resync: reconnect'te kaldığın yerden devam ettiğini varsayma.
      await this.options.onResync?.();
    } catch (err) {
      this.options.logger.error("resync başarısız — bağlantı yenilenecek", {
        error: String(err),
      });
      this.closeSocket();
      this.onConnectionLost("resync başarısız");
      return;
    }
    if (this.ws !== ws || (this.state as WsState) === "STOPPED") return;
    this.state = "CONNECTED";
    this.consecutiveFailures = 0;
    this.lastMessageAt = Date.now();
    this.startSilenceWatch();
    this.options.logger.info("ws bağlandı ve resync tamam");
  }

  /** Feed sessizleşti ama bağlantı açık görünüyor — zorla yenile. */
  private startSilenceWatch(): void {
    this.stopSilenceWatch();
    this.silenceTimer = setInterval(() => {
      if (this.state !== "CONNECTED") return;
      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > this.heartbeatTimeoutMs) {
        this.options.logger.warn("feed sessiz — bağlantı zorla yenileniyor", {
          silentForMs: silentFor,
        });
        this.closeSocket();
        this.onConnectionLost("feed sessiz");
      }
    }, Math.max(250, Math.floor(this.heartbeatTimeoutMs / 4)));
  }

  private stopSilenceWatch(): void {
    if (this.silenceTimer !== undefined) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }

  private onConnectionLost(reason: string): void {
    if (this.state === "STOPPED" || this.state === "WAITING_RETRY") return;
    this.stopSilenceWatch();
    this.ws = undefined;
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.state = "STOPPED";
      const msg = `ws üst üste ${this.consecutiveFailures} kez başarısız — durduruldu (${reason})`;
      this.options.logger.error(msg);
      this.options.onFatal?.(msg);
      return;
    }

    const backoff = Math.min(
      this.baseBackoffMs * 2 ** (this.consecutiveFailures - 1),
      this.maxBackoffMs,
    );
    this.state = "WAITING_RETRY";
    this.options.logger.warn("ws koptu — reconnect planlandı", {
      reason,
      backoffMs: backoff,
      failures: this.consecutiveFailures,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if ((this.state as WsState) === "STOPPED") return;
      this.state = "IDLE";
      this.connect();
    }, backoff);
  }

  private clearTimers(): void {
    this.stopSilenceWatch();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws !== undefined) {
      ws.onclose = undefined;
      ws.onerror = undefined;
      ws.onmessage = undefined;
      ws.onopen = undefined;
      try {
        ws.close();
      } catch {
        // kapanmış soketi kapatmak sorun değil
      }
    }
  }
}
