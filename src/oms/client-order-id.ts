import { randomUUID } from "node:crypto";

/**
 * İstemci tarafında üretilmiş, deterministik olarak yeniden kullanılabilir
 * emir kimliği. Retry AYNI ID ile gider — çift emri önleyen şey budur.
 */
export function newClientOrderId(prefix = "bot"): string {
  return `${prefix}-${randomUUID()}`;
}
