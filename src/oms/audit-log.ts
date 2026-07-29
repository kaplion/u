import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mode } from "../config/mode.js";

export interface AuditEntry {
  readonly ts: string;
  readonly mode: Mode;
  readonly event: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Audit log: her emir, her fill, her karar — append-only, silinmez.
 * Her durum geçişi emir GÖNDERİLMEDEN ÖNCE buraya yazılır, sonra değil;
 * çökme anında bile "ne niyet edildiği" diskte durur.
 */
export class AuditLog {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly mode: Mode,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(stateDir, "audit.log");
  }

  record(event: string, data?: Record<string, unknown>): void {
    const entry: AuditEntry = {
      ts: new Date(this.now()).toISOString(),
      mode: this.mode,
      event,
      ...(data !== undefined ? { data } : {}),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    // Yalnızca ekleme — mevcut satırlar asla değiştirilmez/silinmez.
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
  }
}
