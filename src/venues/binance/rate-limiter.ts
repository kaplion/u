/**
 * Ağırlık bazlı rate limit sayacı + 429/418 exponential backoff.
 * Ban yemek botun günlerce durması demektir — limite yaklaşınca bekle,
 * 429/418 gelince geri çekil.
 */
export type AcquireResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryInMs: number };

export class RateLimiter {
  private windowStart = 0;
  private usedWeight = 0;
  private blockedUntil = 0;
  private consecutiveRateLimits = 0;

  constructor(
    private readonly maxWeightPerMinute: number = 6_000,
    private readonly now: () => number = Date.now,
    private readonly baseBackoffMs: number = 1_000,
    private readonly maxBackoffMs: number = 300_000,
  ) {}

  /** İstek öncesi çağrılır. ok=false ise retryInMs kadar beklenmeli. */
  tryAcquire(weight: number): AcquireResult {
    const t = this.now();
    if (t < this.blockedUntil) {
      return { ok: false, retryInMs: this.blockedUntil - t };
    }
    this.rollWindow(t);
    if (this.usedWeight + weight > this.maxWeightPerMinute) {
      return { ok: false, retryInMs: this.windowStart + 60_000 - t };
    }
    this.usedWeight += weight;
    return { ok: true };
  }

  /**
   * Venue 429 (rate limit) veya 418 (ban) döndürdü. Retry-After verilmişse
   * ona uy, yoksa exponential backoff uygula.
   */
  onRateLimited(retryAfterMs?: number): number {
    this.consecutiveRateLimits += 1;
    const backoff =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? retryAfterMs
        : Math.min(
            this.baseBackoffMs * 2 ** (this.consecutiveRateLimits - 1),
            this.maxBackoffMs,
          );
    this.blockedUntil = this.now() + backoff;
    return backoff;
  }

  /** Başarılı yanıt sonrası backoff sayacı sıfırlanır. */
  onSuccess(): void {
    this.consecutiveRateLimits = 0;
  }

  private rollWindow(t: number): void {
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.usedWeight = 0;
    }
  }
}
