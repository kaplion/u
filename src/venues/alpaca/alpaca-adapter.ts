import type { Mode } from "../../config/mode.js";
import type { Logger } from "../../monitoring/logger.js";
import type { Order, OrderSide, OrderState } from "../../oms/order.js";
import type {
  VenueAdapter,
  VenueBalance,
  VenuePriceTick,
  VenuePosition,
  VenueStatus,
} from "../venue-adapter.js";

/**
 * Mod izolasyonu URL seviyesinde: yalnızca LIVE gerçek Alpaca'ya gider.
 * PAPER ve DRY_RUN her zaman paper ortamına bağlanır.
 */
export function alpacaRestBase(mode: Mode): string {
  return mode === "LIVE" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";
}

export function alpacaDataBase(): string {
  return "https://data.alpaca.markets";
}

export type AlpacaFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface AlpacaAdapterOptions {
  readonly mode: Mode;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly logger: Logger;
  readonly fetchFn?: AlpacaFetchLike;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  /** Uzatılmış seans işlemi ayrı bayrak ister — varsayılan kapalı. */
  readonly allowExtendedHours?: boolean;
}

interface AlpacaAccount {
  status?: string;
  account_blocked?: boolean;
  trading_blocked?: boolean;
  pattern_day_trader?: boolean;
  daytrade_count?: number;
  equity?: string;
  cash?: string;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price?: string;
}

interface AlpacaClock {
  timestamp?: string;
  is_open?: boolean;
}

interface AlpacaOrder {
  id?: string;
  client_order_id?: string;
  symbol?: string;
  side?: string;
  qty?: string;
  filled_qty?: string;
  limit_price?: string | null;
  status?: string;
}

/** Alpaca emir durumu → OMS durum makinesi. Bilinmeyen her şey UNKNOWN. */
export function mapAlpacaStatus(status: string): OrderState {
  switch (status) {
    case "new":
    case "accepted":
    case "pending_new":
    case "accepted_for_bidding":
    case "pending_cancel": // iptal onaylanana kadar açık sayılır
    case "pending_replace":
      return "NEW";
    case "partially_filled":
      return "PARTIALLY_FILLED";
    case "filled":
      return "FILLED";
    case "canceled":
    case "done_for_day":
    case "replaced":
      return "CANCELED";
    case "rejected":
    case "stopped":
    case "suspended":
      return "REJECTED";
    case "expired":
      return "EXPIRED";
    default:
      return "UNKNOWN"; // asla varsayma — venue'ya tekrar sorulur
  }
}

class AlpacaHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string | undefined,
    path: string,
  ) {
    // Hata mesajında asla anahtar yok — yalnızca path ve venue mesajı.
    super(`Alpaca ${status} ${path}${detail !== undefined ? ` msg=${detail}` : ""}`);
  }
}

/**
 * Alpaca (ABD hisse) adaptörü — Faz 5: adaptör soyutlamasının gerçekten
 * soyut olduğunun kanıtı. Venue'ye özgü semantik GİZLENMEZ, burada açıkça
 * ele alınır:
 * - Piyasa saatleri zorunluluğu: seans dışında emir REDDEDİLİR
 *   (uzatılmış seans ayrı bayrak ister).
 * - PDT kuralı: hesap < $25k ve 3 gün-içi işlem sınırındaysa yeni emir
 *   gönderilmez — botun kendisi sayar, borsanın cezasını beklemez.
 * - DRY_RUN'da emir gönderimi adaptör seviyesinde de reddedilir.
 * - 429'da exponential backoff.
 */
export class AlpacaAdapter implements VenueAdapter {
  readonly name = "alpaca";

  private readonly baseUrl: string;
  private readonly fetchFn: AlpacaFetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly options: AlpacaAdapterOptions) {
    if (options.apiKey === "" || options.apiSecret === "") {
      throw new Error("Alpaca API anahtarı/secret boş olamaz");
    }
    this.baseUrl = alpacaRestBase(options.mode);
    this.fetchFn = options.fetchFn ?? (fetch as unknown as AlpacaFetchLike);
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /** Bağlan ve hesabı doğrula — bloke hesapla başlatma REDDEDİLİR. */
  async connect(): Promise<void> {
    const account = await this.request<AlpacaAccount>("GET", "/v2/account");
    if (account.account_blocked === true || account.trading_blocked === true) {
      throw new Error("Alpaca hesabı işlem için bloke — başlatma REDDEDİLDİ");
    }
    if (account.status !== undefined && account.status !== "ACTIVE") {
      throw new Error(`Alpaca hesabı aktif değil (status=${account.status})`);
    }
    this.options.logger.info("alpaca bağlantısı doğrulandı", {
      venue: this.name,
      baseUrl: this.baseUrl,
      patternDayTrader: account.pattern_day_trader ?? false,
    });
  }

  async fetchServerTime(): Promise<number> {
    const clock = await this.request<AlpacaClock>("GET", "/v2/clock");
    return new Date(clock.timestamp ?? 0).getTime();
  }

  async fetchPositions(): Promise<readonly VenuePosition[]> {
    const positions = await this.request<AlpacaPosition[]>(
      "GET",
      "/v2/positions",
    );
    return positions
      .map((p) => {
        const avgPrice = Number(p.avg_entry_price ?? 0);
        return {
          symbol: p.symbol,
          quantity: Number(p.qty),
          ...(avgPrice > 0 ? { avgPrice } : {}),
        };
      })
      .filter((p) => p.quantity !== 0);
  }

  async fetchBalances(): Promise<readonly VenueBalance[]> {
    const account = await this.request<AlpacaAccount>("GET", "/v2/account");
    const cash = Number(account.cash ?? 0);
    return cash !== 0 ? [{ asset: "USD", free: cash, locked: 0 }] : [];
  }

  async fetchOpenOrders(): Promise<readonly Order[]> {
    const orders = await this.request<AlpacaOrder[]>("GET", "/v2/orders?status=open&limit=500");
    return orders.map((o) => this.toOrder(o));
  }

  /** client_order_id ile idempotent gönderim + seans ve PDT korumaları. */
  async submitOrder(order: Order): Promise<Order> {
    this.assertOrderingAllowed("emir gönderimi");
    await this.assertTradableAccount();
    await this.assertMarketOpen();
    await this.assertPdtAllows();

    const body: Record<string, unknown> = {
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      qty: formatDecimal(roundQuantity(order.quantity)),
      type: order.price !== undefined ? "limit" : "market",
      time_in_force: "day",
      client_order_id: order.clientOrderId,
      extended_hours: this.options.allowExtendedHours === true,
    };
    if (order.price !== undefined) body.limit_price = formatDecimal(roundEquityPrice(order.price));

    const res = await this.request<AlpacaOrder>("POST", "/v2/orders", JSON.stringify(body));
    return this.toOrder(res, order);
  }

  /** UNKNOWN emri venue'ya sor — emir hiç ulaşmadıysa undefined döner. */
  async queryOrder(clientOrderId: string): Promise<Order | undefined> {
    try {
      const res = await this.request<AlpacaOrder>(
        "GET",
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      );
      return this.toOrder(res);
    } catch (err) {
      if (err instanceof AlpacaHttpError && err.status === 404) {
        return undefined; // emir venue'ya hiç ulaşmamış
      }
      throw err;
    }
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    this.assertOrderingAllowed("emir iptali");
    await this.assertTradableAccount();
    const existing = await this.request<AlpacaOrder>(
      "GET",
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    );
    if (existing.id === undefined) {
      throw new Error("iptal edilecek emir venue'da bulunamadı");
    }
    await this.request("DELETE", `/v2/orders/${encodeURIComponent(existing.id)}`);
  }

  async fetchLatestPrices(symbols: readonly string[]): Promise<readonly VenuePriceTick[]> {
    if (symbols.length === 0) return [];
    const response = await this.fetchFn(
      `${alpacaDataBase()}/v2/stocks/trades/latest?symbols=${encodeURIComponent(symbols.join(","))}`,
      {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": this.options.apiKey,
          "APCA-API-SECRET-KEY": this.options.apiSecret,
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new AlpacaHttpError(response.status, undefined, "/v2/stocks/trades/latest");
    }
    const body = (await response.json()) as {
      trades?: Record<string, { p?: number; t?: string }>;
    };
    return Object.entries(body.trades ?? {})
      .map(([symbol, trade]) => ({
        symbol,
        price: Number(trade.p ?? 0),
        at: trade.t !== undefined ? new Date(trade.t).getTime() : Date.now(),
        marketOpen: true,
      }))
      .filter((tick) => Number.isFinite(tick.price) && tick.price > 0);
  }

  async fetchVenueStatus(): Promise<VenueStatus> {
    const [account, clock] = await Promise.all([
      this.request<AlpacaAccount>("GET", "/v2/account"),
      this.request<AlpacaClock>("GET", "/v2/clock"),
    ]);
    return {
      marketOpen: this.options.allowExtendedHours === true ? true : clock.is_open === true,
      accountBlocked: account.account_blocked === true,
      tradingBlocked: account.trading_blocked === true || account.status === "ACCOUNT_BLOCKED",
      dayTradeCount: account.daytrade_count ?? 0,
      patternDayTrader: account.pattern_day_trader ?? false,
    };
  }

  private assertOrderingAllowed(action: string): void {
    if (this.options.mode === "DRY_RUN") {
      throw new Error(`DRY_RUN modunda ${action} venue'ya gitmez (adaptör seviyesi koruma)`);
    }
  }

  /** Piyasa saatleri zorunluluğu — seans dışında emir gönderme. */
  private async assertMarketOpen(): Promise<void> {
    if (this.options.allowExtendedHours === true) return;
    const clock = await this.request<AlpacaClock>("GET", "/v2/clock");
    if (clock.is_open !== true) {
      throw new Error("piyasa kapalı — seans dışında emir gönderilmez (NYSE takvimi)");
    }
  }

  /** PDT kuralı: hesap < $25k ise 5 iş gününde en fazla 3 gün-içi işlem. */
  private async assertPdtAllows(): Promise<void> {
    const account = await this.request<AlpacaAccount>("GET", "/v2/account");
    const equity = Number(account.equity ?? 0);
    const daytrades = account.daytrade_count ?? 0;
    if (equity < 25_000 && daytrades >= 3) {
      throw new Error(
        `PDT koruması: hesap ${equity} USD < 25k ve gün-içi işlem sayısı ${daytrades} >= 3 — yeni emir gönderilmez`,
      );
    }
  }

  private async assertTradableAccount(): Promise<void> {
    const account = await this.request<AlpacaAccount>("GET", "/v2/account");
    if (account.account_blocked === true || account.trading_blocked === true) {
      throw new Error("Alpaca hesabı işlem için bloke — runtime durdurulmalı");
    }
  }

  private toOrder(o: AlpacaOrder, base?: Order): Order {
    const price = Number(o.limit_price ?? 0);
    return {
      clientOrderId: o.client_order_id ?? base?.clientOrderId ?? "",
      symbol: o.symbol ?? base?.symbol ?? "",
      side: ((o.side ?? "buy").toUpperCase() as OrderSide) ?? base?.side,
      quantity: Number(o.qty ?? base?.quantity ?? 0),
      ...(price > 0 ? { price } : {}),
      reduceOnly: base?.reduceOnly ?? false,
      state: mapAlpacaStatus(o.status ?? ""),
      filledQuantity: Number(o.filled_qty ?? 0),
    };
  }

  private async request<T>(method: string, path: string, body?: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "APCA-API-KEY-ID": this.options.apiKey,
          "APCA-API-SECRET-KEY": this.options.apiSecret,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body } : {}),
      });

      if (response.status === 429) {
        const retryAfterSec = Number(response.headers.get("Retry-After") ?? "");
        const backoff =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1_000
            : Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        this.options.logger.warn("alpaca rate limit — backoff uygulanıyor", {
          backoffMs: backoff,
          attempt,
          path,
        });
        if (attempt >= this.maxAttempts) {
          throw new AlpacaHttpError(429, "rate limit — deneme hakkı bitti", path);
        }
        await this.sleepFn(backoff);
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      let detail: string | undefined;
      try {
        const parsed = (await response.json()) as { message?: string };
        detail = parsed.message;
      } catch {
        // gövde JSON değilse durum kodu yeter
      }
      throw new AlpacaHttpError(response.status, detail, path);
    }
  }
}

/**
 * Anahtarları DOĞRUDAN environment'tan okur — Config nesnesine girmezler,
 * böylece yanlışlıkla loglanamazlar. Anahtar yoksa undefined döner.
 */
export function createAlpacaAdapterFromEnv(
  mode: Mode,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): AlpacaAdapter | undefined {
  const apiKey = env.ALPACA_API_KEY ?? env.APCA_API_KEY_ID;
  const apiSecret = env.ALPACA_API_SECRET ?? env.APCA_API_SECRET_KEY;
  if (apiKey === undefined || apiKey === "" || apiSecret === undefined || apiSecret === "") {
    return undefined;
  }
  return new AlpacaAdapter({
    mode,
    apiKey,
    apiSecret,
    logger,
    allowExtendedHours: parseBoolean(env.ALLOW_EXTENDED_HOURS),
  });
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function roundQuantity(quantity: number): number {
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

function roundEquityPrice(price: number): number {
  const decimals = price >= 1 ? 2 : 4;
  const factor = 10 ** decimals;
  return Math.round(price * factor) / factor;
}

function formatDecimal(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}
