/**
 * Saat kayması kontrolü. Binance zaman damgası sapan emri reddeder —
 * venue `serverTime` ile periyodik drift ölçümü yapılır ve eşik
 * aşılırsa alarm koşulu doğar (NTP senkronu dağıtım katmanının işidir).
 */
export interface DriftResult {
  /** Pozitif = lokal saat venue'dan geride. */
  readonly driftMs: number;
  readonly ok: boolean;
}

export class ClockDriftMonitor {
  constructor(
    private readonly fetchServerTime: () => Promise<number>,
    private readonly thresholdMs: number = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(): Promise<DriftResult> {
    const t0 = this.now();
    const serverTime = await this.fetchServerTime();
    const t1 = this.now();
    // Gidiş-dönüş süresinin yarısını düşerek kabaca anlık sunucu zamanı.
    const localMidpoint = t0 + (t1 - t0) / 2;
    const driftMs = serverTime - localMidpoint;
    return { driftMs, ok: Math.abs(driftMs) <= this.thresholdMs };
  }
}
