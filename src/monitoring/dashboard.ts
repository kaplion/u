import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import type { Logger } from "./logger.js";

export type StatusProvider = () => Record<string, unknown>;

export interface DashboardOptions {
  /** Varsayılan yalnızca loopback — dışa açmak bilinçli bir karar olmalı. */
  readonly host?: string;
  readonly port: number;
  readonly statusProvider: StatusProvider;
  /** POST /kill bu dosyayı oluşturur — spec'teki HTTP kill switch tetiği. */
  readonly killSwitchFile: string;
  readonly logger: Logger;
}

const PAGE = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>Bot Dashboard</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 2rem; background: #111; color: #eee; }
  h1 { font-size: 1.2rem; }
  pre { background: #1c1c1c; padding: 1rem; border-radius: 6px; overflow: auto; }
  button { background: #a00; color: #fff; border: 0; padding: .6rem 1rem; border-radius: 6px; cursor: pointer; }
</style>
</head>
<body>
<h1>Otomatik Alım-Satım Botu — Durum</h1>
<pre id="status">yükleniyor…</pre>
<button id="kill">KILL SWITCH TETİKLE</button>
<script>
  async function refresh() {
    try {
      const res = await fetch("/status");
      const data = await res.json();
      document.getElementById("status").textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      document.getElementById("status").textContent = "durum alınamadı: " + err;
    }
  }
  document.getElementById("kill").addEventListener("click", async () => {
    if (!confirm("Kill switch tetiklensin mi? Yeni risk durur.")) return;
    await fetch("/kill", { method: "POST" });
    refresh();
  });
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>
`;

/**
 * Faz 7 — izleme dashboard'u. Görmediğin bot, çalışmayan bottur.
 * - GET /        : durum sayfası (statik HTML; veri /status'tan çekilir,
 *                  textContent ile basılır — HTML enjeksiyonu yok)
 * - GET /status  : mod damgalı durum JSON'u (heartbeat, feed, PnL, emirler)
 * - POST /kill   : kill switch dosyasını oluşturur — DIŞARIDAN tetik
 */
export class Dashboard {
  private server: Server | undefined;
  private readonly host: string;

  constructor(private readonly opts: DashboardOptions) {
    this.host = opts.host ?? "127.0.0.1";
  }

  /** Sunucuyu başlat; gerçek portu döner (port=0 → işletim sistemi seçer). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        try {
          this.handle(req.method ?? "GET", req.url ?? "/", (status, type, body) => {
            res.writeHead(status, { "Content-Type": type });
            res.end(body);
          });
        } catch (err) {
          this.opts.logger.error("dashboard isteği başarısız", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      });
      server.once("error", reject);
      server.listen(this.opts.port, this.host, () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : this.opts.port;
        this.opts.logger.info("dashboard ayakta", { host: this.host, port });
        resolve(port);
      });
      this.server = server;
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === undefined) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  private handle(
    method: string,
    url: string,
    send: (status: number, type: string, body: string) => void,
  ): void {
    const path = url.split("?")[0];
    if (method === "GET" && path === "/") {
      send(200, "text/html; charset=utf-8", PAGE);
      return;
    }
    if (method === "GET" && path === "/status") {
      send(200, "application/json", JSON.stringify(this.opts.statusProvider()));
      return;
    }
    if (method === "POST" && path === "/kill") {
      writeFileSync(this.opts.killSwitchFile, `dashboard tetiği: ${new Date().toISOString()}\n`);
      this.opts.logger.warn("kill switch DASHBOARD üzerinden tetiklendi", {
        file: this.opts.killSwitchFile,
      });
      send(200, "application/json", JSON.stringify({ killSwitch: true }));
      return;
    }
    send(404, "application/json", JSON.stringify({ error: "not found" }));
  }
}
