import type { Order } from "../oms/order.js";
import type { AssetClass } from "./asset-class.js";

/** Venue tarafından raporlanan pozisyon. */
export interface VenuePosition {
  readonly symbol: string;
  readonly quantity: number;
  readonly avgPrice?: number;
  readonly assetClass?: AssetClass;
  readonly carryCost?: number;
}

export interface VenueBalance {
  readonly asset: string;
  readonly free: number;
  readonly locked: number;
}

export interface VenuePriceTick {
  readonly symbol: string;
  readonly price: number;
  readonly at: number;
  readonly marketOpen?: boolean;
}

export interface VenueStatus {
  readonly marketOpen?: boolean;
  readonly marginUsage?: number;
  readonly marginLevel?: number;
  readonly swapCost?: number;
  readonly accountBlocked?: boolean;
  readonly tradingBlocked?: boolean;
  readonly dayTradeCount?: number;
  readonly patternDayTrader?: boolean;
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
  queryOrder(clientOrderId: string, symbol: string): Promise<Order | undefined>;

  cancelOrder(clientOrderId: string, symbol: string): Promise<void>;

  /** Saat kayması kontrolü için venue sunucu zamanı (epoch ms). */
  fetchServerTime(): Promise<number>;

  /** REST polling ile fiyat almak isteyen venue'lar bunu uygular. */
  fetchLatestPrices?(symbols: readonly string[]): Promise<readonly VenuePriceTick[]>;

  /** /status ve runtime korumaları için venue'ya özgü görünürlük alanları. */
  fetchVenueStatus?(symbols: readonly string[]): Promise<VenueStatus>;
}
