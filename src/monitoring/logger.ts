import type { Mode } from "../config/mode.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly mode: Mode;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

/**
 * Mod her log satırında görünür. Audit trail için JSON satır formatı.
 */
export class Logger {
  constructor(
    private readonly mode: Mode,
    private readonly sink: LogSink = (e) =>
      process.stdout.write(JSON.stringify(e) + "\n"),
  ) {}

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      mode: this.mode,
      msg,
      ...(data !== undefined ? { data } : {}),
    };
    this.sink(entry);
  }
}
