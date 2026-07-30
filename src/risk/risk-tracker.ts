import type { Order, OrderSide } from "../oms/order.js";

interface TrackedPosition {
  quantity: number; // işaretli: + long, - short
  avgPrice: number;
}

/**
 * Risk kapısının ihtiyaç duyduğu canlı bağlamı besler: sembol/brüt notional,
 * günlük gerçekleşen zarar, dakikadaki emir sayısı. Pozisyonlar OMS
 * fill'lerinden beslenir; venue gerçeği rekonsiliasyonla doğrulanır.
 */
export class RiskTracker {
  private readonly positions = new Map<string, TrackedPosition>();
  private readonly orderTimestamps: number[] = [];
  private realizedPnlToday = 0;
  private dayKey: string;

  constructor(private readonly now: () => number = Date.now) {
    this.dayKey = this.currentDayKey();
  }

  /** Emir gönderim girişimi kaydı — dakika başına emir limiti için. */
  recordOrderAttempt(): void {
    this.orderTimestamps.push(this.now());
    this.prune();
  }

  ordersLastMinute(): number {
    this.prune();
    return this.orderTimestamps.length;
  }

  /** Fill uygula: pozisyonu ve gerçekleşen PnL'i günceller. */
  recordFill(symbol: string, side: OrderSide, quantity: number, price: number): void {
    this.rollDay();
    const pos = this.positions.get(symbol) ?? { quantity: 0, avgPrice: 0 };
    const signed = side === "BUY" ? quantity : -quantity;

    if (pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed)) {
      // Pozisyon büyüyor — ağırlıklı ortalama giriş fiyatı.
      const total = pos.quantity + signed;
      pos.avgPrice =
        total === 0 ? 0 : (pos.avgPrice * Math.abs(pos.quantity) + price * Math.abs(signed)) / Math.abs(total);
      pos.quantity = total;
    } else {
      // Pozisyon küçülüyor/dönüyor — kapanan kısım gerçekleşen PnL üretir.
      const closing = Math.min(Math.abs(signed), Math.abs(pos.quantity));
      const direction = Math.sign(pos.quantity); // +1 long, -1 short
      this.realizedPnlToday += closing * (price - pos.avgPrice) * direction;
      pos.quantity += signed;
      if (pos.quantity === 0) {
        pos.avgPrice = 0;
      } else if (Math.sign(pos.quantity) !== direction) {
        pos.avgPrice = price; // pozisyon yön değiştirdi — kalan yeni giriş
      }
    }

    if (pos.quantity === 0) this.positions.delete(symbol);
    else this.positions.set(symbol, pos);
  }

  position(symbol: string): number {
    return this.positions.get(symbol)?.quantity ?? 0;
  }

  /** Sembol için mevcut notional (USD) — |pozisyon| × fiyat. */
  symbolNotional(symbol: string, lastPrice: number, contractSize: number = 1): number {
    const pos = this.positions.get(symbol);
    if (pos === undefined) return 0;
    const price = lastPrice > 0 ? lastPrice : pos.avgPrice;
    return Math.abs(pos.quantity) * price * contractSize;
  }

  /** Toplam brüt notional (USD). Fiyat bilinmeyen semboller avgPrice ile sayılır. */
  grossNotional(
    priceOf: (symbol: string) => number | undefined,
    contractSizeOf: (symbol: string) => number = () => 1,
  ): number {
    let total = 0;
    for (const [symbol, pos] of this.positions) {
      const price = priceOf(symbol) ?? pos.avgPrice;
      total += Math.abs(pos.quantity) * price * contractSizeOf(symbol);
    }
    return total;
  }

  /** Bugünkü gerçekleşen zarar (pozitif sayı = zarar, USD). */
  dailyLoss(): number {
    this.rollDay();
    return Math.max(0, -this.realizedPnlToday);
  }

  realizedPnl(): number {
    this.rollDay();
    return this.realizedPnlToday;
  }

  /** Rekonsiliasyon sonrası venue gerçeğini benimse. */
  seedPosition(symbol: string, quantity: number, avgPrice: number): void {
    if (quantity === 0) this.positions.delete(symbol);
    else this.positions.set(symbol, { quantity, avgPrice });
  }

  static fillFromOrder(before: Order, after: Order): { quantity: number; price: number } | undefined {
    const delta = after.filledQuantity - before.filledQuantity;
    if (delta <= 0) return undefined;
    return { quantity: delta, price: after.price ?? 0 };
  }

  private prune(): void {
    const cutoff = this.now() - 60_000;
    while (this.orderTimestamps.length > 0 && (this.orderTimestamps[0] ?? 0) < cutoff) {
      this.orderTimestamps.shift();
    }
  }

  private rollDay(): void {
    const key = this.currentDayKey();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.realizedPnlToday = 0; // yeni gün — günlük zarar sayacı sıfırlanır
    }
  }

  private currentDayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}
