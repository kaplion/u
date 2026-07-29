import type { StateStore } from "../state/state-store.js";
import type { VenueAdapter } from "../venues/venue-adapter.js";
import type { AlertManager } from "../monitoring/alerts.js";
import type { Logger } from "../monitoring/logger.js";

/** Lokal olarak beklenen durum — state store'da tutulur. */
export interface ExpectedState {
  readonly positions: Record<string, number>;
  readonly openOrderIds: readonly string[];
  readonly balances: Record<string, number>; // asset → free + locked
}

export interface Deviation {
  readonly kind: "position" | "open_order" | "balance";
  readonly key: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

export interface ReconcileResult {
  readonly ok: boolean;
  readonly deviations: readonly Deviation[];
  /** İlk açılışta lokal state yoksa venue gerçeği benimsenir. */
  readonly adoptedTruth: boolean;
}

const STATE_KEY = "expected-state";

/**
 * Rekonsiliasyon: VENUE HER ZAMAN TEK DOĞRU KAYNAKTIR.
 * - Her restart'ta ve periyodik (≤60sn) çalışır.
 * - Lokal beklenti ile venue gerçeği karşılaştırılır.
 * - Sapma varsa İŞLEM DURUR ve alarm çıkar — tahminle devam edilmez.
 * - Hiç lokal state yoksa (ilk açılış) venue gerçeği benimsenir.
 */
export class Reconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private haltedFlag = false;

  constructor(
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore,
    private readonly alerts: AlertManager,
    private readonly logger: Logger,
    private readonly epsilon: number = 1e-9,
  ) {}

  /** Sapma görüldüyse true — yeni risk alınamaz. */
  isHalted(): boolean {
    return this.haltedFlag;
  }

  async runOnce(): Promise<ReconcileResult> {
    const [positions, openOrders, balances] = await Promise.all([
      this.adapter.fetchPositions(),
      this.adapter.fetchOpenOrders(),
      this.adapter.fetchBalances(),
    ]);

    const truth: ExpectedState = {
      positions: Object.fromEntries(positions.map((p) => [p.symbol, p.quantity])),
      openOrderIds: openOrders.map((o) => o.clientOrderId).sort(),
      balances: Object.fromEntries(balances.map((b) => [b.asset, b.free + b.locked])),
    };

    const expected = this.store.load<ExpectedState>(STATE_KEY);
    if (expected === undefined) {
      // İlk açılış: "düz pozisyondayım" VARSAYMA — venue gerçeğini benimse.
      this.store.save(STATE_KEY, truth);
      this.logger.info("lokal state yok — venue gerçeği benimsendi", {
        positions: truth.positions,
        openOrders: truth.openOrderIds.length,
      });
      return { ok: true, deviations: [], adoptedTruth: true };
    }

    const deviations = this.compare(expected, truth);
    if (deviations.length > 0) {
      this.haltedFlag = true;
      this.alerts.raise("reconciliation_deviation", "rekonsiliasyon sapması — işlem durduruldu", {
        deviations: deviations as Deviation[],
      });
      return { ok: false, deviations, adoptedTruth: false };
    }

    // Uyum tam — venue anlık görüntüsünü tazele (yeni fill'ler vs. yansır).
    this.store.save(STATE_KEY, truth);
    return { ok: true, deviations: [], adoptedTruth: false };
  }

  /**
   * Operatör sapmayı inceledikten sonra bilinçli olarak venue gerçeğini
   * kabul eder; bot tahminle değil kararla devam eder.
   */
  async adoptVenueTruth(): Promise<void> {
    const [positions, openOrders, balances] = await Promise.all([
      this.adapter.fetchPositions(),
      this.adapter.fetchOpenOrders(),
      this.adapter.fetchBalances(),
    ]);
    this.store.save(STATE_KEY, {
      positions: Object.fromEntries(positions.map((p) => [p.symbol, p.quantity])),
      openOrderIds: openOrders.map((o) => o.clientOrderId).sort(),
      balances: Object.fromEntries(balances.map((b) => [b.asset, b.free + b.locked])),
    } satisfies ExpectedState);
    this.haltedFlag = false;
    this.logger.warn("venue gerçeği operatör kararıyla benimsendi — halt kalktı");
  }

  /** Periyodik rekonsiliasyon. Spec: aralık ≤ 60sn. */
  start(intervalMs: number = 60_000): void {
    const interval = Math.min(intervalMs, 60_000);
    this.stop();
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error("periyodik rekonsiliasyon başarısız", { error: String(err) });
      });
    }, interval);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private compare(expected: ExpectedState, truth: ExpectedState): Deviation[] {
    const deviations: Deviation[] = [];

    for (const key of allKeys(expected.positions, truth.positions)) {
      const e = expected.positions[key] ?? 0;
      const a = truth.positions[key] ?? 0;
      if (Math.abs(e - a) > this.epsilon) {
        deviations.push({ kind: "position", key, expected: e, actual: a });
      }
    }

    const expectedOrders = new Set(expected.openOrderIds);
    const actualOrders = new Set(truth.openOrderIds);
    for (const id of expectedOrders) {
      if (!actualOrders.has(id)) {
        deviations.push({ kind: "open_order", key: id, expected: "açık", actual: "yok" });
      }
    }
    for (const id of actualOrders) {
      if (!expectedOrders.has(id)) {
        deviations.push({ kind: "open_order", key: id, expected: "yok", actual: "açık" });
      }
    }

    for (const key of allKeys(expected.balances, truth.balances)) {
      const e = expected.balances[key] ?? 0;
      const a = truth.balances[key] ?? 0;
      if (Math.abs(e - a) > this.epsilon) {
        deviations.push({ kind: "balance", key, expected: e, actual: a });
      }
    }

    return deviations;
  }
}

function allKeys(a: Record<string, number>, b: Record<string, number>): Set<string> {
  return new Set([...Object.keys(a), ...Object.keys(b)]);
}
