import { existsSync } from "node:fs";

/**
 * Kill switch DIŞARIDAN tetiklenebilir: bir dosyanın varlığı yeterlidir.
 * Tetiklendiğinde yeni riske izin verilmez ama pozisyon azaltan emirler
 * geçer (risk kapısında uygulanır).
 */
export class KillSwitch {
  constructor(private readonly filePath: string) {}

  isActive(): boolean {
    return existsSync(this.filePath);
  }
}
