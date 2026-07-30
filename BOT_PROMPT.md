# Prompt: Otomatik Alım-Satım Botu (ABD Hisse · Kripto · Forex)

> Kullanım: bloğu Claude Code'a ver. Faz faz çalıştır.
> Araştırma-önce versiyon için bkz. `PROMPT.md` — bu dosya onun canlı icra
> odaklı karşılığıdır.

---

## ROL VE HEDEF

Kendi sermayem için, denetimsiz çalışan, çok varlıklı otomatik alım-satım
sistemi kuruyorsun. Sistem 7/24 ayakta kalacak, kendi kendini toparlayacak ve
ben uyurken benim adıma emir gönderecek.

Bu, backtest kodu değil. **Canlı sistemin problemleri tamamen farklıdır** ve
backtest bunların hiçbirini göstermez: bağlantı kopar, emir yarım dolar,
process çöker, borsa bakıma girer, veri akışı sessizce durur. Bir botu
öldüren şey neredeyse hiçbir zaman strateji mantığı değil, bu operasyonel
kenar durumlarıdır.

Öncelik sırası: **önce kaybetmemek, sonra kazanmak.** Hatalı çalışan bir bot,
hiç çalışmayan bir bottan çok daha pahalıdır.

## SİSTEM MİMARİSİ

```
┌──────────────────────────────────────────────────────────────┐
│ MARKET DATA          WebSocket + REST snapshot               │
│                      heartbeat · gap doldurma · bayatlık algısı│
├──────────────────────────────────────────────────────────────┤
│ STRATEJİ RUNTIME     sinyal → hedef pozisyon                  │
├──────────────────────────────────────────────────────────────┤
│ RİSK KAPISI          sert limitler · kill switch · sanity     │
│                      (stratejiyi EZER, atlanamaz)             │
├──────────────────────────────────────────────────────────────┤
│ OMS                  emir yaşam döngüsü · idempotency         │
│                      kısmi dolum · retry · timeout            │
├──────────────────────────────────────────────────────────────┤
│ VENUE ADAPTÖRLERİ    Binance · Alpaca · IG                    │
│                      her venue'nin emir semantiği farklı      │
├──────────────────────────────────────────────────────────────┤
│ STATE STORE          kalıcı · restart'ta kurtarılabilir       │
│                      ↑ REKONSİLİASYON: venue tek doğru kaynak │
├──────────────────────────────────────────────────────────────┤
│ İZLEME               metrik · alarm · audit log               │
└──────────────────────────────────────────────────────────────┘
```

## CANLI SİSTEMİ ÖLDÜREN 12 ŞEY

Bunların her biri için açık bir çözüm implemente et ve testle kanıtla.
Backtest bunların hiçbirini yakalamaz.

**1. Rekonsiliasyon kayması.** Bot 1.5 BTC'si olduğunu sanır, borsa 1.2 der.
Kaçırılan fill, sayılan ama reddedilen emir, restart — hepsi buna yol açar.
**Venue her zaman tek doğru kaynaktır.** Periyodik (≤60sn) ve her restart'ta
pozisyon + açık emir + bakiye rekonsiliasyonu yap. Sapma varsa işlemi durdur
ve alarm ver, tahminle devam etme.

**2. Çift emir / idempotency.** Timeout aldın — emir gitti mi bilmiyorsun.
Retry edersen iki pozisyonun olur. Çözüm: her emir için **istemci tarafında
üretilmiş `clientOrderId`**. Retry aynı ID ile gider. Reconnect'te önce açık
emirleri sorgula, sonra emir gönder.

**3. Restart sonrası durum kurtarma.** Bot gece 3'te çöktü. Açılışta
pozisyonları, açık emirleri ve niyetini yeniden kurmalı. **Asla "düz
pozisyondayım" varsayma.** Açılış sırası: state yükle → venue'dan gerçeği çek
→ karşılaştır → uyuşmuyorsa dur ve alarm ver.

**4. Kısmi dolum.** 10 birim istedin, 3 doldu. Strateji "istediğimden azını
aldım" durumunu ele almalı. Kalanı kovala mı, iptal mi et, yeniden fiyatla mı
— karar açıkça yazılmalı, sessizce görmezden gelinmemeli.

**5. Bayat veri.** Feed sessizleşti ama bağlantı açık görünüyor. Bot son
bilinen fiyattan işlem yapmaya devam ederse felaket olur. **Heartbeat +
bayatlık eşiği** (örn. beklenen aralığın 3 katı) → eşik aşılırsa yeni emir
yok, mevcut pozisyon için karar kuralı belirle.

**6. WebSocket kopması ve boşluk.** Reconnect'te REST snapshot ile resync et,
kaldığın yerden devam ettiğini varsayma. Sequence number varsa boşluğu tespit
et.

**7. Rate limit.** Ağırlık bazlı sayaç tut, 429/418'de exponential backoff.
Ban yemek botun günlerce durması demektir.

**8. Saat kayması.** Binance zaman damgası sapan emri reddeder. NTP senkronu
ve venue `serverTime` ile periyodik drift kontrolü.

**9. Fat finger / sanity.** Emir göndermeden önce: max emir büyüklüğü, max
notional, **fiyat aklı başındalık kontrolü** (son fiyattan %X uzaktaki emri
reddet). Bir hesaplama hatası tüm sermayeyi tek emirde riske atmamalı.

**10. Kill switch.** İçeriden tetiklenen yetmez. **Dışarıdan** tetiklenebilmeli:
bir dosyanın varlığı, bir HTTP endpoint'i veya sinyal. Tetiklendiğinde yeni
riske izin verme ama **pozisyon azaltan emirleri geçir** — aksi halde seni en
kötü anda içeride kilitler.

**11. Likidasyon yakınlığı** (kaldıraçlı kripto). Likidasyon fiyatını sürekli
hesapla ve belirlenen tampona girilince kendiliğinden pozisyon küçült.
Borsanın seni likide etmesini bekleme.

**12. Borsa bakımı / kesinti.** Tam da volatilitede olur. Bakım penceresini
tespit et, o sırada emir gönderme, açıldığında rekonsiliasyon yap.

## OMS — EMİR YAŞAM DÖNGÜSÜ

Emir bir durum makinesidir, "gönder ve unut" değil:

```
PENDING_NEW → NEW → PARTIALLY_FILLED → FILLED
                 ↘ REJECTED
                 ↘ CANCELED
                 ↘ EXPIRED
      ↘ UNKNOWN  (timeout — venue'ya sorulmalı, varsayılmamalı)
```

- Her durum geçişi kalıcı olarak loglanır (audit trail)
- `UNKNOWN` özel durumdur: emir gitmiş de olabilir gitmemiş de. **Asla
  varsayma** — venue'ya `clientOrderId` ile sor.
- Her emir gönderilmeden ÖNCE loglanır, sonra değil
- Timeout'lu emirler için reconcile kuyruğu

## RİSK VE GÜVENLİK KATMANI

Stratejiden bağımsız ve onu ezer. Atlanabilir bir yolu olmamalı.

**Sert limitler (kod içinde, config'de değil):**
- Sembol başına max notional
- Toplam brüt pozisyon / kaldıraç tavanı
- Günlük max zarar → aşılırsa gün kapanır
- Max drawdown → kalıcı kill switch
- Bar/dakika başına max emir sayısı (döngü koruması)

**API anahtarı kuralları — bunlar kodun bir parçası olmalı, tavsiye değil:**
- Yalnızca **işlem izni**. Çekim (withdrawal) izni ASLA verilmez.
- IP whitelist zorunlu
- Anahtarlar environment/secret manager'da; repoda, logda, hata mesajında asla
- Başlangıçta anahtarın çekim izni olup olmadığını sorgula, varsa **başlatma**

**Mod ayrımı:**
- `DRY_RUN` — emir üretir, göndermez, loglar
- `PAPER` — venue'nun testnet/paper ortamı
- `LIVE` — gerçek para
- Mod her log satırında ve her alarmda görünür. Karıştırılması imkânsız olmalı.

## VENUE ADAPTÖRLERİ

Ortak arayüz, ama emir semantiği venue'den venue'ye gerçekten farklı.
Soyutlama şunları gizlememeli: `POST_ONLY`, `REDUCE_ONLY`, `IOC/FOK`,
minimum notional, tick/lot kuantizasyonu.

### ABD Hisse (Alpaca / IBKR)
- **Piyasa saatleri zorunluluğu** — seans dışında emir gönderme. Uzatılmış
  seans ayrı bayrak ister.
- NYSE takvimi: tatiller + yarım günler
- **PDT kuralı** — hesap < $25k ise 5 iş gününde 3 gün-içi işlem. Botun kendisi
  saymalı ve sınırı aşmamalı.
- **LULD halt** — durdurulmuş sembolde emir reddedilir, ele al
- Açığa satış: locate + borç maliyeti
- T+1 takas, alım gücü hesabı
- Açılış/kapanış açık artırması ayrı likidite rejimi

### Kripto (Binance / Bybit / OKX)
- Perp vs spot: marjin mekaniği farklı
- **Funding zamanlaması** — pozisyonu funding anında taşımak ödeme demektir
- Likidasyon fiyatı takibi (yukarıda madde 11)
- Çıkış emirlerinde `reduceOnly` kullan — yanlışlıkla ters pozisyon açmayı önler
- Venue parçalanması: fiyat borsadan borsaya farklı

### Forex (IG)
- **Hafta sonu kapanışı** — Cuma 17:00 ET. Pozisyon taşıyacaksan gap riskini
  kabul ediyorsun demektir; karar açıkça yazılsın.
- **Rollover 17:00 ET**, Çarşamba üç katı
- **Spread genişlemesi** — rollover ve haber anında piyasa emri gönderme
- Pip değeri ve ondalık konvansiyonu paritye göre değişir (JPY 2-3, diğerleri 4-5)
- Kaldıraç limitleri yargı bölgesine göre

## DİL AYRIMI

- **TypeScript / Node.js** — canlı runtime: market data, OMS, venue
  adaptörleri, risk kapısı, API. Async I/O ve WebSocket yönetimi için doğru araç.
- **Python** — strateji araştırma, backtest, istatistik, kalibrasyon. Sinyal
  parametreleri buradan üretilir.

**Sınır kuralı:** Strateji mantığının tek bir kaynağı olmalı. İki dilde iki
implementasyon kaçınılmaz olarak ayrışır ve farkı canlıda para kaybederek
öğrenirsin. Tercih sırası:

1. Python yalnızca parametre/model üretir (dosya veya servis), karar mantığı
   TypeScript'te tek yerde durur — **önerilen**
2. Strateji deklaratif şemayla tanımlanır, iki runtime aynı şemayı yorumlar
3. İki implementasyon da tutulur ama CI'da **parite testi** aynı girdiye aynı
   emri ürettiklerini kanıtlar

## STRATEJİ KAYNAĞI

Bot ancak doğrulanmış bir strateji işleyebilir. Backtest'te iyi görünmek yeterli
değildir — parametre taramasından çıkan "en iyi" varyantın çoğu zaman gerçek
edge'i yoktur.

Minimum: canlıya çıkacak her strateji için **Deflated Sharpe** (kaç varyant
denendiği hesaba katılmış) ve **PBO** raporu üretilmeli. Bu rakamlar botun
config'inde ve dashboard'unda görünsün — böyle bir stratejiyi neye dayanarak
çalıştırdığını her an bilirsin.

**LLM'i karar mercii yapma.** Doğru yeri: yapısız veriyi sayıya çevirmek
(duyurular, ekonomik takvim, filing'ler), işlem sonrası atribüsyon raporu
yazmak, anomali açıklamak. Grafiğe bakıp long/short demek çalışmıyor ve
saniyeler mertebesindeki gecikmesi zaten çoğu stratejiyi geçersiz kılar.

## İZLEME VE ALARM

Görmediğin bot, çalışmayan bottur.

- **Heartbeat** — bot ayakta mı, feed akıyor mu (dışarıdan izlenebilir)
- **Alarm koşulları:** bağlantı koptu, rekonsiliasyon sapması, kill switch
  tetiklendi, günlük zarar eşiği, emir reddi oranı arttı, likidasyon tamponu
- **Kanal:** Telegram/Discord/e-posta — botun çalıştığı makineden bağımsız
- **Audit log:** her emir, her fill, her karar; append-only, silinmez
- **Günlük özet:** PnL, işlem sayısı, maliyet, sapmalar

## DAĞITIM

- Container'lı, otomatik restart (systemd/Docker restart policy)
- Restart döngüsü koruması: N kez üst üste çökerse durdur ve alarm ver
- Sırlar environment/secret manager'da
- Kalıcı state için volume — restart'ta kaybolmamalı
- Zaman senkronu (NTP) zorunlu
- Log rotasyonu

## FAZLAR

Her fazın sonunda dur, testleri çalıştır, sonucu raporla.

**Faz 1 — Çekirdek runtime (TypeScript), tek venue (Binance testnet)**
Market data + WebSocket yönetimi + state store + rekonsiliasyon. Strateji yok,
emir yok. Sadece: bağlan, veriyi al, durumu tut, kopunca toparlan.

**Faz 2 — OMS + risk kapısı, `DRY_RUN`**
Emir yaşam döngüsü, idempotency, kısmi dolum, sert limitler, kill switch.
Emirler üretilir ve loglanır ama gönderilmez.

**Faz 3 — Kaos testleri**
Faz 4'ten önce zorunlu. Aşağıdaki kabul kriterlerinin hepsi geçmeli.

**Faz 4 — `PAPER` mod, gerçek testnet emirleri**
En az 2 hafta kesintisiz. Rekonsiliasyon sapması sıfır olmalı.

**Faz 5 — Çoklu venue (hisse + forex)**
Adaptör soyutlamasının gerçekten soyut olup olmadığını burada öğrenirsin:
Binance (crypto), Alpaca (ABD hissesi) ve IG (forex) aynı OMS/risk/runtime
zincirinden geçer.

**Faz 6 — `LIVE`, kanarya boyut**
Kaybetmeyi göze aldığın miktarın küçük bir kısmıyla. Ölçek ancak paper ile
canlı sonuçlar uyuştuktan sonra artar.

**Faz 7 — İzleme dashboard'u**

## KABUL KRİTERLERİ — KAOS TESTLERİ

Bir bot ancak bunları geçerse canlıya çıkabilir. Hepsi otomatik test olmalı:

| Test | Senaryo | Beklenen |
|---|---|---|
| Restart kurtarma | Emir gönderilirken process öldür, yeniden başlat | Çift emir YOK, durum venue ile uyuşur |
| Idempotency | Aynı `clientOrderId` ile iki kez gönder | Tek emir oluşur |
| Timeout belirsizliği | Emir gönder, cevabı düşür | `UNKNOWN` durumuna geçer, venue'ya sorar, varsaymaz |
| WS kopması | Bağlantıyı zorla kes | Reconnect + REST resync, boşluk tespit edilir |
| Bayat veri | Feed'i sessizleştir | Eşik aşılınca yeni emir durur, alarm çıkar |
| Kısmi dolum | %30 dolum simüle et | Kalan miktar açıkça ele alınır, sessizce yutulmaz |
| Emir reddi | Venue reddi simüle et | Durum doğru güncellenir, sonsuz retry yok |
| Rate limit | 429 döndür | Backoff uygulanır, ban yenmez |
| Kill switch | Dışarıdan tetikle | Yeni risk durur, azaltan emir geçer |
| Rekonsiliasyon sapması | Venue pozisyonunu farklı göster | Bot durur ve alarm verir, tahminle devam etmez |
| Fiyat sanity | Son fiyattan %50 uzak emir üret | Reddedilir |
| Çekim izni | Çekim izinli anahtar ver | Başlatmayı reddeder |
| Likidasyon tamponu | Fiyatı likidasyona yaklaştır | Pozisyon kendiliğinden küçülür |
| Mod izolasyonu | `PAPER` config ile başlat | Hiçbir gerçek emir gitmez, loglarda mod görünür |

## RAPORLAMA KURALI

Her faz sonunda üret:

1. Ne çalışıyor — testle kanıtlanmış
2. **Ne çalışmıyor veya eksik** — yarım yapılan hiçbir şeyi tam gösterme
3. Hangi kaos testleri geçti, hangileri geçmedi
4. Canlıya çıkmadan önce kapatılması gereken açıklar

Bir kaos testi geçmiyorsa bunu açıkça söyle ve o fazı bitmiş sayma. "Çalışıyor
gibi görünüyor" canlı para için yeterli değildir.
