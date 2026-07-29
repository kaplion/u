import type { AlertManager } from "../monitoring/alerts.js";
import type { OrderIntent } from "../oms/oms.js";

/** Kaldıraçlı pozisyon — venue'nun bildirdiği likidasyon fiyatıyla. */
export interface LeveragedPosition {
  readonly symbol: string;
  /** İşaretli miktar: + long, - short. */
  readonly quantity: number;
  readonly liquidationPrice: number;
}

/**
 * Fiyatın likidasyona yakınlığı: 0 = güvenli, 1 = likidasyon fiyatında.
 * Long için fiyat likidasyonun ÜSTÜNDE, short için ALTINDA kalmalıdır.
 */
export function liquidationProximity(pos: LeveragedPosition, lastPrice: number): number {
  if (pos.quantity === 0 || pos.liquidationPrice <= 0 || lastPrice <= 0) return 0;
  const distance =
    pos.quantity > 0
      ? (lastPrice - pos.liquidationPrice) / lastPrice
      : (pos.liquidationPrice - lastPrice) / lastPrice;
  if (distance <= 0) return 1; // likidasyon fiyatı geçildi
  return Math.max(0, 1 - distance);
}

export interface LiquidationMonitorOptions {
  readonly alerts: AlertManager;
  /** Tampon: yakınlık bu eşiği aşınca pozisyon kendiliğinden küçülür. */
  readonly bufferProximity?: number;
  /** Küçültme oranı: pozisyonun bu kadarı reduce-only ile kapatılır. */
  readonly reduceFraction?: number;
}

/**
 * Likidasyon yakınlığı (madde 11): likidasyon fiyatını sürekli hesapla,
 * tampona girilince KENDİLİĞİNDEN pozisyon küçült — borsanın seni likide
 * etmesini bekleme. Üretilen niyet reduceOnly'dir: kill switch altında bile
 * geçer ve yanlışlıkla ters pozisyon açamaz.
 */
export class LiquidationMonitor {
  private readonly bufferProximity: number;
  private readonly reduceFraction: number;

  constructor(private readonly opts: LiquidationMonitorOptions) {
    this.bufferProximity = opts.bufferProximity ?? 0.9;
    this.reduceFraction = opts.reduceFraction ?? 0.5;
  }

  /** Tampona girildiyse pozisyonu küçültecek reduce-only emir niyeti döner. */
  check(pos: LeveragedPosition, lastPrice: number): OrderIntent | undefined {
    const proximity = liquidationProximity(pos, lastPrice);
    if (proximity < this.bufferProximity) return undefined;

    const reduceQty = Math.abs(pos.quantity) * this.reduceFraction;
    if (reduceQty <= 0) return undefined;

    this.opts.alerts.raise("liquidation_buffer", "likidasyon tamponuna girildi — pozisyon küçültülüyor", {
      symbol: pos.symbol,
      proximity: Number(proximity.toFixed(4)),
      liquidationPrice: pos.liquidationPrice,
      lastPrice,
      reduceQty,
    });

    return {
      symbol: pos.symbol,
      side: pos.quantity > 0 ? "SELL" : "BUY",
      quantity: reduceQty,
      reduceOnly: true,
    };
  }
}
