import type { StateStore } from "../state/state-store.js";

/**
 * Heartbeat — bot ayakta mı, feed akıyor mu. State dizinindeki
 * `heartbeat.json` dosyası üzerinden DIŞARIDAN izlenebilir
 * (ör. bir cron dosya yaşına bakar).
 */
export class Heartbeat {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {}

  beat(extra?: Record<string, unknown>): void {
    this.store.save("heartbeat", {
      at: new Date(this.now()).toISOString(),
      ...extra,
    });
  }
}
