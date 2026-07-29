import type { Mode } from "../config/mode.js";
import type { Order } from "../oms/order.js";

/**
 * Sert limitler KOD İÇİNDE tanımlıdır, config'de değil — atlanabilir bir
 * yolu olmamalı. Değiştirilmesi kod değişikliği ve review gerektirir.
 */
export const HARD_LIMITS = {
  /** Sembol başına max notional (USD). */
  maxNotionalPerSymbol: 1_000,
  /** Toplam brüt pozisyon tavanı (USD). */
  maxGrossNotional: 5_000,
  /** Günlük max zarar (USD) — aşılırsa gün kapanır. */
  maxDailyLoss: 100,
  /** Dakika başına max emir sayısı (döngü koruması). */
  maxOrdersPerMinute: 10,
  /** Son fiyattan bu orandan uzak emir reddedilir (fat finger). */
  maxPriceDeviation: 0.1,
  /**
   * Faz 6 — LIVE kanarya tavanı: canlı modda emir başına max notional (USD).
   * Ölçek ancak paper ile canlı sonuçlar uyuştuktan sonra KOD DEĞİŞİKLİĞİ
   * ve review ile artar.
   */
  liveCanaryMaxOrderNotional: 50,
} as const;

export interface RiskContext {
  /** Çalışma modu — LIVE'da kanarya tavanı devreye girer. */
  readonly mode: Mode;
  /** Kill switch aktif mi (dışarıdan tetiklenir). */
  readonly killSwitchActive: boolean;
  /** Son bilinen piyasa fiyatı (fiyat sanity için). */
  readonly lastPrice: number;
  /** Piyasa verisi bayat mı. */
  readonly dataStale: boolean;
  /** Sembol için mevcut notional (USD). */
  readonly currentSymbolNotional: number;
  /** Toplam brüt notional (USD). */
  readonly currentGrossNotional: number;
  /** Bugünkü gerçekleşen zarar (pozitif sayı = zarar, USD). */
  readonly dailyLoss: number;
  /** Son bir dakikada gönderilen emir sayısı. */
  readonly ordersLastMinute: number;
}

export type RiskDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Risk kapısı stratejiyi EZER, atlanamaz. Her emir gönderilmeden önce
 * buradan geçmek zorundadır.
 */
export function checkOrder(order: Order, ctx: RiskContext): RiskDecision {
  // Kill switch: yeni riske izin yok ama pozisyon azaltan emirler geçer.
  if (ctx.killSwitchActive && !order.reduceOnly) {
    return deny("kill switch aktif — yalnızca reduceOnly emirler geçer");
  }

  if (ctx.dataStale) {
    return deny("piyasa verisi bayat — yeni emir yok");
  }

  if (ctx.dailyLoss >= HARD_LIMITS.maxDailyLoss) {
    return deny(`günlük zarar limiti aşıldı (${ctx.dailyLoss} >= ${HARD_LIMITS.maxDailyLoss})`);
  }

  if (ctx.ordersLastMinute >= HARD_LIMITS.maxOrdersPerMinute) {
    return deny("dakika başına emir limiti aşıldı (döngü koruması)");
  }

  const price = order.price ?? ctx.lastPrice;

  // Fiyat sanity: son fiyattan çok uzak limit emri reddet.
  if (order.price !== undefined && ctx.lastPrice > 0) {
    const deviation = Math.abs(order.price - ctx.lastPrice) / ctx.lastPrice;
    if (deviation > HARD_LIMITS.maxPriceDeviation) {
      return deny(
        `fiyat sanity: emir fiyatı son fiyattan %${(deviation * 100).toFixed(1)} uzakta`,
      );
    }
  }

  const notional = order.quantity * price;
  if (!Number.isFinite(notional) || notional <= 0) {
    return deny(`geçersiz notional: ${notional}`);
  }

  // Faz 6 — LIVE kanarya: canlı mod yalnızca küçük boyutla çalışır.
  if (ctx.mode === "LIVE" && notional > HARD_LIMITS.liveCanaryMaxOrderNotional) {
    return deny(
      `LIVE kanarya tavanı: emir notional ${notional} > ${HARD_LIMITS.liveCanaryMaxOrderNotional} USD`,
    );
  }

  if (!order.reduceOnly) {
    if (ctx.currentSymbolNotional + notional > HARD_LIMITS.maxNotionalPerSymbol) {
      return deny("sembol başına max notional aşılır");
    }
    if (ctx.currentGrossNotional + notional > HARD_LIMITS.maxGrossNotional) {
      return deny("toplam brüt notional tavanı aşılır");
    }
  }

  return { allowed: true };
}

function deny(reason: string): RiskDecision {
  return { allowed: false, reason };
}
