import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Dashboard } from "../src/monitoring/dashboard.js";
import { Logger } from "../src/monitoring/logger.js";
import { KillSwitch } from "../src/risk/kill-switch.js";

const silentLogger = new Logger("PAPER", () => {});

const dirs: string[] = [];
const dashboards: Dashboard[] = [];

afterEach(async () => {
  for (const d of dashboards.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startDashboard(status: Record<string, unknown> = { mode: "PAPER", ok: true }) {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  dirs.push(dir);
  const killSwitchFile = join(dir, "KILL_SWITCH");
  const dashboard = new Dashboard({
    port: 0, // işletim sistemi seçer — test çakışması yok
    statusProvider: () => status,
    killSwitchFile,
    logger: silentLogger,
  });
  dashboards.push(dashboard);
  const port = await dashboard.start();
  return { port, killSwitchFile, base: `http://127.0.0.1:${port}` };
}

describe("Faz 7 — dashboard", () => {
  it("GET /status mod damgalı durum JSON'u döner", async () => {
    const { base } = await startDashboard({ mode: "PAPER", feedConnected: true });
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("PAPER"); // mod her yerde görünür
    expect(body.feedConnected).toBe(true);
  });

  it("GET / durum sayfasını döner", async () => {
    const { base } = await startDashboard();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("KILL SWITCH");
  });

  it("POST /kill kill switch dosyasını oluşturur — dışarıdan tetik", async () => {
    const { base, killSwitchFile } = await startDashboard();
    expect(existsSync(killSwitchFile)).toBe(false);
    const res = await fetch(`${base}/kill`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(existsSync(killSwitchFile)).toBe(true);
    // KillSwitch da aynı dosyayı görür — yeni risk artık durur.
    expect(new KillSwitch(killSwitchFile).isActive()).toBe(true);
  });

  it("bilinmeyen yol 404 döner", async () => {
    const { base } = await startDashboard();
    const res = await fetch(`${base}/yok-boyle-bir-yol`);
    expect(res.status).toBe(404);
  });
});
