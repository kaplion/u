import type { Config } from "./config/config.js";
import { Logger } from "./monitoring/logger.js";
import { AlertManager } from "./monitoring/alerts.js";
import { ClockDriftMonitor } from "./monitoring/clock-drift.js";
import { Heartbeat } from "./monitoring/heartbeat.js";
import { KillSwitch } from "./risk/kill-switch.js";
import { StateStore } from "./state/state-store.js";
import { StalenessDetector } from "./market-data/staleness.js";
import { MarketDataFeed } from "./market-data/market-data-feed.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import type { VenueAdapter } from "./venues/venue-adapter.js";
import { binanceRestBase, binanceStreamBase } from "./venues/binance/binance-adapter.js";

/** Feed'in App tarafından kullanılan yüzeyi — testte sahtesi enjekte edilebilir. */
export interface FeedLike {
  start(): void;
  stop(): void;
  isConnected(): boolean;
}

export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly adapter: VenueAdapter | undefined;
  readonly alerts: AlertManager;
  readonly stateStore: StateStore;
  readonly killSwitch: KillSwitch;
  readonly staleness: StalenessDetector;
  /** Testte sahte feed enjekte edilebilir. */
  readonly feed?: FeedLike;
}

export type StartResult =
  | { readonly status: "running" }
  | { readonly status: "skeleton" } // anahtar yok — çevrimdışı iskelet
  | { readonly status: "halted"; readonly reason: string };

/**
 * Faz 1 orkestrasyonu. Açılış sırası (spec):
 *   state yükle → venue'dan gerçeği çek → karşılaştır → uyuşmuyorsa DUR
 * Sonra: market data feed + periyodik rekonsiliasyon + heartbeat.
 */
export class App {
  private readonly heartbeat: Heartbeat;
  private reconciler: Reconciler | undefined;
  private feed: FeedLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: AppDeps) {
    this.heartbeat = new Heartbeat(deps.stateStore);
  }

  async start(): Promise<StartResult> {
    const { config, logger, adapter, alerts, killSwitch, staleness } = this.deps;

    logger.info("bot başlatılıyor", {
      mode: config.mode,
      symbols: config.symbols as string[],
      killSwitchActive: killSwitch.isActive(),
    });

    if (killSwitch.isActive()) {
      alerts.raise("kill_switch", "açılışta kill switch aktif — yeni risk alınmayacak", {
        file: config.killSwitchFile,
      });
    }

    if (adapter === undefined) {
      logger.warn("venue anahtarı yok — çevrimdışı iskelet modu (bağlantı kurulmayacak)");
      return { status: "skeleton" };
    }

    // 1) Bağlan + anahtar izin kontrolü (çekim izni varsa burada reddedilir).
    await adapter.connect();

    // 2) Saat kayması kontrolü.
    const drift = await new ClockDriftMonitor(() => adapter.fetchServerTime()).check();
    if (!drift.ok) {
      alerts.raise("clock_drift", "saat kayması eşik üstünde — NTP senkronunu kontrol et", {
        driftMs: drift.driftMs,
      });
    }

    // 3) Rekonsiliasyon: state yükle → venue gerçeği → karşılaştır.
    this.reconciler = new Reconciler(adapter, this.deps.stateStore, alerts, logger);
    const result = await this.reconciler.runOnce();
    if (!result.ok) {
      // Uyuşmuyorsa DUR ve alarm ver (alarm Reconciler içinde çıktı) —
      // tahminle devam etme.
      logger.error("açılış rekonsiliasyonu başarısız — bot DURDU", {
        deviations: result.deviations.length,
      });
      return { status: "halted", reason: "rekonsiliasyon sapması" };
    }

    // 4) Periyodik rekonsiliasyon (≤60sn) + market data + heartbeat.
    this.reconciler.start(config.reconcileIntervalMs);

    this.feed =
      this.deps.feed ??
      new MarketDataFeed({
        symbols: config.symbols,
        streamBase: binanceStreamBase(config.mode),
        restBase: binanceRestBase(config.mode),
        logger,
        alerts,
        staleness,
        heartbeatTimeoutMs: config.staleDataThresholdMs,
      });
    this.feed.start();

    this.heartbeat.beat({ mode: config.mode, phase: "started" });
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat.beat({
        mode: config.mode,
        feedConnected: this.feed?.isConnected() ?? false,
        dataStale: staleness.isStale(),
        reconcileHalted: this.reconciler?.isHalted() ?? false,
      });
      if (staleness.isStale()) {
        alerts.raise("stale_data", "piyasa verisi bayat — yeni emir verilmemeli");
      }
    }, config.heartbeatIntervalMs);

    logger.info("Faz 1 runtime ayakta: feed + rekonsiliasyon + heartbeat");
    return { status: "running" };
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.reconciler?.stop();
    this.feed?.stop();
    this.deps.logger.info("bot durduruldu");
  }
}
