import type { Config } from "./config/config.js";
import { Logger } from "./monitoring/logger.js";
import { AlertManager } from "./monitoring/alerts.js";
import { ClockDriftMonitor } from "./monitoring/clock-drift.js";
import { Dashboard } from "./monitoring/dashboard.js";
import { Heartbeat } from "./monitoring/heartbeat.js";
import { KillSwitch } from "./risk/kill-switch.js";
import { HARD_LIMITS, type RiskContext } from "./risk/risk-gate.js";
import { RiskTracker } from "./risk/risk-tracker.js";
import { StateStore } from "./state/state-store.js";
import { StalenessDetector } from "./market-data/staleness.js";
import { MarketDataFeed, type PriceTick } from "./market-data/market-data-feed.js";
import { PollingMarketDataFeed } from "./market-data/polling-market-data-feed.js";
import { AuditLog } from "./oms/audit-log.js";
import { Oms } from "./oms/oms.js";
import type { Order } from "./oms/order.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import { HoldStrategy, StrategyRunner, type Strategy } from "./strategy/strategy.js";
import { forexPipValue, type SymbolSpec } from "./venues/asset-class.js";
import type { VenueAdapter, VenueStatus } from "./venues/venue-adapter.js";
import { binanceRestBase, binanceStreamBase } from "./venues/binance/binance-adapter.js";

/** Feed'in App tarafından kullanılan yüzeyi — testte sahtesi enjekte edilebilir. */
export interface FeedLike {
  start(): void;
  stop(): void;
  isConnected(): boolean;
  lastPrice?(symbol: string): PriceTick | undefined;
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
  /** Strateji — varsayılan HoldStrategy (sinyal üretmez). */
  readonly strategy?: Strategy;
}

export type StartResult =
  | { readonly status: "running" }
  | { readonly status: "skeleton" } // anahtar yok — çevrimdışı iskelet
  | { readonly status: "halted"; readonly reason: string };

/**
 * Orkestrasyon. Açılış sırası (spec):
 *   state yükle → venue'dan gerçeği çek → karşılaştır → uyuşmuyorsa DUR
 * Sonra: market data feed + periyodik rekonsiliasyon + heartbeat +
 * OMS bakımı (UNKNOWN çözümü, emir senkronu, kısmi dolum) + strateji +
 * dashboard.
 */
export class App {
  private readonly heartbeat: Heartbeat;
  private reconciler: Reconciler | undefined;
  private feed: FeedLike | undefined;
  private oms: Oms | undefined;
  private riskTracker: RiskTracker | undefined;
  private strategyRunner: StrategyRunner | undefined;
  private dashboard: Dashboard | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private dailyLossAlerted = false;
  private marginAlerted = false;
  private readonly startedAt = Date.now();
  private venueStatus: VenueStatus = {};

  constructor(private readonly deps: AppDeps) {
    this.heartbeat = new Heartbeat(deps.stateStore);
  }

  async start(): Promise<StartResult> {
    const { config, logger, adapter, alerts, killSwitch, staleness } = this.deps;

    logger.info("bot başlatılıyor", {
      mode: config.mode,
      venue: config.venue,
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

    // 4) Periyodik rekonsiliasyon (≤60sn) + market data.
    this.reconciler.start(config.reconcileIntervalMs);

    this.feed = this.deps.feed ?? this.createFeed();
    this.feed.start();

    // 5) Faz 2+ — OMS + risk kapısı. DRY_RUN'da emirler üretilir ve
    // loglanır ama GÖNDERİLMEZ; PAPER testnet'e, LIVE (kanarya tavanıyla)
    // gerçek venue'ya gider.
    this.riskTracker = new RiskTracker();
    const audit = new AuditLog(config.stateDir, config.mode);
    this.oms = new Oms({
      mode: config.mode,
      adapter,
      store: this.deps.stateStore,
      audit,
      logger,
      alerts,
      riskContext: (order) => this.buildRiskContext(order),
      onFill: (order, qty, price) =>
        this.riskTracker?.recordFill(order.symbol, order.side, qty, price),
      orderTimeoutMs: config.orderTimeoutMs,
      partialFillTimeoutMs: config.partialFillTimeoutMs,
    });
    for (const position of await adapter.fetchPositions()) {
      this.riskTracker.seedPosition(position.symbol, position.quantity, position.avgPrice ?? 0);
    }
    await this.refreshVenueStatus();
    // Restart kurtarma: terminal olmayan emirler venue'ya SORULUR —
    // asla yeniden gönderilmez, asla varsayılmaz.
    await this.oms.recover();

    // 6) Strateji runtime — hedef pozisyon → delta emir (risk kapısından).
    const strategy = this.deps.strategy ?? new HoldStrategy();
    this.strategyRunner = new StrategyRunner({
      strategy,
      oms: this.oms,
      mode: config.mode,
      logger,
    });

    // 7) Heartbeat + periyodik OMS bakımı + strateji değerlendirmesi.
    this.heartbeat.beat({ mode: config.mode, phase: "started" });
    this.heartbeatTimer = setInterval(() => {
      void this.tick();
    }, config.heartbeatIntervalMs);

    // 8) Faz 7 — dashboard (yalnızca istenirse).
    if (config.dashboardPort > 0) {
      this.dashboard = new Dashboard({
        host: config.dashboardHost,
        port: config.dashboardPort,
        statusProvider: () => this.status(strategy),
        killSwitchFile: config.killSwitchFile,
        logger,
      });
      await this.dashboard.start();
    }

    logger.info("runtime ayakta: feed + rekonsiliasyon + OMS + heartbeat", {
      mode: config.mode,
      strategy: strategy.name,
    });
    return { status: "running" };
  }

  /** Strateji/operatör için emir kapısı — her şey OMS + risk kapısından geçer. */
  getOms(): Oms | undefined {
    return this.oms;
  }

  private async tick(): Promise<void> {
    const { config, alerts, staleness } = this.deps;
    await this.refreshVenueStatus();

    this.heartbeat.beat({
      mode: config.mode,
      feedConnected: this.feed?.isConnected() ?? false,
      dataStale: staleness.isStale(),
      reconcileHalted: this.reconciler?.isHalted() ?? false,
      openOrders: this.oms?.openOrders().length ?? 0,
      realizedPnl: this.riskTracker?.realizedPnl() ?? 0,
    });

    if (staleness.isStale()) {
      alerts.raise("stale_data", "piyasa verisi bayat — yeni emir verilmemeli");
    }

    const dailyLoss = this.riskTracker?.dailyLoss() ?? 0;
    if (dailyLoss >= HARD_LIMITS.maxDailyLoss && !this.dailyLossAlerted) {
      this.dailyLossAlerted = true;
      alerts.raise("daily_loss_limit", "günlük zarar limiti aşıldı — gün kapandı", {
        dailyLoss,
        limit: HARD_LIMITS.maxDailyLoss,
      });
    }

    if (
      this.venueStatus.marginUsage !== undefined &&
      this.venueStatus.marginUsage >= config.forexMarginAlertThreshold &&
      !this.marginAlerted
    ) {
      this.marginAlerted = true;
      alerts.raise("margin_warning", "forex margin kullanımı alarm eşiğine yaklaştı", {
        marginUsage: this.venueStatus.marginUsage,
        threshold: config.forexMarginAlertThreshold,
      });
    }
    if (
      this.venueStatus.accountBlocked === true ||
      this.venueStatus.tradingBlocked === true
    ) {
      alerts.raise("fatal", "venue hesabı işlem için bloke — runtime durduruluyor", {
        accountBlocked: this.venueStatus.accountBlocked ?? false,
        tradingBlocked: this.venueStatus.tradingBlocked ?? false,
      });
      this.stop();
      return;
    }

    // OMS bakımı: UNKNOWN çözümü, venue emir senkronu, kısmi dolum kararı.
    try {
      await this.oms?.resolveUnknownOrders();
      await this.oms?.syncOpenOrders();
      await this.oms?.checkPartialFills();
    } catch (err) {
      this.deps.logger.error("OMS bakım turu başarısız", { error: String(err) });
    }

    // Strateji: sembol başına hedef pozisyon değerlendirmesi. Rekonsiliasyon
    // halt'taysa veya veri bayatsa yeni karar YOK (risk kapısı ayrıca engeller).
    if (this.reconciler?.isHalted() === true || staleness.isStale()) return;
    for (const symbol of config.symbols) {
      const tick = this.feed?.lastPrice?.(symbol);
      if (tick === undefined) continue;
      try {
        await this.strategyRunner?.evaluate({
          symbol,
          lastPrice: tick.price,
          position: this.riskTracker?.position(symbol) ?? 0,
        });
      } catch (err) {
        this.deps.logger.error("strateji değerlendirmesi başarısız", {
          symbol,
          error: String(err),
        });
      }
    }
  }

  private buildRiskContext(order: Order): RiskContext {
    const { config, killSwitch, staleness } = this.deps;
    const tracker = this.riskTracker ?? new RiskTracker();
    const lastPrice = this.feed?.lastPrice?.(order.symbol)?.price ?? 0;
    const spec = this.symbolSpec(order.symbol);
    tracker.recordOrderAttempt();
    return {
      mode: config.mode,
      assetClass: spec.assetClass,
      contractSize: spec.contractSize,
      killSwitchActive: killSwitch.isActive() || this.reconciler?.isHalted() === true,
      lastPrice,
      dataStale: staleness.isStale(),
      currentSymbolNotional: tracker.symbolNotional(order.symbol, lastPrice, spec.contractSize),
      currentGrossNotional: tracker.grossNotional(
        (s) => this.feed?.lastPrice?.(s)?.price,
        (s) => this.symbolSpec(s).contractSize,
      ),
      dailyLoss: tracker.dailyLoss(),
      ordersLastMinute: tracker.ordersLastMinute(),
      marginUsageLimit: config.forexMarginUsageLimit,
      ...(spec.pipSize !== undefined ? { pipSize: spec.pipSize } : {}),
      ...(this.venueStatus.marketOpen !== undefined
        ? { marketOpen: this.venueStatus.marketOpen }
        : {}),
      ...(this.venueStatus.marginUsage !== undefined
        ? { marginUsage: this.venueStatus.marginUsage }
        : {}),
    };
  }

  private status(strategy: Strategy): Record<string, unknown> {
    const { config, killSwitch, staleness } = this.deps;
    return {
      mode: config.mode,
      venue: config.venue,
      assetClass: config.assetClass,
      uptimeMs: Date.now() - this.startedAt,
      feedConnected: this.feed?.isConnected() ?? false,
      dataStale: staleness.isStale(),
      killSwitchActive: killSwitch.isActive(),
      reconcileHalted: this.reconciler?.isHalted() ?? false,
      marketOpen: this.venueStatus.marketOpen,
      symbols: config.symbols,
      symbolSpecs: config.symbolSpecs,
      prices: Object.fromEntries(
        config.symbols
          .map((s) => [s, this.feed?.lastPrice?.(s)?.price] as const)
          .filter(([, p]) => p !== undefined),
      ),
      openOrders: this.oms?.openOrders() ?? [],
      realizedPnl: this.riskTracker?.realizedPnl() ?? 0,
      dailyLoss: this.riskTracker?.dailyLoss() ?? 0,
      venueStatus: this.venueStatus,
      forex:
        config.assetClass === "forex"
          ? {
              marginUsage: this.venueStatus.marginUsage ?? null,
              marginLevel: this.venueStatus.marginLevel ?? null,
              swapCost: this.venueStatus.swapCost ?? null,
              marginUsageLimit: config.forexMarginUsageLimit,
              marginAlertThreshold: config.forexMarginAlertThreshold,
              pipValues: Object.fromEntries(
                config.symbolSpecs.map((spec) => [
                  spec.symbol,
                  forexPipValue(this.feed?.lastPrice?.(spec.symbol)?.price ?? 0, spec) ?? null,
                ]),
              ),
            }
          : undefined,
      strategy: {
        name: strategy.name,
        validation: strategy.validation ?? null, // Deflated Sharpe + PBO görünür
      },
      hardLimits: HARD_LIMITS,
    };
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.reconciler?.stop();
    this.feed?.stop();
    void this.dashboard?.stop();
    this.deps.logger.info("bot durduruldu");
  }

  private createFeed(): FeedLike {
    const { config, logger, alerts, staleness, adapter } = this.deps;
    if (config.venue === "binance") {
      return new MarketDataFeed({
        symbols: config.symbols,
        streamBase: binanceStreamBase(config.mode),
        restBase: binanceRestBase(config.mode),
        logger,
        alerts,
        staleness,
        heartbeatTimeoutMs: config.staleDataThresholdMs,
      });
    }
    if (adapter?.fetchLatestPrices === undefined) {
      throw new Error(`${config.venue} venue fiyat polling yüzeyi sunmuyor`);
    }
    return new PollingMarketDataFeed({
      symbols: config.symbols,
      pollIntervalMs: config.marketDataPollIntervalMs,
      logger,
      alerts,
      staleness,
      fetchLatestPrices: (symbols) => adapter.fetchLatestPrices!(symbols),
    });
  }

  private async refreshVenueStatus(): Promise<void> {
    const symbols = this.deps.config.symbols;
    this.venueStatus =
      (await this.deps.adapter?.fetchVenueStatus?.(symbols)) ?? this.venueStatus;
  }

  private symbolSpec(symbol: string): SymbolSpec {
    return (
      this.deps.config.symbolSpecs.find((spec) => spec.symbol === symbol) ??
      this.deps.config.symbolSpecs[0]!
    );
  }
}
