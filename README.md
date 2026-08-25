# SafeRoute — AI Tabanlı Güvenli Yaya Navigasyonu

Standart navigasyon uygulamaları (Google Maps, Yandex) yalnızca **en hızlı** rotayı hesaplar;
sokağın karanlık, ıssız veya riskli olup olmadığını dikkate almaz. SafeRoute, özellikle
gece yürüyen bireyler için **aydınlatma, yaya altyapısı, açık işletme yoğunluğu ve kayıtlı
suç verisini** birleştirerek alternatif bir "güvenli rota" üretir.

**Pilot bölgeler:** Eindhoven ve Nuenen (Hollanda) — veri zengin ortamda doğrulama.
Faz 2'de Eskişehir'e uyarlanacak (veri kısıtlı ortam).

## Kurulum ve Çalıştırma

```bash
cd server && npm install
```

Sunucu (API, port 3001):

```bash
cd server && node index.js
```

Arayüz (port 5173):

```bash
cd client && npm install && npm run dev
```

## Veri Hattı

Sırayla çalıştırılır (veriler `data/<bölge>/` altına iner):

```bash
node scripts/fetch-region.js "Eindhoven" eindhoven
```

```bash
node scripts/fetch-crime.js eindhoven 51.40 5.33 51.51 5.57
```

```bash
node scripts/score-region.js eindhoven
```

| Script | Kaynak | Çıktı |
|---|---|---|
| `fetch-region.js` | OpenStreetMap (Overpass API) | Yol ağı, sokak lambaları, işletmeler |
| `fetch-crime.js` | Hollanda Polisi (47022NED) + PDOK/CBS | Mahalle bazlı suç istatistikleri + sınır poligonları |
| `score-region.js` | Yukarıdakiler | `roads_scored.geojson` — segment başına 0-100 güvenlik skoru |
| `evaluate.js` | Çalışan API | Toplu karşılaştırma istatistikleri (tez bulguları için) |

## Skorlama Metodolojisi

Her yol segmenti için 0-100 arası skor, dört katkı ve iki cezadan oluşur:

**Katkılar (toplam 1.0):**
- Aydınlatma (0.35) — `lit` etiketi + yakın sokak lambaları
- Yaya altyapısı (0.20) — kaldırım varlığı / yaya-özel yol
- Açık işletme gözetimi (0.20) — o saatte açık, alkol-odaklı olmayan işletmeler
- Yol karakteri (0.25) — konut sokağı mı, izole patika mı

**Cezalar:**
- Kayıtlı suç riski (0.30) — mahalle bazlı polis verisi
- Bar/gece hayatı yoğunluğu (0.12) — alkol satış yoğunluğu

### Metodolojik Kararlar

**1. Eksik etiket ≠ tehlikeli.** OSM'de `lit`/`sidewalk` etiketlerinin yarısı eksik.
Sabit bir varsayılan yerine, her yol tipinin *etiketliyken gösterdiği ampirik oran*
kullanılır (class-conditional imputation). Örn. Eindhoven'da etiketli residential
sokakların %100'ü aydınlatılmış → etiketsiz residential de yüksek puan alır; ama
etiketli patikaların yalnızca %32'si aydınlık → etiketsiz patika düşük puan alır.

**2. Kalabalık ≠ güvenli.** İşletme yoğunluğu tek yönlü ele alınmaz. Market/eczane
"doğal gözetim" sağlar (artı puan); bar/pub/gece kulübü yoğunluğu ise literatürde
gece şiddet olaylarıyla ilişkilendirilir (ceza). Örnek: Stratumseind (Eindhoven'ın
bar sokağı) aydınlatma 100, yaya altyapısı 90 alır ama gece yarısı toplam skoru
**40/100**'e düşer.

**3. Küçük örneklem ve yanlış payda düzeltmesi.** Suç oranı ham "1000 **sakin**
başına" olarak kullanılmaz — iki ayrı hata çıkarır:
  - *Küçük örneklem*: 60 kişilik bir mahallede 4 olay yanıltıcı şekilde 66/1000
    üretir. Empirical Bayes shrinkage ile oranlar bölge ortalamasına çekilir.
  - *Yanlış payda*: şehir merkezleri az sakinli ama yüksek geçişlidir (Eindhoven
    Binnenstad: 4.070 sakin, 535 işletme). Suçu yalnızca sakin sayısına bölmek,
    işlek/kalabalık yerleri —ki kalabalık olmak doğası gereği caydırıcıdır—
    yapay olarak "riskli" gösteriyordu. Payda, sakin sayısı + işletme sayısı ×
    ağırlık olarak **gündüz nüfusuna (ambient population)** yaklaştırılır.
  - *Suç türü ağırlığı*: darp/tehdit (ağırlık 1.0) ile yankesicilik (0.35) aynı
    sayılmaz — can güvenliği tehdidi ile mal kaybı farklı ciddiyettedir.

  Ceza yalnızca **medyanın üstündeki** mahallelere uygulanır — ortalama bir
  mahalle nötrdür.

**3b. Suç riski de saate göre ölçeklenir.** Polis verisi aylık toplamdır, saatlik
kırılım yoktur; ama şiddet/kamu düzeni suçları büyük ölçüde gece-alkol kaynaklıdır.
Ham veri olmadan bunu ölçmek mümkün olmadığından, literatürle tutarlı bir çarpan
uygulanır (öğle ×0.4, gece yarısı ×1.25) — aksi halde öğlen 14:00'teki sakin bir
alışveriş caddesi, gece 02:00 ile aynı cezayı yerdi. Sonuç: Eindhoven'ın en işlek
yaya caddesi Marktstraat öğlen **84/100** (çevredeki konut mahalleleriyle aynı
seviyede), gece yarısı **54/100** alır — "kalabalık gündüz güvenlidir, gece
Stratumseind'e yakınlığı riski artırır" ayrımı artık doğru zamanlamada.

**4. Mesafe-ağırlıklı ortalama.** Rota skoru segment *sayısına* göre değil
uzunluğuna göre ortalanır; ayrıca rotanın **en düşük puanlı noktası** ayrıca
raporlanır ("bir rota en zayıf halkası kadar güvenlidir").

**5. Saate duyarlılık.** Aydınlatma ve altyapı saatle değişmez, ama hangi
işletmelerin açık olduğu değişir. `opening_hours` etiketi ayrıştırılarak beş zaman
dilimi için ayrı skor üretilir: sabah (08), öğle (13), akşam (17), gece (20),
gece yarısı (00).

## Özellikler

- Adres arama (Nominatim) veya haritadan nokta seçimi; seçilen nokta **ters geocoding**
  ile gerçek sokak adına çevrilir
- Hızlı vs güvenli rota karşılaştırması, tıklayarak seçim
- Rotanın güvenlik skoruna göre **segment segment renklendirilmesi** (kırmızı→yeşil)
- Herhangi bir parçaya tıklayınca **skorun neden o olduğunun dökümü**
- Adım adım yön tarifi + canlı navigasyon (gerçek GPS veya demo simülasyonu)
- Güvenlik-hız tercihi kaydırıcısı (5 kademe)
- **Saate duyarlı** sığınılabilecek noktalar: polis/hastane 7/24, market ve eczaneler
  yalnızca o saatte açıklarsa listelenir (ör. Albert Heijn 08–22, gece yarısı listeden
  düşer, yerini "avondwinkel" gece marketleri alır)
- **Güvenilirlik modelli** kullanıcı raporlama (aşağıya bakınız)
- Paylaşılabilir rota bağlantısı ve kayıtlı rotalar
- Mobil öncelikli arayüz: telefonda harita tam ekran, panel alttan açılan kart

## Kullanıcı Raporları: Güvenilirlik Modeli

Kullanıcı raporları doğrulanmamış, kötü niyetli ya da eskimiş olabilir; bu yüzden
ham sayım yerine ağırlıklı bir güven puanı kullanılır:

```
ağırlık = tipCiddiyeti × zamanAzalması × (1 + teyitSayısı × 0.5)
```

- **Tip ciddiyeti**: taciz (1.0) > tekinsiz (0.7) > karanlık (0.55) > yol kapalı (0.45).
  "Burası güvenli" raporu negatif ağırlıklıdır, yani skoru yükseltir.
- **Zaman azalması**: 180 günlük yarılanma ömrü — iki yıl önceki bir rapor artık zayıf kanıttır.
- **Teyit**: başka kullanıcılar "ben de gördüm" diyerek ağırlığı artırabilir.
- **Doygunluk**: aynı noktadaki raporlar karekökle ölçeklenir (4 rapor, 1 raporun
  4 katı değil ~2 katı etki eder).
- **Tavan**: toplam etki ±15 puanla sınırlıdır — crowdsource veri, resmi polis
  verisinden zayıf kabul edilir ve tek bir kişi rotayı manipüle edemez.

Ölçülen davranış: teyit edilmemiş tek bir "taciz" raporu skoru 5 puan düşürdü;
aynı rapor 3 kez teyit edilince etki 14 puana çıktı (tavana yaklaştı ama aşmadı).
Raporlar hem haritadaki renkleri hem rota maliyet fonksiyonunu etkiler.

## Sesli Navigasyon

Tarayıcının yerleşik konuşma sentezi (`SpeechSynthesis`, `tr-TR`) kullanılır — ekstra
servis/API anahtarı gerekmez. Yeni bir adıma geçildiğinde yön anonsu yapılır; bir
sonraki dönüşe 50m kalınca ayrıca "X metre sonra sağa dön" erken uyarısı verilir
(adım başına yalnızca bir kez). Navigasyon panelinde 🔊/🔇 ile açılıp kapatılabilir,
tercih tarayıcıda hatırlanır. Amaç: gece yalnız yürüyen birinin ekrana kilitlenmeden
yürüyebilmesi.

## Kullanıcı Çalışması (Kör A/B Testi)

`/?study=1` adresinde ayrı, bağımsız bir sayfa. Backend rastgele bir başlangıç-bitiş
çifti seçer, hızlı ve güvenli rotayı hesaplar (güvenlik skoru farkı ≥5 puan olana
kadar dener), rastgele sırayla "Rota A" / "Rota B" olarak — **hangisinin hangisi
olduğunu belirtmeden** — sunar. Katılımcı "gece yalnız yürüseydim hangisini
seçerdim?" sorusuna haritaya bakarak cevap verir; seçim sonrası hangi rotanın
algoritmanın önerdiği güvenli rota olduğu açığa çıkar ve birikimli istatistik
("katılımcıların %X'i güvenli rotayı seçti") gösterilir. Tezin kullanıcı
doğrulama/bulgular bölümü için tasarlandı; yanıtlar `data/study_responses.json`'da
tutulur (`/api/study/results` ile sorgulanabilir).

## Acil Durum ve Erişilebilirlik

**Acil durum paneli**: tek dokunuşla 112 araması; "Canlı Konumumu Paylaş" ise
konumu 8 saniyede bir sunucudaki geçici bir oturuma gönderir ve paylaşılabilir bir
link üretir (`?track=<id>`). Bu linki açan kişi, ayrı ve sade bir görüntüleyicide
(tam ekran harita + "X saniye önce güncellendi") konumu canlı izler — paylaşımı
başlatan kapatana ya da 6 saat geçene kadar. Oturumlar sunucu belleğinde tutulur,
kalıcı değildir.

**Erişilebilir Mod**: standart moddan ayrı, belirgin bir anahtarla açılan farklı
bir rota profili. Açıkken `highway=steps` segmentleri ağır cezalandırılır (fiziksel
olarak geçilemez kabul edilir, tamamen yasaklanmaz — tek geçiş bir merdivense rota
en azından bulunabilir kalır), kaplamasız `path`/`track` segmentleri orta düzeyde
cezalandırılır. Kaçınılamayan bir merdiven varsa arayüz açıkça uyarır. Panel
tipografisi de büyütülerek görsel olarak ayrı bir mod hissi verilir.

## Bilinen Sınırlamalar

- **Güvenli nokta kapsaması şehir merkezinde yoğun, kenarlarda seyrek.** İlk
  denetimde yalnızca merkez test edilmişti; tüm ağ örneklenince Nuenen'in
  %51'inde en yakın güvenli nokta 500m'den uzak çıktı. Kapsamı polis/eczane
  dışına (banka, PTT, kütüphane, semt merkezi, ibadethane, itfaiye, aile
  hekimi) genişletince Eindhoven'da güvenli nokta sayısı 235→402'ye, Nuenen'de
  17→42'ye çıktı; en kötü nokta mesafesi Nuenen'de 3448m→1795m'ye indi. Kalan
  boşluk büyük ölçüde **gerçek** — küçük bir köyde her 500m'de eczane olmaz;
  bu veri eksikliği değil, kırsal yerleşimin doğası.
- **Suç verisi mahalle seviyesinde**, sokak seviyesinde değil. "Bu mahalle riskli"
  denebilir, "bu sokak" denemez.
- **İkamet nüfusuna göre normalize edilmiştir.** Gündüz/gece hareketli nüfus
  (ambient population) verisi kamuya açık değil; bu, gar ve merkez gibi az sakinli
  ama yoğun geçişli bölgelerde riski bir miktar abartabilir.
- **OSM etiket kapsamı bölgeye göre değişir.** Nuenen'de hiç sokak lambası
  etiketlenmemiş; model bu durumda ampirik önsellere dayanır.
- `opening_hours` ayrıştırması basitleştirilmiştir (gün bazlı ayrım yapılmaz; hafta içi
  ve hafta sonu farkı dikkate alınmaz).
- Kullanıcı raporları prototipte JSON dosyasında tutulur; kimlik doğrulama ve
  moderasyon yoktur. Güvenilirlik modeli manipülasyonu zorlaştırır ama tek başına
  yeterli değildir — üretimde hesap doğrulama gerekir.
- Zaman profilleri beş kesikli dilimdir (saat başı değil); her dilim ayrı bir rota
  grafiği gerektirdiğinden sürekli zaman pratik değildir.

## Teknik Notlar

Rota motoru, güvenlik skorunu maliyet fonksiyonuna katan Dijkstra tabanlı bir
arama kullanır (`geojson-path-finder`). Ağırlık fonksiyonu grafik kurulumunda bir
kez uygulandığından, her (bölge × zaman dilimi × güvenlik tercihi) kombinasyonu
ayrı bir graf gerektirir. Bellek kullanımını sınırlamak için graflar **talep
anında kurulur ve LRU önbellekte** tutulur (en fazla 3 tanesi).
