/**
 * OMS — emir yaşam döngüsü. Emir bir durum makinesidir, "gönder ve unut"
 * değil.
 *
 * PENDING_NEW → NEW → PARTIALLY_FILLED → FILLED
 *                  ↘ REJECTED
 *                  ↘ CANCELED
 *                  ↘ EXPIRED
 *       ↘ UNKNOWN  (timeout — venue'ya sorulmalı, varsayılmamalı)
 */
export type OrderState =
  | "PENDING_NEW"
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELED"
  | "EXPIRED"
  | "UNKNOWN";

export type OrderSide = "BUY" | "SELL";

export interface Order {
  /** İstemci tarafında üretilmiş — idempotency anahtarı. Retry aynı ID ile gider. */
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly price?: number;
  /** Yanlışlıkla ters pozisyon açmayı önler; kill switch altında geçebilen tek emir türü. */
  readonly reduceOnly: boolean;
  readonly state: OrderState;
  readonly filledQuantity: number;
}

/** Geçerli durum geçişleri. Bunun dışındaki her geçiş hatadır. */
const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  PENDING_NEW: ["NEW", "REJECTED", "UNKNOWN"],
  NEW: ["PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELED", "EXPIRED", "UNKNOWN"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "UNKNOWN"],
  FILLED: [],
  REJECTED: [],
  CANCELED: [],
  EXPIRED: [],
  // UNKNOWN'dan çıkış yalnızca venue'ya sorarak olur — her duruma dönebilir.
  // Venue emri hiç tanımıyorsa AYNI clientOrderId ile yeniden gönderim için
  // PENDING_NEW'e döner (idempotent retry).
  UNKNOWN: ["PENDING_NEW", "NEW", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELED", "EXPIRED"],
};

export function isTerminal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(order: Order, to: OrderState): Order {
  if (!canTransition(order.state, to)) {
    throw new Error(
      `Geçersiz emir durum geçişi: ${order.state} → ${to} (clientOrderId=${order.clientOrderId})`,
    );
  }
  return { ...order, state: to };
}
