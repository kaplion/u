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

  it("GET / durum sayfasını döner — KILL SWITCH ve sparkline içerir", async () => {
    const { base } = await startDashboard();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("KILL SWITCH");
    // SSE bağlantısı
    expect(html).toContain("/events");
    // Sparkline için SVG DOM API kullanıldığını gösteren referans
    expect(html).toContain("SVG_NS");
    // Ham JSON bölümü
    expect(html).toContain("Ham JSON");
  });

  it("POST /kill kill switch dosyasını oluşturur — dışarıdan tetik", async () => {
    const { base, killSwitchFile } = await startDashboard();
    expect(existsSync(killSwitchFile)).toBe(false);
    const res = await fetch(`${base}/kill`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.killSwitch).toBe(true);
    expect(existsSync(killSwitchFile)).toBe(true);
    // KillSwitch da aynı dosyayı görür — yeni risk artık durur.
    expect(new KillSwitch(killSwitchFile).isActive()).toBe(true);
  });

  it("bilinmeyen yol 404 döner", async () => {
    const { base } = await startDashboard();
    const res = await fetch(`${base}/yok-boyle-bir-yol`);
    expect(res.status).toBe(404);
  });

  it("GET /events SSE akışı başlatır — text/event-stream ve ilk veri", async () => {
    const { base } = await startDashboard({ mode: "DRY_RUN", feedConnected: true });
    // fetch ile SSE stream'in ilk chunk'ını oku; tam stream'i beklemiyoruz
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // İlk veriyi chunk olarak oku
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // İlk iki chunk yeterli (yorum satırı + data satırı)
    for (let i = 0; i < 2; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    ac.abort();
    expect(text).toContain("data:");
    // Gelen veri geçerli JSON içermeli
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice(5).trim()) as Record<string, unknown>;
    expect(payload.mode).toBe("DRY_RUN");
  });
});
