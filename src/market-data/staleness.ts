/**
 * Bayat veri algısı: feed sessizleşti ama bağlantı açık görünüyor.
 * Eşik aşılırsa yeni emir yok (risk kapısı üzerinden uygulanır).
 */
export class StalenessDetector {
  private lastTickAt: number | undefined;

  constructor(
    private readonly thresholdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  onTick(): void {
    this.lastTickAt = this.now();
  }

  /** Hiç veri gelmediyse de bayat sayılır — "son bilinen fiyat" yoktur. */
  isStale(): boolean {
    if (this.lastTickAt === undefined) return true;
    return this.now() - this.lastTickAt > this.thresholdMs;
  }
}
