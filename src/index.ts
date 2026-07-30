import { App } from "./app.js";
import { loadConfig, type Config } from "./config/config.js";
import { Logger } from "./monitoring/logger.js";
import { AlertManager } from "./monitoring/alerts.js";
import { KillSwitch } from "./risk/kill-switch.js";
import { StateStore } from "./state/state-store.js";
import { StalenessDetector } from "./market-data/staleness.js";
import { createBinanceAdapterFromEnv } from "./venues/binance/binance-adapter.js";
import { createAlpacaAdapterFromEnv } from "./venues/alpaca/alpaca-adapter.js";
import { createIgAdapterFromEnv } from "./venues/ig/ig-adapter.js";
import { SimVenueAdapter } from "./venues/sim/sim-adapter.js";
import type { VenueAdapter } from "./venues/venue-adapter.js";

/**
 * Adaptör seçimi. Anahtar yoksa:
 * - DRY_RUN: simülasyon adaptörü ile runtime yine de ayağa kalkar (emir
 *   gönderilmez, ağ çağrısı yapılmaz) — bot sessizce kapanmaz.
 * - PAPER/LIVE: adaptör yok; bot çevrimdışı iskelet modunda kalır, çünkü
 *   gerçek venue olmadan gerçek emir yaşam döngüsü taklit edilemez.
 */
export function createAdapter(
  config: Config,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): VenueAdapter | undefined {
  const adapter =
    config.venue === "alpaca"
      ? createAlpacaAdapterFromEnv(config.mode, logger, env)
      : config.venue === "ig"
        ? createIgAdapterFromEnv(config.mode, logger, env)
        : createBinanceAdapterFromEnv(config.mode, logger, env);
  if (adapter !== undefined) return adapter;
  if (config.mode === "DRY_RUN") {
    logger.warn("venue anahtarı yok — DRY_RUN simülasyon adaptörü ile başlanıyor", {
      venue: config.venue,
      hint:
        "gerçek venue için BINANCE_API_KEY/BINANCE_API_SECRET, ALPACA_* veya IG_* tanımla",
    });
    return new SimVenueAdapter(config.mode);
  }
  return undefined;
}

/**
 * Giriş noktası. Açılış sırası (spec):
 *   state yükle → venue'dan gerçeği çek → karşılaştır → uyuşmuyorsa dur.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.mode);
  const alerts = new AlertManager(logger);
  const app = new App({
    config,
    logger,
    alerts,
    adapter: createAdapter(config, logger),
    stateStore: new StateStore(config.stateDir),
    killSwitch: new KillSwitch(config.killSwitchFile),
    staleness: new StalenessDetector(config.staleDataThresholdMs),
  });

  const shutdown = (signal: string): void => {
    logger.info("kapanış sinyali alındı", { signal });
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const result = await app.start();
  if (result.status === "halted") {
    // Sapma çözülmeden devam yok — süreç hatayla biter, operatör bakmalı.
    app.stop();
    process.exitCode = 1;
  } else if (result.status === "skeleton") {
    app.stop();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((err) => {
    // Anahtar/imza asla hata mesajına girmez (adaptör sözleşmesi).
    console.error("başlatma hatası:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
