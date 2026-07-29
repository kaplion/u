import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Kalıcı state store — restart'ta kurtarılabilir. Yazma atomiktir
 * (temp dosya + rename) ki çökme anında yarım dosya kalmasın.
 *
 * Not: Venue her zaman tek doğru kaynaktır; buradaki state açılışta
 * venue ile REKONSİLE edilir, asla tek başına doğru kabul edilmez.
 */
export class StateStore {
  constructor(private readonly dir: string) {}

  save<T>(key: string, value: T): void {
    const file = this.fileFor(key);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmp, file);
  }

  load<T>(key: string): T | undefined {
    const file = this.fileFor(key);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  private fileFor(key: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error(`Geçersiz state anahtarı: "${key}"`);
    }
    return join(this.dir, `${key}.json`);
  }
}
