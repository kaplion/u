import type { Logger } from "./logger.js";

export type AlertKind =
  | "ws_disconnected"
  | "ws_gap"
  | "reconciliation_deviation"
  | "kill_switch"
  | "stale_data"
  | "clock_drift"
  | "rate_limited"
  | "order_unknown"
  | "order_rejected"
  | "margin_warning"
  | "liquidation_buffer"
  | "daily_loss_limit"
  | "fatal";

export interface Alert {
  readonly kind: AlertKind;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Alarm kanalı — botun çalıştığı makineden bağımsız olmalı
 * (Telegram/Discord/e-posta implementasyonları bu arayüzü doldurur).
 */
export interface AlertChannel {
  send(alert: Alert): Promise<void> | void;
}

/**
 * Alarm yöneticisi. Her alarm loglanır (mod damgalı) ve tüm kanallara
 * dağıtılır. Kanal hatası botu ASLA düşürmez — alarm altyapısı arızası
 * işlem akışını durdurmamalı.
 */
export class AlertManager {
  constructor(
    private readonly logger: Logger,
    private readonly channels: readonly AlertChannel[] = [],
  ) {}

  raise(kind: AlertKind, msg: string, data?: Record<string, unknown>): void {
    this.logger.error(`ALARM [${kind}] ${msg}`, data);
    for (const channel of this.channels) {
      try {
        void Promise.resolve(channel.send({ kind, msg, ...(data !== undefined ? { data } : {}) })).catch(
          (err) => this.logger.warn("alarm kanalı hatası", { error: String(err) }),
        );
      } catch (err) {
        this.logger.warn("alarm kanalı hatası", { error: String(err) });
      }
    }
  }
}
