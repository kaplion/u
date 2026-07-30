import type { Mode } from "../../config/mode.js";
import type { Order } from "../../oms/order.js";
import type { VenueAdapter, VenueBalance, VenuePosition } from "../venue-adapter.js";

/**
 * Simülasyon adaptörü — yalnızca DRY_RUN içindir.
 *
 * Amaç: API anahtarı olmadan runtime'ın (rekonsiliasyon + feed + OMS bakımı +
 * strateji + heartbeat) ayağa kalkabilmesi. Hiçbir ağ çağrısı yapmaz, hiçbir
 * emir göndermez.
 *
 * Sözleşmeler:
 * - LIVE/PAPER modunda oluşturulması REDDEDİLİR (gerçek venue'nun yerine geçemez).
 * - submitOrder/cancelOrder her zaman hata fırlatır — DRY_RUN'da OMS zaten
 *   venue'ya gitmez; bu savunma derinliğidir.
 * - Pozisyon/emir/bakiye boştur: bot "hiç pozisyonum yok" gerçeğiyle başlar.
 */
export class SimVenueAdapter implements VenueAdapter {
  readonly name = "sim";

  constructor(mode: Mode) {
    if (mode !== "DRY_RUN") {
      throw new Error("SimVenueAdapter yalnızca DRY_RUN modunda kullanılabilir");
    }
  }

  async connect(): Promise<void> {
    // Bağlantı yok — dolayısıyla çekim izni riski de yok.
  }

  async fetchPositions(): Promise<readonly VenuePosition[]> {
    return [];
  }

  async fetchOpenOrders(): Promise<readonly Order[]> {
    return [];
  }

  async fetchBalances(): Promise<readonly VenueBalance[]> {
    return [];
  }

  async submitOrder(_order: Order): Promise<Order> {
    throw new Error("simülasyon adaptörü emir göndermez (DRY_RUN)");
  }

  async queryOrder(_clientOrderId: string, _symbol: string): Promise<Order | undefined> {
    // Simülasyonda venue tarafında emir yoktur.
    return undefined;
  }

  async cancelOrder(_clientOrderId: string, _symbol: string): Promise<void> {
    throw new Error("simülasyon adaptörü emir iptal etmez (DRY_RUN)");
  }

  async fetchServerTime(): Promise<number> {
    return Date.now();
  }
}
