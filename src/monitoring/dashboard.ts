import { createServer, type Server, type ServerResponse } from "node:http";
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

// Tüm durum verisi textContent ile basılır — innerHTML ile veri enjekte edilmez.
const PAGE = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Dashboard</title>
<style>
:root{--bg:#111;--bg2:#1c1c1c;--bg3:#252525;--text:#eee;--muted:#888;--green:#22c55e;--yellow:#eab308;--red:#ef4444;--border:#2a2a2a;--mono:ui-monospace,'Cascadia Code',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);padding:1rem;min-height:100vh}
#alarm-band{display:none;background:var(--red);color:#fff;padding:.75rem 1rem;font-weight:700;text-align:center;border-radius:6px;margin-bottom:1rem;font-size:.95rem}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.topbar h1{font-size:1rem;font-weight:700;font-family:var(--mono)}
#conn-status{font-size:.75rem;color:var(--muted)}
h2{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin:1.25rem 0 .6rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.65rem;margin-bottom:.5rem}
.card{background:var(--bg2);border-radius:8px;padding:.9rem}
.card-label{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.35rem}
.card-value{font-size:1.35rem;font-family:var(--mono);word-break:break-all}
.badge{display:inline-flex;align-items:center;gap:.35rem;font-size:.78rem;padding:.18rem .55rem;border-radius:9999px;font-family:var(--mono)}
.g{background:rgba(34,197,94,.14);color:var(--green)}
.y{background:rgba(234,179,8,.14);color:var(--yellow)}
.r{background:rgba(239,68,68,.14);color:var(--red)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
.dg{background:var(--green)}.dy{background:var(--yellow)}.dr{background:var(--red)}
.price-card{background:var(--bg2);border-radius:8px;padding:.9rem}
.price-sym{font-size:.78rem;font-weight:600;color:var(--muted);margin-bottom:.2rem}
.price-val{font-size:1.55rem;font-family:var(--mono)}
.price-up{color:var(--green)}.price-dn{color:var(--red)}
.price-age{font-size:.68rem;color:var(--muted);margin-top:.15rem}
.sparkline{width:100%;height:38px;display:block;margin-top:.5rem}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}
td{padding:.45rem .5rem;border-bottom:1px solid #1e1e1e;font-family:var(--mono);font-size:.82rem}
.empty{color:var(--muted);font-size:.82rem;padding:.75rem 0}
.prog-row{margin-bottom:.65rem}
.prog-lbl{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:.28rem}
.prog-lbl span:last-child{font-family:var(--mono);color:var(--text)}
.prog-track{height:7px;background:#1e1e1e;border-radius:4px;overflow:hidden}
.prog-fill{height:100%;border-radius:4px;transition:width .4s}
.pok{background:var(--green)}.pwarn{background:var(--yellow)}.pdanger{background:var(--red)}
#kill{background:#7f1d1d;color:#fff;border:1px solid #b91c1c;padding:.65rem 1.4rem;border-radius:6px;cursor:pointer;font-size:.88rem;font-weight:600;margin-top:1.25rem}
#kill:hover:not(:disabled){background:#991b1b}
#kill:disabled{opacity:.5;cursor:not-allowed}
details{margin-top:1.5rem}
details summary{cursor:pointer;color:var(--muted);font-size:.78rem;padding:.4rem 0;user-select:none}
pre{background:var(--bg2);padding:.9rem;border-radius:6px;overflow:auto;font-size:.72rem;font-family:var(--mono);margin-top:.5rem;max-height:400px}
@media(max-width:480px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="alarm-band"></div>
<div class="topbar">
  <h1>Alim-Satim Botu</h1>
  <span id="conn-status">baglaniyor...</span>
</div>

<h2>Durum</h2>
<div class="grid" id="status-cards"></div>

<h2>Fiyatlar</h2>
<div class="grid" id="price-cards"></div>

<h2>Acik Emirler</h2>
<div id="orders-section"></div>

<h2>Risk Limitleri</h2>
<div id="risk-section"></div>

<h2>Strateji &amp; PnL</h2>
<div class="grid" id="pnl-cards"></div>

<button id="kill">&#9888; KILL SWITCH TETIKLE</button>

<details>
  <summary>Ham JSON</summary>
  <pre id="raw-json">yukleniyor...</pre>
</details>

<script>
(function(){
'use strict';

// Fiyat gecmisi: sembol -> sayi dizisi (sparkline icin)
var hist = {};
var MAX_H = 60;

// --- Bicimlendirme yardimcilari ---
function fmtPrice(n) {
  if (n === undefined || n === null) return '-';
  return new Intl.NumberFormat('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}).format(n);
}
function fmtUptime(ms) {
  if (!ms) return '-';
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  var d = Math.floor(h / 24);
  if (d > 0) return d + 'g ' + (h % 24) + 'sa';
  if (h > 0) return h + 'sa ' + (m % 60) + 'dk';
  if (m > 0) return m + 'dk ' + (s % 60) + 'sn';
  return s + 'sn';
}
function fmtPnl(n) {
  if (n === undefined || n === null) return '-';
  var sign = n >= 0 ? '+' : '';
  return sign + new Intl.NumberFormat('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}).format(n);
}
function fmtNum(n) {
  if (n === undefined || n === null) return '-';
  return new Intl.NumberFormat('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}).format(n);
}
function pct(a, b) {
  if (!b) return 0;
  return Math.min(1, Math.max(0, a / b));
}

// --- DOM yardimcilari ---
function mk(tag, cls) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function txt(s) { return document.createTextNode(String(s !== undefined && s !== null ? s : '-')); }
function clr(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// --- Rozet olusturucu ---
function makeBadge(active, trueLabel, falseLabel, warnOnTrue) {
  var span = mk('span', 'badge ' + (active ? (warnOnTrue ? 'r' : 'g') : (warnOnTrue ? 'g' : 'r')));
  var dot = mk('span', 'dot ' + (active ? (warnOnTrue ? 'dr' : 'dg') : (warnOnTrue ? 'dg' : 'dr')));
  span.appendChild(dot);
  span.appendChild(txt(active ? trueLabel : falseLabel));
  return span;
}

// --- Sparkline SVG (DOM API, innerHTML yok) ---
var SVG_NS = 'http://www.w3.org/2000/svg';
function makeSparkline(prices) {
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 38');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'sparkline');
  if (prices.length < 2) return svg;
  var w = 200, h = 38, pad = 2;
  var mn = prices[0], mx = prices[0];
  for (var i = 1; i < prices.length; i++) {
    if (prices[i] < mn) mn = prices[i];
    if (prices[i] > mx) mx = prices[i];
  }
  var rng = (mx - mn) || 1;
  var pts = '';
  for (var j = 0; j < prices.length; j++) {
    var x = (pad + (j / (prices.length - 1)) * (w - pad * 2)).toFixed(1);
    var y = (h - pad - ((prices[j] - mn) / rng) * (h - pad * 2)).toFixed(1);
    if (j > 0) pts += ' ';
    pts += x + ',' + y;
  }
  var last = prices[prices.length - 1];
  var prev = prices[prices.length - 2];
  var color = last >= prev ? '#22c55e' : '#ef4444';
  var poly = document.createElementNS(SVG_NS, 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);
  return svg;
}

// --- Durum karti olusturucu ---
function makeCard(label, valueEl) {
  var card = mk('div', 'card');
  var lbl = mk('div', 'card-label');
  lbl.appendChild(txt(label));
  card.appendChild(lbl);
  var val = mk('div', 'card-value');
  val.appendChild(valueEl);
  card.appendChild(val);
  return card;
}

// --- Ilerleme cubugu ---
function makeProgress(label, current, max, unit) {
  var row = mk('div', 'prog-row');
  var lbl = mk('div', 'prog-lbl');
  var leftSpan = mk('span');
  leftSpan.appendChild(txt(label));
  var rightSpan = mk('span');
  rightSpan.appendChild(txt(fmtNum(current) + (unit ? ' / ' + fmtNum(max) + ' ' + unit : ' / ' + fmtNum(max))));
  lbl.appendChild(leftSpan);
  lbl.appendChild(rightSpan);
  var track = mk('div', 'prog-track');
  var fill = mk('div', 'prog-fill');
  var ratio = pct(current, max);
  fill.style.width = (ratio * 100).toFixed(1) + '%';
  fill.className = 'prog-fill ' + (ratio >= 1 ? 'pdanger' : ratio >= 0.75 ? 'pwarn' : 'pok');
  track.appendChild(fill);
  row.appendChild(lbl);
  row.appendChild(track);
  return row;
}

// --- Ana render fonksiyonu ---
function render(data) {
  // Alarm bandi
  var band = document.getElementById('alarm-band');
  if (data.killSwitchActive || data.reconcileHalted) {
    band.style.display = 'block';
    var msgs = [];
    if (data.killSwitchActive) msgs.push('KILL SWITCH AKTIF');
    if (data.reconcileHalted) msgs.push('REKONSILIASYON DURDU');
    band.textContent = '\u26A0 ' + msgs.join(' | ');
  } else {
    band.style.display = 'none';
    band.textContent = '';
  }

  // Durum kartlari
  var sc = document.getElementById('status-cards');
  clr(sc);

  var modTxt = mk('span');
  modTxt.appendChild(txt(data.mode || '-'));
  sc.appendChild(makeCard('Mod', modTxt));

  var venueTxt = mk('span');
  venueTxt.appendChild(txt(data.venue || '-'));
  sc.appendChild(makeCard('Venue', venueTxt));

  var uptimeTxt = mk('span');
  uptimeTxt.appendChild(txt(fmtUptime(data.uptimeMs)));
  sc.appendChild(makeCard('Uptime', uptimeTxt));

  sc.appendChild(makeCard('Feed', makeBadge(data.feedConnected, 'Bagli', 'Kopuk', false)));
  sc.appendChild(makeCard('Veri', makeBadge(!data.dataStale, 'Taze', 'Bayat', false)));
  sc.appendChild(makeCard('Kill Switch', makeBadge(data.killSwitchActive, 'AKTIF', 'Pasif', true)));
  sc.appendChild(makeCard('Rekonsiliasyon', makeBadge(!data.reconcileHalted, 'Normal', 'DURDU', false)));

  // Fiyat kartlari
  var pc = document.getElementById('price-cards');
  clr(pc);
  var prices = data.prices || {};
  var syms = Object.keys(prices);
  if (syms.length === 0) {
    var noPrice = mk('div', 'empty');
    noPrice.appendChild(txt('Fiyat verisi yok'));
    pc.appendChild(noPrice);
  } else {
    for (var si = 0; si < syms.length; si++) {
      var sym = syms[si];
      var price = prices[sym];
      if (!hist[sym]) hist[sym] = [];
      var prevPrice = hist[sym].length > 0 ? hist[sym][hist[sym].length - 1] : undefined;
      hist[sym].push(price);
      if (hist[sym].length > MAX_H) hist[sym].shift();

      var card = mk('div', 'price-card');
      var symDiv = mk('div', 'price-sym');
      symDiv.appendChild(txt(sym));
      var priceDiv = mk('div', 'price-val');
      if (prevPrice !== undefined) {
        priceDiv.classList.add(price > prevPrice ? 'price-up' : price < prevPrice ? 'price-dn' : '');
        var arrow = price > prevPrice ? ' \u25B2' : price < prevPrice ? ' \u25BC' : '';
        priceDiv.appendChild(txt(fmtPrice(price) + arrow));
      } else {
        priceDiv.appendChild(txt(fmtPrice(price)));
      }
      card.appendChild(symDiv);
      card.appendChild(priceDiv);
      card.appendChild(makeSparkline(hist[sym]));
      pc.appendChild(card);
    }
  }

  // Acik emirler tablosu
  var os = document.getElementById('orders-section');
  clr(os);
  var orders = Array.isArray(data.openOrders) ? data.openOrders : [];
  if (orders.length === 0) {
    var noOrders = mk('div', 'empty');
    noOrders.appendChild(txt('Acik emir yok'));
    os.appendChild(noOrders);
  } else {
    var tbl = mk('table');
    var thead = mk('thead');
    var hrow = mk('tr');
    ['ID', 'Sembol', 'Yon', 'Miktar', 'Fiyat', 'Durum'].forEach(function(h) {
      var th = mk('th');
      th.appendChild(txt(h));
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    tbl.appendChild(thead);
    var tbody = mk('tbody');
    for (var oi = 0; oi < orders.length; oi++) {
      var o = orders[oi];
      var row = mk('tr');
      [o.clientOrderId || o.id || '-', o.symbol || '-', o.side || '-',
       fmtNum(o.qty || o.quantity), fmtPrice(o.price), o.status || '-'].forEach(function(v) {
        var td = mk('td');
        td.appendChild(txt(v));
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
    tbl.appendChild(tbody);
    os.appendChild(tbl);
  }

  // Risk limitleri
  var rs = document.getElementById('risk-section');
  clr(rs);
  var hl = data.hardLimits || {};
  var dl = data.dailyLoss || 0;
  var grossPos = 0;
  try {
    var posVals = Object.values(data.positions || {});
    for (var pi = 0; pi < posVals.length; pi++) {
      var pv = posVals[pi];
      if (pv && typeof pv === 'object' && typeof pv.notional === 'number') grossPos += Math.abs(pv.notional);
    }
  } catch(e) {}

  if (hl.maxDailyLoss) rs.appendChild(makeProgress('Gunluk Zarar', dl, hl.maxDailyLoss, 'USD'));
  if (hl.maxGrossNotional) rs.appendChild(makeProgress('Brut Notional', grossPos, hl.maxGrossNotional, 'USD'));
  if (!hl.maxDailyLoss && !hl.maxGrossNotional) {
    var noRisk = mk('div', 'empty');
    noRisk.appendChild(txt('Risk verisi yok'));
    rs.appendChild(noRisk);
  }

  // PnL kartlari
  var pnlC = document.getElementById('pnl-cards');
  clr(pnlC);

  var stratName = mk('span');
  var sname = (data.strategy && data.strategy.name) ? data.strategy.name : '-';
  stratName.appendChild(txt(sname));
  pnlC.appendChild(makeCard('Strateji', stratName));

  var realPnl = typeof data.realizedPnl === 'number' ? data.realizedPnl : null;
  var pnlSpan = mk('span');
  pnlSpan.style.color = realPnl === null ? '' : (realPnl >= 0 ? '#22c55e' : '#ef4444');
  pnlSpan.appendChild(txt(realPnl !== null ? fmtPnl(realPnl) + ' USD' : '-'));
  pnlC.appendChild(makeCard('Gerceklesen PnL', pnlSpan));

  var dlVal = typeof data.dailyLoss === 'number' ? data.dailyLoss : null;
  var dlSpan = mk('span');
  dlSpan.style.color = dlVal === null ? '' : (dlVal > 0 ? '#ef4444' : '#22c55e');
  dlSpan.appendChild(txt(dlVal !== null ? fmtNum(dlVal) + ' USD' : '-'));
  pnlC.appendChild(makeCard('Gunluk Zarar', dlSpan));

  if (data.strategy && data.strategy.validation) {
    var vStr = '';
    try { vStr = JSON.stringify(data.strategy.validation); } catch(e) { vStr = String(data.strategy.validation); }
    var vSpan = mk('span');
    vSpan.style.fontSize = '.85rem';
    vSpan.appendChild(txt(vStr));
    pnlC.appendChild(makeCard('Validasyon', vSpan));
  }

  // Kill switch butonu
  var killBtn = document.getElementById('kill');
  if (data.killSwitchActive) {
    killBtn.disabled = true;
    killBtn.textContent = '\u2713 KILL SWITCH AKTIF';
  }

  // Ham JSON
  document.getElementById('raw-json').textContent = JSON.stringify(data, null, 2);
}

// --- Baglanti durumu ---
function setConnStatus(msg, ok) {
  var el = document.getElementById('conn-status');
  el.textContent = msg;
  el.style.color = ok ? '#22c55e' : '#888';
}

// --- Kill switch ---
document.getElementById('kill').addEventListener('click', function() {
  if (!confirm('Kill switch tetiklensin mi? Yeni risk durur.')) return;
  fetch('/kill', {method:'POST'}).then(function(r) {
    if (r.ok) {
      var btn = document.getElementById('kill');
      btn.disabled = true;
      btn.textContent = '\u2713 KILL SWITCH AKTIF';
    }
  });
});

// --- SSE + polling ---
var pollTimer = null;

function startPolling() {
  function poll() {
    fetch('/status').then(function(r) { return r.json(); }).then(function(d) {
      render(d);
    }).catch(function() {
      setConnStatus('baglanti hatasi', false);
    });
  }
  poll();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 5000);
  setConnStatus('polling (5sn)', false);
}

function startSSE() {
  try {
    var es = new EventSource('/events');
    es.onopen = function() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      setConnStatus('\u25CF canli', true);
    };
    es.onmessage = function(e) {
      try { render(JSON.parse(e.data)); } catch(ex) {}
    };
    es.onerror = function() {
      es.close();
      setConnStatus('SSE koptu — polling', false);
      startPolling();
    };
  } catch(ex) {
    startPolling();
  }
}

startSSE();
})();
</script>
</body>
</html>
`;

/**
 * Faz 7 — izleme dashboard'u. Görmediğin bot, çalışmayan bottur.
 * - GET /        : durum sayfası (statik HTML; veri /status'tan çekilir,
 *                  textContent ile basılır — HTML enjeksiyonu yok)
 * - GET /status  : mod damgalı durum JSON'u (heartbeat, feed, PnL, emirler)
 * - GET /events  : Server-Sent Events akışı; bağlantı koparsa polling'e düşer
 * - POST /kill   : kill switch dosyasını oluşturur — DIŞARIDAN tetik
 */
export class Dashboard {
  private server: Server | undefined;
  private readonly host: string;
  private sseClients: ServerResponse[] = [];
  private sseTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: DashboardOptions) {
    this.host = opts.host ?? "127.0.0.1";
  }

  /** Sunucuyu başlat; gerçek portu döner (port=0 → işletim sistemi seçer). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const method = req.method ?? "GET";
        const path = (req.url ?? "/").split("?")[0];

        // SSE akışı — streaming yanıt, handle() callback'ine uymaz
        if (method === "GET" && path === "/events") {
          this.handleSSE(res);
          return;
        }

        try {
          this.handle(method, req.url ?? "/", (status, type, body) => {
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
        const port =
          typeof address === "object" && address !== null ? address.port : this.opts.port;
        this.opts.logger.info("dashboard ayakta", { host: this.host, port });
        // SSE yayın zamanlayıcısı — her 2 saniyede bağlı istemcilere durum gönder
        this.sseTimer = setInterval(() => {
          this.broadcastStatus();
        }, 2000);
        resolve(port);
      });
      this.server = server;
    });
  }

  stop(): Promise<void> {
    if (this.sseTimer !== undefined) {
      clearInterval(this.sseTimer);
      this.sseTimer = undefined;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // bağlantı zaten kapanmış olabilir
      }
    }
    this.sseClients = [];
    return new Promise((resolve) => {
      if (this.server === undefined) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  /** SSE istemcisi kaydet ve bağlantı kesilince listeden çıkar. */
  private handleSSE(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": bağlandı\n\n");

    // İlk veriyi hemen gönder
    const data = JSON.stringify(this.opts.statusProvider());
    res.write(`data: ${data}\n\n`);

    this.sseClients.push(res);

    res.on("close", () => {
      const idx = this.sseClients.indexOf(res);
      if (idx !== -1) this.sseClients.splice(idx, 1);
    });
  }

  /** Tüm bağlı SSE istemcilerine güncel durum yayınla. */
  private broadcastStatus(): void {
    if (this.sseClients.length === 0) return;
    const data = JSON.stringify(this.opts.statusProvider());
    const msg = `data: ${data}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        client.write(msg);
      } catch {
        // İstemci bağlantısı kopmuşsa close eventi zaten listeden çıkarır
      }
    }
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
