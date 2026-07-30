import type { Mode } from "../../config/mode.js";
import type { Logger } from "../../monitoring/logger.js";
import type { Order, OrderSide, OrderState } from "../../oms/order.js";
import { StateStore } from "../../state/state-store.js";
import {
  normalizeSymbol,
  type SymbolSpec,
  symbolSpecForVenueSymbol,
} from "../asset-class.js";
import type {
  VenueAdapter,
  VenueBalance,
  VenuePosition,
  VenuePriceTick,
  VenueStatus,
} from "../venue-adapter.js";

export function igRestBase(mode: Mode): string {
  return mode === "LIVE"
    ? "https://api.ig.com/gateway/deal"
    : "https://demo-api.ig.com/gateway/deal";
}

export type IgFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface IgAdapterOptions {
  readonly mode: Mode;
  readonly apiKey: string;
  readonly username: string;
  readonly password: string;
  readonly accountId: string;
  readonly logger: Logger;
  readonly fetchFn?: IgFetchLike;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly stateStore?: StateStore;
}

interface IgSession {
  readonly cst: string;
  readonly securityToken: string;
}

interface IgAccountsResponse {
  accounts?: Array<{
    accountId?: string;
    accountName?: string;
    currency?: string;
    balance?: {
      balance?: number;
      available?: number;
      deposit?: number;
      profitLoss?: number;
    };
  }>;
}

interface IgMarketResponse {
  snapshot?: {
    bid?: number;
    offer?: number;
    updateTime?: string;
    marketStatus?: string;
  };
}

interface IgConfirmResponse {
  dealId?: string;
  dealReference?: string;
  dealStatus?: string;
  status?: string;
  direction?: string;
  epic?: string;
  size?: number;
  level?: number;
  reason?: string;
  reasonCode?: string;
  affectedDeals?: Array<{
    dealId?: string;
    status?: string;
    level?: number;
  }>;
}

interface IgPositionsResponse {
  positions?: Array<{
    position?: {
      direction?: string;
      size?: number;
      level?: number;
      dealId?: string;
    };
    market?: {
      epic?: string;
    };
  }>;
}

interface IgWorkingOrdersResponse {
  workingOrders?: Array<{
    epic?: string;
    direction?: string;
    size?: number;
    level?: number;
    dealReference?: string;
  }>;
}

type DealReferenceMap = Record<string, string>;

const DEAL_REFERENCE_KEY = "ig-deal-references";

/** IG durumları → OMS durum makinesi. Bilinmeyen her şey UNKNOWN. */
export function mapIgStatus(status: string): OrderState {
  switch (status) {
    case "ACCEPTED":
    case "OPEN":
    case "CLOSED":
    case "AMENDED":
      return "FILLED";
    case "PARTIALLY_CLOSED":
      return "PARTIALLY_FILLED";
    case "DELETED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

class IgHttpError extends Error {
  constructor(
    readonly status: number,
    readonly igErrorCode: string | undefined,
    path: string,
  ) {
    super(`IG ${status} ${path}${igErrorCode !== undefined ? ` code=${igErrorCode}` : ""}`);
  }
}

export class IgAdapter implements VenueAdapter {
  readonly name = "ig";

  private readonly baseUrl: string;
  private readonly fetchFn: IgFetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly stateStore: StateStore;
  private session: IgSession | undefined;

  constructor(private readonly options: IgAdapterOptions) {
    if (
      options.apiKey === "" ||
      options.username === "" ||
      options.password === "" ||
      options.accountId === ""
    ) {
      throw new Error("IG kimlik bilgileri boş olamaz");
    }
    this.baseUrl = igRestBase(options.mode);
    this.fetchFn = options.fetchFn ?? (fetch as unknown as IgFetchLike);
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.stateStore = options.stateStore ?? new StateStore("state");
  }

  async connect(): Promise<void> {
    await this.authenticate();
    await this.fetchVenueStatus([]);
    this.options.logger.info("ig bağlantısı doğrulandı", {
      venue: this.name,
      baseUrl: this.baseUrl,
      accountId: this.options.accountId,
    });
  }

  async fetchServerTime(): Promise<number> {
    const response = await this.requestRaw("GET", "/accounts", "1");
    const header = response.headers.get("Date");
    const parsed = header === null ? Number.NaN : Date.parse(header);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  async fetchPositions(): Promise<readonly VenuePosition[]> {
    const response = await this.request<IgPositionsResponse>("GET", "/positions", undefined, "2");
    return (response.positions ?? [])
      .map((position) => {
        const epic = position.market?.epic ?? "";
        const symbol = symbolFromEpic(epic);
        const direction = position.position?.direction === "SELL" ? -1 : 1;
        const size = Number(position.position?.size ?? 0);
        return {
          symbol,
          quantity: direction * size,
          avgPrice: Number(position.position?.level ?? 0),
          assetClass: "forex" as const,
        };
      })
      .filter((position) => position.quantity !== 0);
  }

  async fetchBalances(): Promise<readonly VenueBalance[]> {
    const account = await this.fetchAccount();
    const currency = account.currency ?? "USD";
    const balance = Number(account.balance?.balance ?? 0);
    const available = Number(account.balance?.available ?? balance);
    const locked = Math.max(0, balance - available);
    return balance !== 0 ? [{ asset: currency, free: available, locked }] : [];
  }

  async fetchOpenOrders(): Promise<readonly Order[]> {
    try {
      const response = await this.request<IgWorkingOrdersResponse>(
        "GET",
        "/workingorders",
        undefined,
        "2",
      );
      return (response.workingOrders ?? []).map((workingOrder) => {
        const symbol = normalizeSymbol(symbolFromEpic(workingOrder.epic ?? ""), "forex");
        const dealReference = workingOrder.dealReference;
        const clientOrderId =
          dealReference === undefined
            ? ""
            : this.clientOrderIdForDealReference(dealReference) ?? dealReference;
        return {
          clientOrderId,
          symbol,
          side: (workingOrder.direction as OrderSide) ?? "BUY",
          quantity: Number(workingOrder.size ?? 0),
          ...(Number(workingOrder.level ?? 0) > 0
            ? { price: Number(workingOrder.level) }
            : {}),
          reduceOnly: false,
          state: "NEW",
          filledQuantity: 0,
        };
      });
    } catch (err) {
      if (err instanceof IgHttpError && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  async submitOrder(order: Order): Promise<Order> {
    this.assertOrderingAllowed("emir gönderimi");
    await this.assertMarketOpen(order.symbol);

    const spec = symbolSpecForVenueSymbol(order.symbol, "ig");
    const payload: Record<string, unknown> = {
      epic: epicForSymbol(spec),
      expiry: "-",
      direction: order.side,
      size: order.quantity,
      orderType: order.price !== undefined ? "LIMIT" : "MARKET",
      currencyCode: "USD",
      forceOpen: !order.reduceOnly,
    };
    if (order.price !== undefined) {
      payload.level = order.price;
      payload.timeInForce = "GOOD_TILL_CANCELLED";
    }

    const opened = await this.request<{ dealReference?: string }>(
      "POST",
      "/positions/otc",
      payload,
      "2",
    );
    const dealReference = opened.dealReference;
    if (dealReference === undefined || dealReference === "") {
      throw new Error("IG emir cevabı dealReference içermiyor");
    }
    this.saveDealReference(order.clientOrderId, dealReference);
    const confirm = await this.request<IgConfirmResponse>(
      "GET",
      `/confirms/${encodeURIComponent(dealReference)}`,
      undefined,
      "1",
    );
    return this.toOrder(order.clientOrderId, spec, confirm, order);
  }

  async queryOrder(clientOrderId: string, symbol: string): Promise<Order | undefined> {
    const dealReference = this.loadDealReferences()[clientOrderId];
    if (dealReference === undefined) return undefined;
    try {
      const confirm = await this.request<IgConfirmResponse>(
        "GET",
        `/confirms/${encodeURIComponent(dealReference)}`,
        undefined,
        "1",
      );
      return this.toOrder(clientOrderId, symbolSpecForVenueSymbol(symbol, "ig"), confirm);
    } catch (err) {
      if (err instanceof IgHttpError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  async cancelOrder(clientOrderId: string, symbol: string): Promise<void> {
    this.assertOrderingAllowed("emir iptali");
    const dealReference = this.loadDealReferences()[clientOrderId];
    if (dealReference === undefined) {
      throw new Error("iptal edilecek IG emri için dealReference bulunamadı");
    }
    const confirm = await this.request<IgConfirmResponse>(
      "GET",
      `/confirms/${encodeURIComponent(dealReference)}`,
      undefined,
      "1",
    );
    if (confirm.dealId === undefined) {
      throw new Error("iptal edilecek IG emri için dealId bulunamadı");
    }
    await this.request(
      "DELETE",
      "/workingorders/otc",
      {
        dealId: confirm.dealId,
        epic: epicForSymbol(symbolSpecForVenueSymbol(symbol, "ig")),
      },
      "2",
    );
  }

  async fetchLatestPrices(symbols: readonly string[]): Promise<readonly VenuePriceTick[]> {
    const ticks = await Promise.all(
      symbols.map(async (symbol) => {
        const spec = symbolSpecForVenueSymbol(symbol, "ig");
        const response = await this.request<IgMarketResponse>(
          "GET",
          `/markets/${encodeURIComponent(epicForSymbol(spec))}`,
          undefined,
          "3",
        );
        const bid = Number(response.snapshot?.bid ?? 0);
        const offer = Number(response.snapshot?.offer ?? 0);
        const price = (bid + offer) / 2;
        return {
          symbol: spec.symbol,
          price,
          at: Date.now(),
          marketOpen: isIgMarketTradeable(response.snapshot?.marketStatus),
        };
      }),
    );
    return ticks.filter((tick) => Number.isFinite(tick.price) && tick.price > 0);
  }

  async fetchVenueStatus(symbols: readonly string[]): Promise<VenueStatus> {
    const account = await this.fetchAccount();
    const balance = Number(account.balance?.balance ?? 0);
    const usedMargin = Number(account.balance?.deposit ?? 0);
    const marketOpen =
      symbols.length === 0
        ? undefined
        : (await this.fetchLatestPrices([symbols[0]!]))[0]?.marketOpen;
    return {
      swapCost: 0,
      ...(marketOpen !== undefined ? { marketOpen } : {}),
      ...(balance > 0 ? { marginUsage: usedMargin / balance } : {}),
      ...(usedMargin > 0 ? { marginLevel: (balance / usedMargin) * 100 } : {}),
    };
  }

  private async authenticate(): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/session`, {
      method: "POST",
      headers: {
        "X-IG-API-KEY": this.options.apiKey,
        Version: "2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identifier: this.options.username,
        password: this.options.password,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      const code = await readIgErrorCode(response);
      throw new IgHttpError(response.status, code, "/session");
    }
    const cst = response.headers.get("CST");
    const securityToken = response.headers.get("X-SECURITY-TOKEN");
    if (cst === null || securityToken === null) {
      throw new Error("IG oturumu CST/X-SECURITY-TOKEN başlıklarını döndürmedi");
    }
    this.session = { cst, securityToken };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    version: string = "2",
  ): Promise<T> {
    const response = await this.requestRaw(method, path, version, body);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestRaw(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    version: string,
    body?: Record<string, unknown>,
    reauthenticated: boolean = false,
  ): Promise<Awaited<ReturnType<IgFetchLike>>> {
    if (this.session === undefined) {
      await this.authenticate();
    }
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        "X-IG-API-KEY": this.options.apiKey,
        Version: version,
        CST: this.session!.cst,
        "X-SECURITY-TOKEN": this.session!.securityToken,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const actualMethod = method === "DELETE" ? "POST" : method;
      if (method === "DELETE") headers._method = "DELETE";
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: actualMethod,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 429) {
        const retryAfterSec = Number(response.headers.get("Retry-After") ?? "");
        const backoff =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1_000
            : Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        this.options.logger.warn("ig rate limit — backoff uygulanıyor", {
          attempt,
          backoffMs: backoff,
          path,
        });
        if (attempt >= this.maxAttempts) {
          throw new IgHttpError(429, "rate_limit", path);
        }
        await this.sleepFn(backoff);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return response;
      }
      const code = await readIgErrorCode(response);
      if (
        !reauthenticated &&
        (response.status === 401 || code === "error.security.client-token-invalid")
      ) {
        this.session = undefined;
        await this.authenticate();
        return this.requestRaw(method, path, version, body, true);
      }
      throw new IgHttpError(response.status, code, path);
    }
  }

  private async fetchAccount(): Promise<NonNullable<IgAccountsResponse["accounts"]>[number]> {
    const response = await this.request<IgAccountsResponse>("GET", "/accounts", undefined, "1");
    const account =
      response.accounts?.find((item) => item.accountId === this.options.accountId) ??
      response.accounts?.[0];
    if (account === undefined) {
      throw new Error("IG hesap bilgisi alınamadı");
    }
    return account;
  }

  private async assertMarketOpen(symbol: string): Promise<void> {
    const ticks = await this.fetchLatestPrices([symbol]);
    if (ticks[0]?.marketOpen === false) {
      throw new Error("forex piyasası kapalı — hafta sonu yeni emir gönderilmez");
    }
  }

  private assertOrderingAllowed(action: string): void {
    if (this.options.mode === "DRY_RUN") {
      throw new Error(`DRY_RUN modunda ${action} venue'ya gitmez (adaptör seviyesi koruma)`);
    }
  }

  private toOrder(
    clientOrderId: string,
    spec: SymbolSpec,
    confirm: IgConfirmResponse,
    base?: Order,
  ): Order {
    const status = confirm.status ?? confirm.dealStatus ?? confirm.affectedDeals?.[0]?.status ?? "";
    const level = Number(confirm.level ?? confirm.affectedDeals?.[0]?.level ?? base?.price ?? 0);
    return {
      clientOrderId,
      symbol: spec.symbol,
      side: ((confirm.direction ?? base?.side ?? "BUY") as OrderSide) ?? "BUY",
      quantity: Number(confirm.size ?? base?.quantity ?? 0),
      ...(level > 0 ? { price: level } : {}),
      reduceOnly: base?.reduceOnly ?? false,
      state: mapIgStatus(status),
      filledQuantity:
        mapIgStatus(status) === "REJECTED" || mapIgStatus(status) === "CANCELED"
          ? 0
          : Number(confirm.size ?? base?.quantity ?? 0),
    };
  }

  private loadDealReferences(): DealReferenceMap {
    return this.stateStore.load<DealReferenceMap>(DEAL_REFERENCE_KEY) ?? {};
  }

  private saveDealReference(clientOrderId: string, dealReference: string): void {
    this.stateStore.save(DEAL_REFERENCE_KEY, {
      ...this.loadDealReferences(),
      [clientOrderId]: dealReference,
    });
  }

  private clientOrderIdForDealReference(dealReference: string): string | undefined {
    return Object.entries(this.loadDealReferences()).find(([, value]) => value === dealReference)?.[0];
  }
}

export function createIgAdapterFromEnv(
  mode: Mode,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): IgAdapter | undefined {
  const apiKey = env.IG_API_KEY;
  const username = env.IG_USERNAME;
  const password = env.IG_PASSWORD;
  const accountId = env.IG_ACCOUNT_ID;
  if (
    apiKey === undefined ||
    apiKey === "" ||
    username === undefined ||
    username === "" ||
    password === undefined ||
    password === "" ||
    accountId === undefined ||
    accountId === ""
  ) {
    return undefined;
  }
  return new IgAdapter({
    mode,
    apiKey,
    username,
    password,
    accountId,
    logger,
    stateStore: new StateStore(env.STATE_DIR ?? "state"),
  });
}

async function readIgErrorCode(
  response: Awaited<ReturnType<IgFetchLike>>,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { errorCode?: string };
    return body.errorCode;
  } catch {
    return undefined;
  }
}

function epicForSymbol(spec: SymbolSpec): string {
  return `CS.D.${spec.symbol}.CFD.IP`;
}

function symbolFromEpic(epic: string): string {
  const match = epic.match(/\.([A-Z]{6})\./);
  return normalizeSymbol(match?.[1] ?? epic, "forex");
}

function isIgMarketTradeable(status: string | undefined): boolean {
  return status === undefined ? true : status === "TRADEABLE";
}
