import { createHmac } from "node:crypto";
import type { Mode } from "../../config/mode.js";
import type { Logger } from "../../monitoring/logger.js";
import type { Order, OrderSide, OrderState } from "../../oms/order.js";
import type {
  VenueAdapter,
  VenueBalance,
  VenuePosition,
} from "../venue-adapter.js";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Mod izolasyonu URL seviyesinde: yalnızca LIVE gerçek borsaya gider.
 * PAPER ve DRY_RUN her zaman testnet'e bağlanır — karıştırılması imkânsız.
 */
export function binanceRestBase(mode: Mode): string {
  return mode === "LIVE" ? "https://api.binance.com" : "https://testnet.binance.vision";
}

export function binanceStreamBase(mode: Mode): string {
  return mode === "LIVE"
    ? "wss://stream.binance.com:9443"
    : "wss://stream.testnet.binance.vision";
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface BinanceAdapterOptions {
  readonly mode: Mode;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly logger: Logger;
  readonly fetchFn?: FetchLike;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly limiter?: RateLimiter;
  readonly recvWindowMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

interface BinanceAccount {
  canTrade?: boolean;
  canWithdraw?: boolean;
  balances?: { asset: string; free: string; locked: string }[];
}

interface BinanceOrder {
  symbol: string;
  clientOrderId?: string;
  origClientOrderId?: string;
  side: string;
  status: string;
  origQty: string;
  executedQty: string;
  price: string;
}

/** Binance emir durumu → OMS durum makinesi. Bilinmeyen her şey UNKNOWN. */
export function mapBinanceStatus(status: string): OrderState {
  switch (status) {
    case "NEW":
    case "PENDING_CANCEL": // hâlâ açık — iptal onaylanana kadar NEW muamelesi
      return "NEW";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "EXPIRED";
    default:
      return "UNKNOWN"; // asla varsayma — venue'ya tekrar sorulur
  }
}

class BinanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly binanceCode: number | undefined,
    binanceMsg: string | undefined,
    path: string,
  ) {
    // Hata mesajında asla anahtar/imza yok — yalnızca path ve venue mesajı.
    super(`Binance ${status} ${path}${binanceCode !== undefined ? ` code=${binanceCode}` : ""}${binanceMsg !== undefined ? ` msg=${binanceMsg}` : ""}`);
  }
}

/**
 * Binance spot adaptörü (testnet varsayılan). Sözleşmeler:
 * - Anahtarlar yalnızca constructor'a gelir, asla loglanmaz.
 * - connect() çekim izni tespit ederse BAŞLATMAYI REDDEDER.
 * - Emir gönderimi/iptali DRY_RUN modunda adaptör seviyesinde de reddedilir
 *   (savunma derinliği — OMS zaten göndermez).
 * - Tüm istekler rate limiter'dan geçer; 429/418'de backoff + retry.
 */
export class BinanceAdapter implements VenueAdapter {
  readonly name = "binance";

  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;
  private readonly recvWindowMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(private readonly options: BinanceAdapterOptions) {
    if (options.apiKey === "" || options.apiSecret === "") {
      throw new Error("Binance API anahtarı/secret boş olamaz");
    }
    this.baseUrl = binanceRestBase(options.mode);
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = options.limiter ?? new RateLimiter();
    this.recvWindowMs = options.recvWindowMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? Date.now;
  }

  /** Bağlan ve anahtar izinlerini doğrula. Çekim izni varsa başlatma. */
  async connect(): Promise<void> {
    await this.fetchServerTime();
    const account = await this.request<BinanceAccount>("GET", "/api/v3/account", {}, { signed: true, weight: 20 });
    if (account.canWithdraw === true) {
      throw new Error(
        "API anahtarında ÇEKİM (withdrawal) izni var — güvenlik kuralı gereği başlatma REDDEDİLDİ. " +
          "Yalnızca işlem izinli bir anahtar kullanın.",
      );
    }
    if (account.canTrade === false) {
      throw new Error("API anahtarında işlem izni yok");
    }
    this.options.logger.info("binance bağlantısı doğrulandı", {
      venue: this.name,
      baseUrl: this.baseUrl,
      canTrade: account.canTrade ?? "bilinmiyor",
      canWithdraw: account.canWithdraw ?? false,
    });
  }

  async fetchServerTime(): Promise<number> {
    const res = await this.request<{ serverTime: number }>("GET", "/api/v3/time", {}, { weight: 1 });
    return res.serverTime;
  }

  /** Spot'ta pozisyon = sıfır olmayan varlık bakiyesi (free + locked). */
  async fetchPositions(): Promise<readonly VenuePosition[]> {
    const balances = await this.fetchBalances();
    return balances
      .map((b) => ({ symbol: b.asset, quantity: b.free + b.locked }))
      .filter((p) => p.quantity !== 0);
  }

  async fetchBalances(): Promise<readonly VenueBalance[]> {
    const account = await this.request<BinanceAccount>("GET", "/api/v3/account", {}, { signed: true, weight: 20 });
    return (account.balances ?? [])
      .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
      .filter((b) => b.free !== 0 || b.locked !== 0);
  }

  async fetchOpenOrders(): Promise<readonly Order[]> {
    const orders = await this.request<BinanceOrder[]>("GET", "/api/v3/openOrders", {}, { signed: true, weight: 40 });
    return orders.map((o) => this.toOrder(o));
  }

  /** clientOrderId venue'ya newClientOrderId olarak gider — retry aynı ID ile idempotenttir. */
  async submitOrder(order: Order): Promise<Order> {
    this.assertOrderingAllowed("emir gönderimi");
    const params: Record<string, string> = {
      symbol: order.symbol,
      side: order.side,
      type: order.price !== undefined ? "LIMIT" : "MARKET",
      quantity: String(order.quantity),
      newClientOrderId: order.clientOrderId,
    };
    if (order.price !== undefined) {
      params.price = String(order.price);
      params.timeInForce = "GTC";
    }
    const res = await this.request<BinanceOrder>("POST", "/api/v3/order", params, { signed: true, weight: 1 });
    return this.toOrder(res, order);
  }

  /** UNKNOWN emri venue'ya sor — emir hiç ulaşmadıysa undefined döner. */
  async queryOrder(clientOrderId: string, symbol: string): Promise<Order | undefined> {
    try {
      const res = await this.request<BinanceOrder>(
        "GET",
        "/api/v3/order",
        { origClientOrderId: clientOrderId, symbol },
        { signed: true, weight: 4 },
      );
      return this.toOrder(res);
    } catch (err) {
      if (err instanceof BinanceHttpError && err.binanceCode === -2013) {
        return undefined; // "Order does not exist" — emir venue'ya hiç ulaşmamış
      }
      throw err;
    }
  }

  async cancelOrder(clientOrderId: string, symbol: string): Promise<void> {
    this.assertOrderingAllowed("emir iptali");
    await this.request("DELETE", "/api/v3/order", { origClientOrderId: clientOrderId, symbol }, { signed: true, weight: 1 });
  }

  private assertOrderingAllowed(action: string): void {
    if (this.options.mode === "DRY_RUN") {
      throw new Error(`DRY_RUN modunda ${action} venue'ya gitmez (adaptör seviyesi koruma)`);
    }
  }

  private toOrder(o: BinanceOrder, base?: Order): Order {
    const clientOrderId = o.clientOrderId ?? o.origClientOrderId ?? base?.clientOrderId ?? "";
    const price = Number(o.price);
    return {
      clientOrderId,
      symbol: o.symbol,
      side: (o.side as OrderSide) ?? base?.side ?? "BUY",
      quantity: Number(o.origQty),
      ...(price > 0 ? { price } : {}),
      reduceOnly: base?.reduceOnly ?? false,
      state: mapBinanceStatus(o.status),
      filledQuantity: Number(o.executedQty),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    params: Record<string, string>,
    opts: { signed?: boolean; weight: number },
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const acquired = this.limiter.tryAcquire(opts.weight);
      if (!acquired.ok) {
        this.options.logger.warn("rate limit bütçesi dolu — bekleniyor", {
          retryInMs: acquired.retryInMs,
          path,
        });
        await this.sleepFn(acquired.retryInMs);
        continue;
      }

      const query = this.buildQuery(params, opts.signed === true);
      const url = `${this.baseUrl}${path}${query !== "" ? `?${query}` : ""}`;
      const response = await this.fetchFn(url, {
        method,
        headers: { "X-MBX-APIKEY": this.options.apiKey },
      });

      if (response.status === 429 || response.status === 418) {
        const retryAfterSec = Number(response.headers.get("Retry-After") ?? "");
        const backoff = this.limiter.onRateLimited(
          Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1_000 : undefined,
        );
        this.options.logger.warn("venue rate limit — backoff uygulanıyor", {
          status: response.status,
          backoffMs: backoff,
          attempt,
          path,
        });
        if (attempt >= this.maxAttempts) {
          throw new BinanceHttpError(response.status, undefined, "rate limit — deneme hakkı bitti", path);
        }
        await this.sleepFn(backoff);
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        this.limiter.onSuccess();
        return (await response.json()) as T;
      }

      let code: number | undefined;
      let msg: string | undefined;
      try {
        const body = (await response.json()) as { code?: number; msg?: string };
        code = body.code;
        msg = body.msg;
      } catch {
        // gövde JSON değilse durum kodu yeter
      }
      throw new BinanceHttpError(response.status, code, msg, path);
    }
  }

  private buildQuery(params: Record<string, string>, signed: boolean): string {
    const entries = Object.entries(params).filter(([, v]) => v !== "");
    if (signed) {
      entries.push(["timestamp", String(this.now())]);
      entries.push(["recvWindow", String(this.recvWindowMs)]);
    }
    const query = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (!signed) return query;
    const signature = createHmac("sha256", this.options.apiSecret).update(query).digest("hex");
    return `${query}&signature=${signature}`;
  }
}

/**
 * Anahtarları DOĞRUDAN environment'tan okur — Config nesnesine girmezler,
 * böylece yanlışlıkla loglanamazlar. Anahtar yoksa undefined döner
 * (çevrimdışı iskelet modu).
 */
export function createBinanceAdapterFromEnv(
  mode: Mode,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): BinanceAdapter | undefined {
  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;
  if (apiKey === undefined || apiKey === "" || apiSecret === undefined || apiSecret === "") {
    return undefined;
  }
  return new BinanceAdapter({ mode, apiKey, apiSecret, logger });
}
