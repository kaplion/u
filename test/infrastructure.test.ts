import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state/state-store.js";
import { KillSwitch } from "../src/risk/kill-switch.js";
import { StalenessDetector } from "../src/market-data/staleness.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("kaydeder ve yükler", () => {
    const store = new StateStore(tempDir());
    store.save("positions", { BTCUSDT: 1.5 });
    expect(store.load("positions")).toEqual({ BTCUSDT: 1.5 });
  });

  it("olmayan anahtar için undefined döner", () => {
    const store = new StateStore(tempDir());
    expect(store.load("yok")).toBeUndefined();
  });

  it("geçersiz anahtarı reddeder (path traversal)", () => {
    const store = new StateStore(tempDir());
    expect(() => store.save("../evil", {})).toThrow(/Geçersiz state anahtarı/);
  });
});

describe("KillSwitch", () => {
  it("dosya varsa aktiftir", () => {
    const dir = tempDir();
    const file = join(dir, "KILL_SWITCH");
    const ks = new KillSwitch(file);
    expect(ks.isActive()).toBe(false);
    writeFileSync(file, "");
    expect(ks.isActive()).toBe(true);
  });
});

describe("StalenessDetector", () => {
  it("hiç veri gelmediyse bayattır", () => {
    const d = new StalenessDetector(1000, () => 0);
    expect(d.isStale()).toBe(true);
  });

  it("eşik aşılınca bayat sayar", () => {
    let now = 0;
    const d = new StalenessDetector(1000, () => now);
    d.onTick();
    now = 500;
    expect(d.isStale()).toBe(false);
    now = 1501;
    expect(d.isStale()).toBe(true);
  });
});
