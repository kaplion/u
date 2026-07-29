import { loadConfig } from "./config/config.js";
import { Logger } from "./monitoring/logger.js";
import { KillSwitch } from "./risk/kill-switch.js";
import { StateStore } from "./state/state-store.js";
import { StalenessDetector } from "./market-data/staleness.js";

/**
 * Giriş noktası. Açılış sırası (spec):
 *   state yükle → venue'dan gerçeği çek → karşılaştır → uyuşmuyorsa dur.
 * Venue adaptörleri eklendikçe rekonsiliasyon adımı buraya bağlanır.
 */
export function main(): void {
  const config = loadConfig();
  const logger = new Logger(config.mode);
  const killSwitch = new KillSwitch(config.killSwitchFile);
  const stateStore = new StateStore(config.stateDir);
  const staleness = new StalenessDetector(config.staleDataThresholdMs);

  logger.info("bot başlatılıyor", {
    mode: config.mode,
    killSwitchActive: killSwitch.isActive(),
    dataStale: staleness.isStale(),
  });

  if (killSwitch.isActive()) {
    logger.warn("kill switch aktif — yeni risk alınmayacak", {
      file: config.killSwitchFile,
    });
  }

  // Henüz venue adaptörü yok (Faz 1): burada market data bağlantısı,
  // rekonsiliasyon ve OMS devreye girecek.
  stateStore.save("boot", { at: new Date().toISOString(), mode: config.mode });
  logger.info("iskelet hazır — venue adaptörü bekleniyor (Faz 1)");
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main();
}
