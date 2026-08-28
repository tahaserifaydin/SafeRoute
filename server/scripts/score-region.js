// Bir bölgenin yol segmentlerine gündüz/akşam/gece için ayrı ayrı 0-100 güvenlik skoru atar.
// Kullanım: node score-region.js <data-klasör-adı>
// Girdiler: data/<klasör>/{roads,lamps,amenities}.geojson
// Çıktı:    data/<klasör>/roads_scored.geojson
//           (her feature'da properties.safety_score_{day,evening,night})
//
// METODOLOJİ
// Ham OSM verisinde çoğu etiket (lit, sidewalk) eksik. Eksik etiketi sabit bir
// sayıyla doldurmak yerine ("veri yok" != "tehlikeli"), aynı veri setinde o yol
// tipinin ETİKETLİYKEN gösterdiği gerçek orana göre dolduruyoruz (class-conditional
// imputation) — örn. residential sokakların etiketliyken %100'ü "lit=yes" diyorsa,
// etiketsiz bir residential sokak da yüksek ihtimalle aydınlatılmıştır.
//
// Gece güvenliği için işletme yoğunluğu tek boyutlu değil: market/eczane/restoran
// gibi yerler "gözetim" sağlar (pozitif), ama bar/pub/gece kulübü yoğunluğu
// literatürde (alkol satış yoğunluğu ve şiddet ilişkisi) artan olay riskiyle
// ilişkilendirilir — bu yüzden ayrı bir risk cezası olarak modelleniyor, artı puan
// olarak değil.
//
// SAATE DUYARLILIK: Aydınlatma/kaldırım/yol-tipi fiziksel altyapıdır, saatle değişmez.
// Ama "hangi işletmeler şu an açık" ve "bar kalabalığı riski" saate göre değişir — bu
// yüzden gündüz/akşam/gece için üç ayrı profil hesaplanıyor (rota grafiğinin her
// istekte yeniden kurulması pratik olmadığından, sürekli saat yerine 3 kesikli profil
// kullanılıyor).
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const dirName = process.argv[2];
if (!dirName) {
  console.error("Kullanım: node score-region.js <data-klasör-adı>");
  process.exit(1);
}
const DATA_DIR = path.join(__dirname, "..", "..", "data", dirName);

// Gün içi 5 zaman dilimi, iş/sosyal ritme göre (08-13 sabah, 13-17 öğle, 17-20 akşam,
// 20-24 gece, 00-08 gece yarısı) — her dilim kendi başlangıç saatiyle örnekleniyor.
const TIME_PROFILES = { morning: 8, midday: 13, evening: 17, night: 20, lateNight: 0 };

// --- Bileşen ağırlıkları (toplam 1.0) ---
const WEIGHTS = {
  lighting: 0.35,
  pedInfra: 0.2,
  frontage: 0.2,
  roadType: 0.25,
};
// Ceza terimleri baseScore'dan düşülür. Gerçek suç verisi daha güçlü bir kanıt
// olduğu için ana ceza odur; bar yoğunluğu (ikisi korele olduğundan çifte
// cezalandırmayı önlemek adına) yardımcı ve düşük ağırlıklı bir sinyaldir.
const CRIME_PENALTY_WEIGHT = 0.3;

// Polis verisi saatlik kırılım içermez (aylık toplam), ama kriminoloji literatüründe
// şiddet/kamu düzeni suçları büyük ölçüde gece-alkol kaynaklıdır ve akşam-gece
// saatlerinde yoğunlaşır; gündüz doğal gözetim (kalabalık, mağaza personeli, trafik)
// caydırıcıdır. Saatlik veri yokluğunda bunu makul bir çarpanla modelliyoruz — aksi
// halde öğlen 14:00'teki sakin bir alışveriş caddesi, gece 02:00 ile AYNI cezayı
// yerdi (bu, Binnenstad/Centrum gibi karma-kullanımlı merkezleri haksız cezalandırdı).
const CRIME_TIME_MULTIPLIER = { morning: 0.45, midday: 0.4, evening: 0.75, night: 1.0, lateNight: 1.25 };
const NIGHTLIFE_PENALTY_WEIGHT = 0.12;

// Empirical Bayes shrinkage: az nüfuslu mahallelerde 3-5 olay bile devasa "1000 kişi
// başına" oran üretir (ör. 60 kişilik mahallede 4 olay = 66/1000). Bu istatistiksel
// gürültüyü bastırmak için oran, bölge ortalamasına doğru çekilir. K, "kaç kişilik
// sanal ön-gözlem" eklendiğini belirler: nüfus K'dan küçükse ortalama baskın olur.
const SHRINKAGE_K = 1500;

// Suç sınıflarının yaya güvenliği açısından ağırlığı. Yankesicilik mal kaybıdır,
// darp can güvenliği tehdididir; eşit saymak yankesiciliğin yoğunlaştığı şehir
// merkezlerini haksız cezalandırıyordu.
const CRIME_CLASS_WEIGHTS = { violent: 1.0, property: 0.35, disorder: 0.5 };

// PAYDA (denominator) DÜZELTMESİ
// Suç oranını yalnızca ikamet nüfusuna bölmek, gündüz nüfusu ikamet nüfusunun kat
// kat üstünde olan merkezleri cezalandırır (ör. Binnenstad: 4.070 sakin, 535 işletme).
// Gerçek payda "o anda orada bulunan kişi sayısı"dır; bunun için işletme sayısı
// literatürde yaygın bir gündüz-nüfusu göstergesi olarak kullanılır.
const POI_AMBIENT_WEIGHT = 25; // bir işletme ≈ 25 "eşdeğer sakin" hareketlilik üretir

const ROAD_TYPE_SCORE = {
  pedestrian: 90,
  living_street: 85,
  residential: 75,
  unclassified: 65,
  footway: 60,
  cycleway: 60,
  steps: 55,
  tertiary: 55,
  secondary: 50,
  primary: 45,
  trunk: 40,
  service: 45,
  track: 30,
  path: 35,
};

const DEDICATED_PEDESTRIAN_TYPES = new Set(["footway", "pedestrian", "living_street", "steps"]);
const PED_TYPE_DEFAULT_SCORE = { footway: 90, pedestrian: 90, living_street: 85, steps: 85 };

const NIGHTLIFE_RISK_TYPES = new Set(["bar", "pub", "nightclub", "biergarten"]);

// opening_hours etiketi yoksa kategoriye göre tipik açık saat aralığı (24h, sarma destekli)
const CATEGORY_HOURS = {
  bar: [18, 26],
  pub: [17, 25],
  nightclub: [22, 28],
  biergarten: [16, 24],
  restaurant: [11, 23],
  cafe: [8, 22],
  fast_food: [10, 24],
  supermarket: [8, 21],
  convenience: [7, 22],
  pharmacy: [8, 19],
  chemist: [8, 19],
  hospital: [0, 24],
  police: [0, 24],
  fuel: [0, 24],
  taxi: [0, 24],
  hotel: [0, 24], // resepsiyon gece de açık
  station: [5, 26],
  clinic: [8, 18],
  doctors: [8, 18],
  _default: [9, 18], // giysi, kuaför, kitapçı vb. tipik gündüz esnafı
};

const AMENITY_RADIUS_M = 100;
const NIGHTLIFE_RADIUS_M = 100;
const LAMP_RADIUS_M = 60;
const CELL_SIZE_DEG = 0.001;

function buildGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const [lng, lat] = p.geometry.coordinates;
    const key = `${Math.floor(lat / CELL_SIZE_DEG)},${Math.floor(lng / CELL_SIZE_DEG)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  return grid;
}

function countNearby(grid, lat, lng, radiusM) {
  const cellLat = Math.floor(lat / CELL_SIZE_DEG);
  const cellLng = Math.floor(lng / CELL_SIZE_DEG);
  let count = 0;
  const center = turf.point([lng, lat]);
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const key = `${cellLat + dLat},${cellLng + dLng}`;
      const bucket = grid.get(key);
      if (!bucket) continue;
      for (const p of bucket) {
        const d = turf.distance(center, p, { units: "meters" });
        if (d <= radiusM) count++;
      }
    }
  }
  return count;
}

function normalize(count, maxForFullScore) {
  return Math.min(count / maxForFullScore, 1) * 100;
}

// --- Suç verisi: mahalle poligonlarını okuyup 0-100 risk skoruna çevirir ---
// İki düzeltme uygulanır:
//  1) Shrinkage — küçük nüfuslu mahallelerin gürültülü oranları ortalamaya çekilir.
//  2) Yüzdelik sıralama — mutlak oran yerine bölge içindeki göreli konum kullanılır,
//     böylece tek bir uç değer (ör. gar bölgesi) tüm ölçeği bozmaz.
function loadCrimeRisk(amenityFeatures) {
  const crimePath = path.join(DATA_DIR, "crime_buurten.geojson");
  if (!fs.existsSync(crimePath)) {
    console.log("  UYARI: crime_buurten.geojson yok, suç cezası uygulanmayacak.");
    return null;
  }
  const gj = JSON.parse(fs.readFileSync(crimePath));
  const usable = gj.features.filter(
    (f) => f.properties.crime_count != null && typeof f.properties.aantalInwoners === "number"
  );
  if (!usable.length) return null;

  // Her mahalledeki işletme sayısını say (gündüz nüfusu göstergesi)
  const buurtBboxes = usable.map((b) => ({ b, bbox: turf.bbox(b) }));
  const poiCount = new Map();
  for (const f of amenityFeatures) {
    const [lng, lat] = f.geometry.coordinates;
    for (const { b, bbox } of buurtBboxes) {
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (turf.booleanPointInPolygon(f, b.geometry)) {
        const code = b.properties.buurtcode;
        poiCount.set(code, (poiCount.get(code) || 0) + 1);
        break;
      }
    }
  }

  // Ağırlıklı suç ve gündüz nüfusu tahmini
  const weighted = (p) =>
    (p.crime_violent ?? 0) * CRIME_CLASS_WEIGHTS.violent +
    (p.crime_property ?? 0) * CRIME_CLASS_WEIGHTS.property +
    (p.crime_disorder ?? 0) * CRIME_CLASS_WEIGHTS.disorder;

  const ambientOf = (f) =>
    Math.max(f.properties.aantalInwoners, 0) + (poiCount.get(f.properties.buurtcode) || 0) * POI_AMBIENT_WEIGHT;

  const totalCrimes = usable.reduce((s, f) => s + weighted(f.properties), 0);
  const totalPop = usable.reduce((s, f) => s + ambientOf(f), 0);
  const regionRate = totalPop > 0 ? totalCrimes / totalPop : 0; // kişi başı yıllık

  const adjusted = usable.map((f) => {
    const c = weighted(f.properties);
    const pop = ambientOf(f);
    // Empirical Bayes: (gözlem + sanal ön-gözlem) / (nüfus + K)
    const rate = (c + SHRINKAGE_K * regionRate) / (pop + SHRINKAGE_K);
    return { feature: f, rate };
  });

  const sortedRates = adjusted.map((a) => a.rate).sort((x, y) => x - y);
  const percentileOf = (rate) => {
    let lo = 0;
    let hi = sortedRates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedRates[mid] < rate) lo = mid + 1;
      else hi = mid;
    }
    return sortedRates.length > 1 ? (lo / (sortedRates.length - 1)) * 100 : 50;
  };

  const entries = adjusted.map(({ feature, rate }) => ({
    bbox: turf.bbox(feature),
    geometry: feature.geometry,
    name: feature.properties.buurtnaam,
    riskScore: Math.round(percentileOf(rate)), // 0 = en güvenli, 100 = en riskli
  }));

  console.log(
    `  suç verisi: ${entries.length} mahalle, bölge ortalaması ${(regionRate * 1000).toFixed(1)}/1000 kişi/yıl`
  );
  return entries;
}

function crimeRiskAt(crimeEntries, lng, lat) {
  if (!crimeEntries) return null;
  const pt = turf.point([lng, lat]);
  for (const e of crimeEntries) {
    // Önce ucuz bbox kontrolü, sonra pahalı poligon testi
    if (lng < e.bbox[0] || lng > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3]) continue;
    if (turf.booleanPointInPolygon(pt, e.geometry)) return e;
  }
  return null;
}

function inRange(hour, open, close) {
  if (close <= open) close += 24;
  return (hour >= open && hour < close) || (hour + 24 >= open && hour + 24 < close);
}

// Belirli bir saatte bu işletmenin açık olup olmadığını tahmin eder.
// opening_hours OSM sözdizimi tam desteklenmiyor (gün bazlı ayrım basitleştirildi):
// metindeki TÜM saat aralıkları çıkarılıp herhangi birine denk geliyorsa "açık" sayılır.
function isOpenAt(props, hour) {
  const oh = props.opening_hours;
  if (oh) {
    if (/24\/7/.test(oh)) return true;
    const ranges = [...oh.matchAll(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/g)];
    if (ranges.length) {
      return ranges.some((m) => inRange(hour, +m[1] + +m[2] / 60, +m[3] + +m[4] / 60));
    }
  }
  const type = props.amenity || props.shop || props.tourism || props.railway;
  const [open, close] = CATEGORY_HOURS[type] || CATEGORY_HOURS._default;
  return inRange(hour, open, close);
}

function isNightlifeRisk(props) {
  const type = props.amenity || props.shop || props.tourism || props.railway;
  return NIGHTLIFE_RISK_TYPES.has(type);
}

// --- Yol tipine göre ampirik "lit" ve "sidewalk" oranlarını veriden hesapla ---
function computeEmpiricalPriors(roadFeatures) {
  const litStats = {};
  const sidewalkStats = {};
  for (const f of roadFeatures) {
    const t = f.properties.highway;
    if (!litStats[t]) litStats[t] = { yes: 0, tagged: 0 };
    if (!sidewalkStats[t]) sidewalkStats[t] = { good: 0, tagged: 0 };

    if (f.properties.lit) {
      litStats[t].tagged++;
      if (f.properties.lit === "yes" || f.properties.lit === "24/7") litStats[t].yes++;
    }
    if (f.properties.sidewalk) {
      sidewalkStats[t].tagged++;
      if (f.properties.sidewalk !== "no") sidewalkStats[t].good++;
    }
  }

  const MIN_SAMPLE = 15;
  const litPrior = {};
  const sidewalkPrior = {};
  let globalLitYes = 0,
    globalLitTagged = 0,
    globalSwGood = 0,
    globalSwTagged = 0;
  for (const t in litStats) {
    globalLitYes += litStats[t].yes;
    globalLitTagged += litStats[t].tagged;
  }
  for (const t in sidewalkStats) {
    globalSwGood += sidewalkStats[t].good;
    globalSwTagged += sidewalkStats[t].tagged;
  }
  const globalLitRate = globalLitTagged ? globalLitYes / globalLitTagged : 0.6;
  const globalSwRate = globalSwTagged ? globalSwGood / globalSwTagged : 0.6;

  for (const t in litStats) {
    const s = litStats[t];
    const rate = s.tagged >= MIN_SAMPLE ? s.yes / s.tagged : globalLitRate;
    litPrior[t] = Math.round(25 + rate * 65);
  }
  for (const t in sidewalkStats) {
    const s = sidewalkStats[t];
    const rate = s.tagged >= MIN_SAMPLE ? s.good / s.tagged : globalSwRate;
    sidewalkPrior[t] = Math.round(25 + rate * 65);
  }
  return { litPrior, sidewalkPrior };
}

function main() {
  console.log(`[${dirName}] Veriler okunuyor...`);
  const roads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "roads.geojson")));
  const lamps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "lamps.geojson")));
  const amenities = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "amenities.geojson")));

  console.log("Ampirik lit/sidewalk oranları hesaplanıyor...");
  const { litPrior, sidewalkPrior } = computeEmpiricalPriors(roads.features);

  console.log("Lamba ızgarası kuruluyor...");
  const lampGrid = buildGrid(lamps.features);

  console.log("Suç verisi yükleniyor (gündüz nüfusu düzeltmesiyle)...");
  const crimeEntries = loadCrimeRisk(amenities.features);

  console.log("Zaman dilimi başına işletme ızgaraları kuruluyor (gündüz/akşam/gece)...");
  const gridsByTime = {};
  for (const [timeName, hour] of Object.entries(TIME_PROFILES)) {
    const openNow = amenities.features.filter((f) => isOpenAt(f.properties, hour));
    const positive = openNow.filter((f) => !isNightlifeRisk(f.properties));
    const nightlife = openNow.filter((f) => isNightlifeRisk(f.properties));
    gridsByTime[timeName] = { positiveGrid: buildGrid(positive), nightlifeGrid: buildGrid(nightlife) };
    console.log(`  ${timeName} (${hour}:00) -> açık pozitif işletme: ${positive.length}, açık bar/pub/kulüp: ${nightlife.length}`);
  }

  console.log(`${roads.features.length} segment skorlanıyor...`);
  let processed = 0;
  const scored = roads.features
    .filter((f) => f.geometry && f.geometry.type === "LineString" && f.geometry.coordinates.length >= 2)
    .map((f) => {
      const highway = f.properties.highway;
      const line = turf.lineString(f.geometry.coordinates);
      const lengthKm = turf.length(line, { units: "kilometers" });
      const mid = turf.along(line, lengthKm / 2, { units: "kilometers" });
      const [lng, lat] = mid.geometry.coordinates;

      // --- Saatle değişmeyen (fiziksel) bileşenler: bir kez hesaplanır ---
      let lightingScore;
      if (f.properties.lit === "yes" || f.properties.lit === "24/7") lightingScore = 100;
      else if (f.properties.lit === "no") lightingScore = 0;
      else if (f.properties.viirs_rad != null) {
        // NASA/NOAA VIIRS gece ışığı uydu verisi (bkz. fetch_viirs_lighting.py).
        // OSM'in `lit` etiketi eksikken (Türkiye'de yolların çoğunda yok) önceden
        // sadece yol TİPİNİN bölge ortalamasına (litPrior) düşülüyordu — aynı tahmin
        // o tipteki HER yola uygulanıyordu, konumdan bağımsızdı. VIIRS her segment
        // için o KONUMA özgü gerçek bir gece parlaklığı ölçümü sağlıyor (~460m
        // çözünürlük). Radyans (nW/cm²/sr) çok çarpık dağıldığından log ölçekle
        // 10-95 aralığına sıkıştırılıyor; log10(30) normalizasyonu bu bölgelerde
        // gözlenen üst yüzdelik dilime (~p99) karşılık geliyor.
        const rad = Math.max(0, f.properties.viirs_rad);
        lightingScore = Math.round(
          Math.max(10, Math.min(95, 10 + (85 * Math.log10(rad + 0.15)) / Math.log10(30)))
        );
      } else lightingScore = litPrior[highway] ?? 50;
      const lampCount = countNearby(lampGrid, lat, lng, LAMP_RADIUS_M);
      if (lampCount >= 1) lightingScore = Math.max(lightingScore, 80);

      let pedInfraScore;
      if (DEDICATED_PEDESTRIAN_TYPES.has(highway)) {
        pedInfraScore = PED_TYPE_DEFAULT_SCORE[highway] ?? 85;
      } else {
        const sw = f.properties.sidewalk;
        if (sw === "both" || sw === "separate") pedInfraScore = 100;
        else if (sw === "right" || sw === "left" || sw === "yes") pedInfraScore = 70;
        else if (sw === "no") pedInfraScore = 15;
        else pedInfraScore = sidewalkPrior[highway] ?? 50;
      }

      const roadTypeScore = ROAD_TYPE_SCORE[highway] ?? 50;

      // Kayıtlı suç verisi (mahalle bazlı, saatten bağımsız)
      const crimeEntry = crimeRiskAt(crimeEntries, lng, lat);
      const crimeRisk = crimeEntry ? crimeEntry.riskScore : null;
      // Ceza yalnızca medyanın ÜSTÜNDEKİ mahallelere uygulanır: yüzdelik sıralamada
      // ortalama bir mahalle (50) nötrdür, ceza 0'dır; en riskli mahalle (100) tam ceza alır.
      // Aksi halde şehrin yarısı, sırf "ortalama" olduğu için haksız yere cezalandırılırdı.
      const crimeExcess = crimeRisk != null ? Math.max(0, (crimeRisk - 50) * 2) : 0;
      const crimePenalty = CRIME_PENALTY_WEIGHT * crimeExcess;

      // --- Saate göre değişen bileşenler: her profil için ayrı hesapla ---
      const scoresByTime = {};
      const breakdownByTime = {};
      for (const timeName of Object.keys(TIME_PROFILES)) {
        const { positiveGrid, nightlifeGrid } = gridsByTime[timeName];

        const positiveCount = countNearby(positiveGrid, lat, lng, AMENITY_RADIUS_M);
        const frontageScore = normalize(positiveCount, 3);

        const nightlifeCount = countNearby(nightlifeGrid, lat, lng, NIGHTLIFE_RADIUS_M);
        const nightlifeRisk = normalize(nightlifeCount, 3);
        const nightlifePenalty = NIGHTLIFE_PENALTY_WEIGHT * nightlifeRisk;
        const crimePenaltyNow = crimePenalty * (CRIME_TIME_MULTIPLIER[timeName] ?? 1);

        const baseScore =
          WEIGHTS.lighting * lightingScore +
          WEIGHTS.pedInfra * pedInfraScore +
          WEIGHTS.frontage * frontageScore +
          WEIGHTS.roadType * roadTypeScore;

        const safetyScore = Math.round(
          Math.max(0, Math.min(100, baseScore - nightlifePenalty - crimePenaltyNow))
        );
        scoresByTime[timeName] = safetyScore;
        breakdownByTime[timeName] = {
          lighting: Math.round(lightingScore),
          pedInfra: Math.round(pedInfraScore),
          frontage: Math.round(frontageScore),
          roadType: roadTypeScore,
          nightlifeRisk: Math.round(nightlifeRisk),
          crimeRisk,
          nightlifePenalty: Math.round(nightlifePenalty),
          crimePenalty: Math.round(crimePenaltyNow),
        };
      }

      processed++;
      if (processed % 5000 === 0) console.log(`  ${processed}/${roads.features.length}`);

      const timeProps = {};
      for (const timeName of Object.keys(TIME_PROFILES)) {
        timeProps[`safety_score_${timeName}`] = scoresByTime[timeName];
        timeProps[`safety_breakdown_${timeName}`] = breakdownByTime[timeName];
      }

      return {
        ...f,
        properties: {
          ...f.properties,
          length_m: Math.round(lengthKm * 1000),
          buurt: crimeEntry ? crimeEntry.name : null,
          ...timeProps,
        },
      };
    });

  const out = { type: "FeatureCollection", features: scored };
  const outPath = path.join(DATA_DIR, "roads_scored.geojson");
  fs.writeFileSync(outPath, JSON.stringify(out));

  console.log(`\nTamamlandı: ${scored.length} segment -> ${outPath}`);
  for (const timeName of Object.keys(TIME_PROFILES)) {
    const scores = scored.map((f) => f.properties[`safety_score_${timeName}`]);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`  [${timeName}] ortalama: ${avg.toFixed(1)}  min: ${Math.min(...scores)}  max: ${Math.max(...scores)}`);
  }
}

main();
