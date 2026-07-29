import type { Mode } from "../config/mode.js";
import type { Logger } from "../monitoring/logger.js";
import type { Oms, PlaceResult } from "../oms/oms.js";

/**
 * Strateji doğrulama raporu — canlıya çıkacak her strateji için zorunlu.
 * Deflated Sharpe (kaç varyant denendiği hesaba katılmış) ve PBO;
 * config'de ve dashboard'da görünür.
 */
export interface StrategyValidation {
  readonly deflatedSharpe: number;
  readonly pbo: number;
}

export interface StrategyInput {
  readonly symbol: string;
  readonly lastPrice: number;
  /** Mevcut pozisyon (işaretli miktar). */
  readonly position: number;
}

/**
 * Strateji runtime sözleşmesi: sinyal → HEDEF POZİSYON. Emir üretimi,
 * risk kapısı ve yaşam döngüsü stratejinin işi değildir — tek karar
 * mantığı burada durur (Python yalnızca parametre üretir).
 */
export interface Strategy {
  readonly name: string;
  readonly validation?: StrategyValidation;
  targetPosition(input: StrategyInput): number;
}

/** Güvenli varsayılan: hedef = mevcut — hiç sinyal üretmez. */
export class HoldStrategy implements Strategy {
  readonly name = "hold";
  targetPosition(input: StrategyInput): number {
    return input.position;
  }
}

export interface StrategyRunnerOptions {
  readonly strategy: Strategy;
  readonly oms: Oms;
  readonly mode: Mode;
  readonly logger: Logger;
  /** Bu değerin altındaki delta emir üretmez (kuantizasyon gürültüsü). */
  readonly minOrderQuantity?: number;
}

/**
 * Hedef pozisyon → delta emir. Her emir OMS üzerinden gider; risk kapısı
 * stratejiyi EZER. LIVE modda doğrulama raporu (Deflated Sharpe + PBO)
 * olmayan strateji ÇALIŞTIRILMAZ.
 */
export class StrategyRunner {
  private readonly minOrderQuantity: number;

  constructor(private readonly opts: StrategyRunnerOptions) {
    this.minOrderQuantity = opts.minOrderQuantity ?? 1e-9;
    if (opts.mode === "LIVE" && opts.strategy.validation === undefined) {
      throw new Error(
        `Strateji "${opts.strategy.name}" doğrulama raporu (Deflated Sharpe + PBO) olmadan LIVE çalıştırılamaz`,
      );
    }
  }

  async evaluate(input: StrategyInput): Promise<PlaceResult | undefined> {
    const target = this.opts.strategy.targetPosition(input);
    const delta = target - input.position;
    if (!Number.isFinite(delta) || Math.abs(delta) < this.minOrderQuantity) return undefined;

    const reduceOnly = Math.abs(target) < Math.abs(input.position) && target * input.position >= 0;
    this.opts.logger.info("strateji sinyali", {
      strategy: this.opts.strategy.name,
      symbol: input.symbol,
      position: input.position,
      target,
      delta,
      ...(this.opts.strategy.validation !== undefined
        ? { validation: { ...this.opts.strategy.validation } }
        : {}),
    });

    return this.opts.oms.place({
      symbol: input.symbol,
      side: delta > 0 ? "BUY" : "SELL",
      quantity: Math.abs(delta),
      reduceOnly,
    });
  }
}
