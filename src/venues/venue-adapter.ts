import type { Order } from "../oms/order.js";

/** Venue tarafından raporlanan pozisyon. */
export interface VenuePosition {
  readonly symbol: string;
  readonly quantity: number;
}

export interface VenueBalance {
  readonly asset: string;
  readonly free: number;
  readonly locked: number;
}

/**
 * Ortak venue arayüzü. Soyutlama emir semantiğini GİZLEMEZ:
 * POST_ONLY, REDUCE_ONLY, IOC/FOK, minimum notional, tick/lot kuantizasyonu
 * adaptör implementasyonlarında açıkça ele alınır.
 *
 * API anahtarı kuralları (adaptör implementasyonları için zorunlu):
 * - Yalnızca işlem izni; çekim izni tespit edilirse başlatma REDDEDİLİR.
 * - Anahtarlar environment'tan okunur; asla loglanmaz.
 */
export interface VenueAdapter {
  readonly name: string;

  /** Bağlan ve anahtar izinlerini doğrula (çekim izni varsa hata fırlat). */
  connect(): Promise<void>;

  /** Rekonsiliasyon için tek doğru kaynak: venue'daki gerçek durum. */
  fetchPositions(): Promise<readonly VenuePosition[]>;
  fetchOpenOrders(): Promise<readonly Order[]>;
  fetchBalances(): Promise<readonly VenueBalance[]>;

  /** clientOrderId ile idempotent emir gönderimi. */
  submitOrder(order: Order): Promise<Order>;

  /** Timeout sonrası UNKNOWN emri venue'ya sor — asla varsayma. */
  queryOrder(clientOrderId: string): Promise<Order | undefined>;

  cancelOrder(clientOrderId: string): Promise<void>;

  /** Saat kayması kontrolü için venue sunucu zamanı (epoch ms). */
  fetchServerTime(): Promise<number>;
}
