import type { Mode } from "../config/mode.js";
import type { AlertManager } from "../monitoring/alerts.js";
import type { Logger } from "../monitoring/logger.js";
import type { RiskContext, RiskDecision } from "../risk/risk-gate.js";
import { checkOrder } from "../risk/risk-gate.js";
import type { StateStore } from "../state/state-store.js";
import type { VenueAdapter } from "../venues/venue-adapter.js";
import { AuditLog } from "./audit-log.js";
import { newClientOrderId } from "./client-order-id.js";
import {
  canTransition,
  isTerminal,
  transition,
  type Order,
  type OrderSide,
  type OrderState,
} from "./order.js";

/** Strateji/operatörden gelen emir niyeti. clientOrderId verilirse retry aynı ID ile gider. */
export interface OrderIntent {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly price?: number;
  readonly reduceOnly?: boolean;
  readonly clientOrderId?: string;
}

export type PlaceResult =
  | { readonly accepted: true; readonly order: Order }
  | { readonly accepted: false; readonly reason: string; readonly order?: Order };

/**
 * Kısmi dolum kararı AÇIKÇA yazılır, sessizce yutulmaz:
 * - CANCEL_REMAINDER: dolum süresi aşıldığında kalan miktar iptal edilir.
 * - KEEP_WORKING: emir çalışmaya devam eder (karar loglanır).
 */
export type PartialFillPolicy = "CANCEL_REMAINDER" | "KEEP_WORKING";

interface BookEntry {
  order: Order;
  readonly createdAt: number;
  updatedAt: number;
  submitAttempts: number;
}

export interface OmsOptions {
  readonly mode: Mode;
  /** DRY_RUN'da adaptör gerekmez — emirler üretilir ve loglanır ama GÖNDERİLMEZ. */
  readonly adapter?: VenueAdapter | undefined;
  readonly store: StateStore;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly alerts: AlertManager;
  /** Risk kapısı bağlamı — her emir gönderilmeden önce buradan geçer, atlanamaz. */
  readonly riskContext: (order: Order) => RiskContext;
  /** Fill gerçekleştiğinde çağrılır (risk tracker beslemesi). */
  readonly onFill?: (order: Order, fillQuantity: number, price: number) => void;
  readonly orderTimeoutMs?: number;
  readonly partialFillTimeoutMs?: number;
  readonly partialFillPolicy?: PartialFillPolicy;
  readonly maxSubmitAttempts?: number;
  readonly now?: () => number;
}

const BOOK_KEY = "oms-orders";

/**
 * OMS — emir yaşam döngüsü yöneticisi. Emir bir durum makinesidir,
 * "gönder ve unut" değil:
 * - Her emir gönderilmeden ÖNCE loglanır (audit), sonra değil.
 * - Timeout → UNKNOWN → venue'ya clientOrderId ile SORULUR, asla varsayılmaz.
 * - Retry AYNI clientOrderId ile gider — çift emri önleyen şey budur.
 * - Venue reddi → REJECTED, sonsuz retry YOK.
 * - Kısmi dolum açıkça ele alınır (politika + audit), sessizce yutulmaz.
 * - DRY_RUN: emir üretilir ve loglanır ama venue'ya gitmez.
 */
export class Oms {
  private readonly book = new Map<string, BookEntry>();
  private readonly orderTimeoutMs: number;
  private readonly partialFillTimeoutMs: number;
  private readonly partialFillPolicy: PartialFillPolicy;
  private readonly maxSubmitAttempts: number;
  private readonly now: () => number;

  constructor(private readonly opts: OmsOptions) {
    if (opts.mode !== "DRY_RUN" && opts.adapter === undefined) {
      throw new Error(`${opts.mode} modunda venue adaptörü zorunlu`);
    }
    this.orderTimeoutMs = opts.orderTimeoutMs ?? 5_000;
    this.partialFillTimeoutMs = opts.partialFillTimeoutMs ?? 30_000;
    this.partialFillPolicy = opts.partialFillPolicy ?? "CANCEL_REMAINDER";
    this.maxSubmitAttempts = opts.maxSubmitAttempts ?? 3;
    this.now = opts.now ?? Date.now;
    this.loadBook();
  }

  /**
   * Restart kurtarma. ASLA "düz pozisyondayım" varsayma:
   * terminal olmayan her emir venue'ya clientOrderId ile sorulur.
   * Venue tanıyorsa durumu benimsenir (yeniden GÖNDERİLMEZ → çift emir yok);
   * venue hiç almadıysa REJECTED işaretlenir — strateji yeniden karar verir.
   */
  async recover(): Promise<void> {
    for (const entry of this.book.values()) {
      if (isTerminal(entry.order.state)) continue;
      this.opts.audit.record("oms_recover_inflight", {
        clientOrderId: entry.order.clientOrderId,
        state: entry.order.state,
      });
      if (this.opts.adapter === undefined || this.opts.mode === "DRY_RUN") {
        // DRY_RUN emri venue'da olamaz — güvenle kapat.
        this.applyState(entry, "REJECTED", "restart: DRY_RUN emri kurtarılmaz");
        continue;
      }
      const venueOrder = await this.opts.adapter.queryOrder(
        entry.order.clientOrderId,
        entry.order.symbol,
      );
      if (venueOrder === undefined) {
        this.applyState(entry, "REJECTED", "restart: emir venue'ya hiç ulaşmamış");
      } else {
        this.adoptVenueOrder(entry, venueOrder, "restart: venue durumu benimsendi");
      }
    }
    this.saveBook();
  }

  /** Emir yerleştir. Risk kapısı stratejiyi EZER — önce o karar verir. */
  async place(intent: OrderIntent): Promise<PlaceResult> {
    const order: Order = {
      clientOrderId: intent.clientOrderId ?? newClientOrderId(),
      symbol: intent.symbol,
      side: intent.side,
      quantity: intent.quantity,
      ...(intent.price !== undefined ? { price: intent.price } : {}),
      reduceOnly: intent.reduceOnly ?? false,
      state: "PENDING_NEW",
      filledQuantity: 0,
    };

    // Idempotency: aynı clientOrderId ikinci kez yerleştirilemez.
    const existing = this.book.get(order.clientOrderId);
    if (existing !== undefined) {
      this.opts.logger.warn("aynı clientOrderId ile tekrar yerleştirme — mevcut emir döndü", {
        clientOrderId: order.clientOrderId,
        state: existing.order.state,
      });
      return { accepted: true, order: existing.order };
    }

    const decision: RiskDecision = checkOrder(order, this.opts.riskContext(order));
    if (!decision.allowed) {
      this.opts.audit.record("order_risk_denied", {
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        reason: decision.reason,
      });
      this.opts.logger.warn("risk kapısı emri reddetti", {
        clientOrderId: order.clientOrderId,
        reason: decision.reason,
      });
      return { accepted: false, reason: decision.reason };
    }

    // Emir GÖNDERİLMEDEN ÖNCE kalıcı olarak loglanır.
    const entry: BookEntry = {
      order,
      createdAt: this.now(),
      updatedAt: this.now(),
      submitAttempts: 0,
    };
    this.book.set(order.clientOrderId, entry);
    this.opts.audit.record("order_created", {
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: order.price ?? null,
      reduceOnly: order.reduceOnly,
    });
    this.saveBook();

    if (this.opts.mode === "DRY_RUN") {
      // Faz 2 sözleşmesi: emir üretilir ve loglanır ama GÖNDERİLMEZ.
      this.applyState(entry, "NEW", "DRY_RUN: emir üretildi, venue'ya gönderilmedi");
      this.saveBook();
      return { accepted: true, order: entry.order };
    }

    return this.submitWithRetry(entry);
  }

  /** UNKNOWN durumdaki emirleri venue'ya sorarak çöz (reconcile kuyruğu). */
  async resolveUnknownOrders(): Promise<void> {
    if (this.opts.adapter === undefined || this.opts.mode === "DRY_RUN") return;
    for (const entry of this.book.values()) {
      if (entry.order.state !== "UNKNOWN") continue;
      const venueOrder = await this.opts.adapter.queryOrder(
        entry.order.clientOrderId,
        entry.order.symbol,
      );
      if (venueOrder === undefined) {
        this.applyState(entry, "REJECTED", "UNKNOWN çözümü: emir venue'ya hiç ulaşmamış");
      } else {
        this.adoptVenueOrder(entry, venueOrder, "UNKNOWN çözümü: venue durumu benimsendi");
      }
    }
    this.saveBook();
  }

  /** Açık emirleri venue ile senkronla — fill'ler burada yakalanır. */
  async syncOpenOrders(): Promise<void> {
    if (this.opts.adapter === undefined || this.opts.mode === "DRY_RUN") return;
    for (const entry of this.book.values()) {
      if (isTerminal(entry.order.state) || entry.order.state === "PENDING_NEW") continue;
      const venueOrder = await this.opts.adapter.queryOrder(
        entry.order.clientOrderId,
        entry.order.symbol,
      );
      if (venueOrder !== undefined) {
        this.adoptVenueOrder(entry, venueOrder, "periyodik emir senkronu");
      }
    }
    this.saveBook();
  }

  /**
   * Kısmi dolum kontrolü: dolum süresi aşılan PARTIALLY_FILLED emirlerde
   * kalan miktar politikaya göre AÇIKÇA ele alınır.
   */
  async checkPartialFills(): Promise<void> {
    for (const entry of this.book.values()) {
      if (entry.order.state !== "PARTIALLY_FILLED") continue;
      if (this.now() - entry.updatedAt < this.partialFillTimeoutMs) continue;

      const remaining = entry.order.quantity - entry.order.filledQuantity;
      this.opts.audit.record("partial_fill_decision", {
        clientOrderId: entry.order.clientOrderId,
        filled: entry.order.filledQuantity,
        remaining,
        policy: this.partialFillPolicy,
      });

      if (this.partialFillPolicy === "KEEP_WORKING") {
        this.opts.logger.info("kısmi dolum: emir çalışmaya devam ediyor (politika KEEP_WORKING)", {
          clientOrderId: entry.order.clientOrderId,
          remaining,
        });
        entry.updatedAt = this.now(); // karar verildi — sayaç yeniden başlar
        continue;
      }

      // CANCEL_REMAINDER: kalan iptal edilir (DRY_RUN'da yalnızca lokal).
      if (this.opts.adapter !== undefined && this.opts.mode !== "DRY_RUN") {
        await this.opts.adapter.cancelOrder(entry.order.clientOrderId, entry.order.symbol);
      }
      this.applyState(
        entry,
        "CANCELED",
        `kısmi dolum: kalan ${remaining} iptal edildi (politika CANCEL_REMAINDER)`,
      );
    }
    this.saveBook();
  }

  /** Emir iptali — DRY_RUN'da lokal, diğer modlarda venue üzerinden. */
  async cancel(clientOrderId: string): Promise<void> {
    const entry = this.book.get(clientOrderId);
    if (entry === undefined || isTerminal(entry.order.state)) return;
    if (this.opts.adapter !== undefined && this.opts.mode !== "DRY_RUN") {
      await this.opts.adapter.cancelOrder(clientOrderId, entry.order.symbol);
    }
    this.applyState(entry, "CANCELED", "operatör/strateji iptali");
    this.saveBook();
  }

  order(clientOrderId: string): Order | undefined {
    return this.book.get(clientOrderId)?.order;
  }

  openOrders(): readonly Order[] {
    return [...this.book.values()]
      .filter((e) => !isTerminal(e.order.state))
      .map((e) => e.order);
  }

  allOrders(): readonly Order[] {
    return [...this.book.values()].map((e) => e.order);
  }

  /** Gönderim: timeout → UNKNOWN → venue'ya sor → gerekirse AYNI ID ile retry. */
  private async submitWithRetry(entry: BookEntry): Promise<PlaceResult> {
    const adapter = this.opts.adapter;
    if (adapter === undefined) throw new Error("adaptör yok"); // constructor garantiler
    for (;;) {
      entry.submitAttempts += 1;
      this.opts.audit.record("order_submit_attempt", {
        clientOrderId: entry.order.clientOrderId,
        attempt: entry.submitAttempts,
      });
      this.saveBook();

      let venueOrder: Order;
      try {
        venueOrder = await this.withTimeout(adapter.submitOrder(entry.order));
      } catch (err) {
        if (err instanceof OrderTimeoutError) {
          // Emir gitti mi bilmiyoruz — UNKNOWN, venue'ya SOR, varsayma.
          this.applyState(entry, "UNKNOWN", "gönderim timeout — venue'ya sorulacak");
          this.saveBook();
          const resolved = await this.resolveAfterTimeout(entry);
          if (resolved !== "retry") return resolved;
          if (entry.submitAttempts >= this.maxSubmitAttempts) {
            return this.giveUpUnknown(entry, "deneme hakkı bitti — emir venue'ya ulaşmamış");
          }
          continue; // AYNI clientOrderId ile retry — idempotent
        }
        // Venue reddi (iş kuralı/HTTP hatası): REJECTED, sonsuz retry YOK.
        this.applyState(entry, "REJECTED", `venue reddi: ${trimReason(err)}`);
        this.saveBook();
        return { accepted: false, reason: trimReason(err), order: entry.order };
      }

      this.adoptVenueOrder(entry, venueOrder, "venue gönderim cevabı");
      this.saveBook();
      if (entry.order.state === "REJECTED") {
        return { accepted: false, reason: "venue emri reddetti", order: entry.order };
      }
      return { accepted: true, order: entry.order };
    }
  }

  /** Timeout sonrası: venue'ya sor. Emir yoksa "retry" döner (aynı ID ile). */
  private async resolveAfterTimeout(entry: BookEntry): Promise<PlaceResult | "retry"> {
    const adapter = this.opts.adapter;
    if (adapter === undefined) throw new Error("adaptör yok");
    let venueOrder: Order | undefined;
    try {
      venueOrder = await adapter.queryOrder(entry.order.clientOrderId, entry.order.symbol);
    } catch (err) {
      // Sorgu da başarısız — UNKNOWN kalır, reconcile kuyruğu çözer.
      return this.giveUpUnknown(entry, `venue sorgusu başarısız: ${trimReason(err)}`);
    }
    if (venueOrder === undefined) return "retry"; // venue hiç almamış — güvenli retry
    this.adoptVenueOrder(entry, venueOrder, "timeout sonrası venue sorgusu");
    this.saveBook();
    if (entry.order.state === "REJECTED") {
      return { accepted: false, reason: "venue emri reddetti", order: entry.order };
    }
    return { accepted: true, order: entry.order };
  }

  private giveUpUnknown(entry: BookEntry, reason: string): PlaceResult {
    this.opts.alerts.raise("order_unknown", "emir UNKNOWN durumda — reconcile kuyruğunda", {
      clientOrderId: entry.order.clientOrderId,
      reason,
    });
    this.saveBook();
    return { accepted: false, reason, order: entry.order };
  }

  /** Venue cevabını benimse: durum + fill delta (fill'ler onFill'e akar). */
  private adoptVenueOrder(entry: BookEntry, venueOrder: Order, note: string): void {
    const before = entry.order;
    const fillDelta = venueOrder.filledQuantity - before.filledQuantity;

    let updated: Order = { ...before, filledQuantity: venueOrder.filledQuantity };
    // Venue tek doğru kaynak: hedefe durum makinesi yolu üzerinden gidilir
    // (ör. market emri PENDING_NEW → NEW → FILLED atlamalı gelebilir).
    for (const step of statePath(before.state, venueOrder.state)) {
      updated = transition(updated, step);
    }
    entry.order = updated;
    entry.updatedAt = this.now();

    this.opts.audit.record("order_state", {
      clientOrderId: entry.order.clientOrderId,
      from: before.state,
      to: entry.order.state,
      filledQuantity: entry.order.filledQuantity,
      note,
    });

    if (fillDelta > 0) {
      const price = venueOrder.price ?? before.price ?? 0;
      this.opts.audit.record("order_fill", {
        clientOrderId: entry.order.clientOrderId,
        fillQuantity: fillDelta,
        price,
      });
      this.opts.onFill?.(entry.order, fillDelta, price);
    }
  }

  private applyState(entry: BookEntry, to: OrderState, note: string): void {
    const from = entry.order.state;
    entry.order = transition(entry.order, to);
    entry.updatedAt = this.now();
    this.opts.audit.record("order_state", {
      clientOrderId: entry.order.clientOrderId,
      from,
      to,
      filledQuantity: entry.order.filledQuantity,
      note,
    });
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new OrderTimeoutError(this.orderTimeoutMs)),
        this.orderTimeoutMs,
      );
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private loadBook(): void {
    const persisted = this.opts.store.load<Record<string, BookEntry>>(BOOK_KEY);
    if (persisted === undefined) return;
    for (const [id, entry] of Object.entries(persisted)) {
      this.book.set(id, entry);
    }
  }

  private saveBook(): void {
    this.opts.store.save(BOOK_KEY, Object.fromEntries(this.book));
  }
}

class OrderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`emir gönderimi ${timeoutMs}ms içinde cevaplanmadı`);
  }
}

/**
 * Venue'nun bildirdiği hedefe geçerli durum makinesi yolu. Doğrudan geçiş
 * yoksa PENDING_NEW → NEW ara adımı denenir (market emri anında dolabilir).
 */
function statePath(from: OrderState, to: OrderState): readonly OrderState[] {
  if (from === to) return [];
  if (canTransition(from, to)) return [to];
  if (from === "PENDING_NEW" && canTransition("NEW", to)) return ["NEW", to];
  // Son çare: venue tek doğru kaynak — UNKNOWN üzerinden her duruma dönülür.
  if (canTransition(from, "UNKNOWN") && canTransition("UNKNOWN", to)) return ["UNKNOWN", to];
  throw new Error(`Venue durumu benimsenemedi: ${from} → ${to}`);
}

function trimReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
