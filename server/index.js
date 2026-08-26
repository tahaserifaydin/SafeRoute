const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const turf = require("@turf/turf");
const PathFinder = require("geojson-path-finder").default;
const { pathToGeoJSON } = require("geojson-path-finder");

const DATA_ROOT = path.join(__dirname, "..", "data");
const CLIENT_DIR = path.join(__dirname, "..", "client");
const PORT = process.env.PORT || 3001;

// alpha: güvenlik cezasının rota maliyetine ne kadar ağırlık katacağını belirler.
// 0 = tamamen en hızlı rota, yüksek değer = güvenliksiz segmentlerden agresif kaçınma
// NOT: geojson-path-finder weight fonksiyonunu sadece grafik kurulurken (bir kez)
// çalıştırıyor; bu yüzden farklı alpha değerleri için ayrı PathFinder örnekleri
// kurmak gerekiyor (sorgu anında alpha değiştirmek işe yaramıyor).
const WALK_SPEED_KMH = 5;
const TURN_SAMPLE_M = 20;
const TURN_ANGLE_THRESHOLD = 40;
const MIN_STEP_M = 20;

// Aydınlatma/kaldırım/yol tipi fiziksel altyapıdır, saatle değişmez; ama işletme
// yoğunluğu ve bar/gece hayatı riski değişir. Grafiği her istekte yeniden kurmak
// (7-8sn) pratik olmadığından, gün içi 5 kesikli profil önceden inşa ediliyor
// (08 sabah, 13 öğle, 17 akşam, 20 gece, 00 gece yarısı).
const TIME_PROFILES = ["morning", "midday", "evening", "night", "lateNight"];

const REGIONS = {
  eindhoven: { label: "Eindhoven", dataDir: "eindhoven", center: [51.4416, 5.4697] },
  nuenen: { label: "Nuenen", dataDir: "nuenen", center: [51.4743, 5.549] },
  bornova: { label: "Bornova (İzmir)", dataDir: "bornova", center: [38.4581, 27.2397] },
  buca: { label: "Buca (İzmir)", dataDir: "buca", center: [38.3666, 27.2115] },
  gaziemir: { label: "Gaziemir (İzmir)", dataDir: "gaziemir", center: [38.3213, 27.1412] },
  alsancak: { label: "Alsancak (İzmir)", dataDir: "alsancak", center: [38.4384, 27.1434] },
  mustafakemalpasa: { label: "Mustafakemalpaşa (Bursa)", dataDir: "mustafakemalpasa", center: [39.9766, 28.4786] },
};

function currentTimeProfile() {
  const h = new Date().getHours();
  if (h >= 8 && h < 13) return "morning";
  if (h >= 13 && h < 17) return "midday";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 24) return "night";
  return "lateNight"; // 00:00 - 07:59
}

// --- Kullanıcı raporları: güvenilirlik modeli ---
// Kullanıcı raporları resmi veriden daha zayıf bir kanıttır (doğrulanmamış, kötü
// niyetli olabilir, eskiyebilir). Bu yüzden ham sayım yerine ağırlıklı bir güven
// puanı hesaplanır:
//   ağırlık = tipCiddiyeti × zamanAzalması × (1 + teyitler × TEYIT_BONUSU)
// Aynı noktadaki raporlar karekökle ölçeklenir (4 rapor, 1 raporun 4 katı değil
// 2 katı etki eder) ve toplam etki MAX_REPORT_EFFECT ile sınırlanır — böylece tek
// bir kişi rotayı manipüle edemez.
const REPORTS_PATH = path.join(DATA_ROOT, "user_reports.json");
const REPORT_TYPES = {
  dark: "Karanlık / lamba yok",
  unsafe: "Tekinsiz hissettim",
  harassment: "Taciz / rahatsız edilme",
  blocked: "Yol kapalı / geçilmiyor",
  safe: "Burası güvenli",
};
const REPORT_WEIGHTS = { harassment: 1.0, unsafe: 0.7, dark: 0.55, blocked: 0.45, safe: -0.5 };
const REPORT_HALFLIFE_DAYS = 180; // 6 ay sonra bir raporun ağırlığı yarıya iner
const CONFIRM_BONUS = 0.5;
const MAX_REPORT_EFFECT = 15; // skor üzerindeki en fazla etki (puan)
const REPORT_RADIUS_M = 60;
const REPORT_SATURATION = 3; // bu kadar tam-ağırlıklı rapor etkiyi doyurur

// Bölgeye göre gruplanmış, ağırlığı hesaplanmış rapor listesi (tembel önbellek)
let reportCache = null;

// Temel skoru kullanıcı raporlarıyla düzeltir (0-100 aralığında tutar).
function adjustScore(baseScore, regionId, lng, lat) {
  const effect = reportEffectAt(regionId, lng, lat);
  if (!effect) return baseScore;
  return Math.max(0, Math.min(100, baseScore - effect));
}

// Erişilebilir mod: tekerlekli sandalye / bebek arabası / yürüme güçlüğü olan
// kullanıcılar için merdiven tamamen elenir, düzensiz/kaplamasız yüzeyler ağır
// cezalandırılır. "steps" güvenlik açısından tehlikeli değildir ama FİZİKSEL
// olarak geçilemez olduğundan ayrı bir ceza ekseni gerekir.
const ACCESSIBLE_HIGHWAY_PENALTY = { steps: 50, path: 2.5, track: 3 };

function buildFinder(roadsScored, scoreField, alpha, regionId, accessible) {
  return new PathFinder(roadsScored, {
    weight: (a, b, props) => {
      const distanceKm = turf.distance(a, b);
      const base = props[scoreField] ?? 50;
      // Kullanıcı raporları maliyet fonksiyonunu da etkiler, sadece görseli değil
      const adjusted = adjustScore(base, regionId, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const penalty = (100 - adjusted) / 100;
      let cost = distanceKm * (1 + alpha * penalty);
      if (accessible) {
        const mult = ACCESSIBLE_HIGHWAY_PENALTY[props.highway];
        if (mult) cost *= mult;
      }
      return cost;
    },
    // Mesafe-ağırlıklı ortalama için segment uzunluğunu kullanıyoruz; sadece segment
    // SAYISINA göre ortalama almak, çok sayıda kısa güvenli segmentin tek bir uzun
    // karanlık segmenti "sulandırmasına" yol açardı (bkz. minScore ile çapraz kontrol).
    edgeDataSeed: (props) => ({
      weightedSum: (props[scoreField] ?? 50) * (props.length_m ?? 1),
      totalLenM: props.length_m ?? 1,
      minScore: props[scoreField] ?? 50,
    }),
    // NOT: edgeData rapor etkisini içermez (koordinat erişimi yok); rota
    // istatistikleri computeRoute içinde segmentlerden yeniden hesaplanır.
    edgeDataReducer: (a, b) => ({
      weightedSum: a.weightedSum + b.weightedSum,
      totalLenM: a.totalLenM + b.totalLenM,
      minScore: Math.min(a.minScore, b.minScore),
    }),
  });
}

// Grafikler başlangıçta değil, ilk istendiklerinde kurulur (lazy) ve önbellekte tutulur.
// Hepsini önden kurmak (5 zaman x 2 bölge x 2 profil = 20 grafik) ~2GB RAM tüketiyordu;
// pratikte bir oturumda bunların yalnızca birkaçı kullanılıyor.
const MAX_CACHED_FINDERS = 3;
const finderCache = new Map(); // "regionId:timeName" -> { fastFinder, safeFinder }

// Üretimde bellek çok kısıtlı (ücretsiz barındırma ~512MB): tek bir PathFinder
// grafiği bile ~150-200MB tutuyor. Geometriyi düşük toleransla basitleştirmek
// (yayanın fark etmeyeceği ~3-5m) köşe noktası sayısını ~%40 azaltıp her grafiğin
// maliyetini orantılı düşürür. SIMPLIFY_TOLERANCE=0 ile kapatılabilir.
const SIMPLIFY_TOLERANCE = parseFloat(process.env.SIMPLIFY_TOLERANCE ?? "0.00003");

function simplifyRoads(roadsScored) {
  if (!SIMPLIFY_TOLERANCE) return roadsScored;
  let before = 0,
    after = 0;
  for (const f of roadsScored.features) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    before += f.geometry.coordinates.length;
    if (f.geometry.coordinates.length > 3) {
      f.geometry.coordinates = turf.simplify(turf.lineString(f.geometry.coordinates), {
        tolerance: SIMPLIFY_TOLERANCE,
        highQuality: false,
      }).geometry.coordinates;
    }
    after += f.geometry.coordinates.length;
  }
  console.log(`  geometri basitleştirildi: ${before} -> ${after} koordinat (%${Math.round(100 * (1 - after / before))} azalma)`);
  return roadsScored;
}

// PathFinder'ın kendi köşe kümesini kullanmak için tam bir grafik kurmak gerekirdi
// (~150-200MB, sırf snap noktaları için). Bunun yerine yol geometrilerindeki
// benzersiz koordinatları doğrudan çıkarıyoruz — PathFinder'ın kullandığı köşeler
// zaten bu noktaların bir alt kümesidir, snap amacı için işlevsel olarak eşdeğerdir.
function extractVertexPoints(roadsScored) {
  const seen = new Set();
  const points = [];
  for (const f of roadsScored.features) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    for (const c of f.geometry.coordinates) {
      const key = `${c[0]},${c[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(turf.point(c));
    }
  }
  return turf.featureCollection(points);
}

function loadRegion(id, config) {
  console.log(`[${id}] Skorlanmış yol ağı yükleniyor...`);
  const dataDir = path.join(DATA_ROOT, config.dataDir);
  const roadsScored = simplifyRoads(JSON.parse(fs.readFileSync(path.join(dataDir, "roads_scored.geojson"))));
  const amenities = JSON.parse(fs.readFileSync(path.join(dataDir, "amenities.geojson")));

  const vertexPoints = extractVertexPoints(roadsScored);
  console.log(`[${id}] Hazır: ${vertexPoints.features.length} köşe noktası.`);

  return {
    id,
    label: config.label,
    center: config.center,
    roadsScored,
    amenities,
    segmentIndex: buildSegmentIndex(roadsScored),
    vertexPoints,
    bbox: turf.bbox(roadsScored), // [minLng, minLat, maxLng, maxLat]
  };
}

// Bölge verisi de tembel yüklenir: kullanıcı hiç Nuenen'e geçmezse o bölgenin
// yol ağı/işletmeleri belleğe hiç alınmaz. Bellek kısıtlı ücretsiz barındırmada
// (~512MB) her MB önemli.
const regionData = {};
function getRegion(id) {
  const key = REGIONS[id] ? id : "eindhoven";
  if (!regionData[key]) {
    regionData[key] = loadRegion(key, REGIONS[key]);
  }
  return regionData[key];
}
console.log("Sunucu hazır (bölge verisi ilk istekte yüklenecek).");

function getFinder(region, timeName, alpha, accessible = false) {
  const key = `${region.id}:${timeName}:${alpha}:${accessible ? "a" : "n"}`;
  const cached = finderCache.get(key);
  if (cached) {
    finderCache.delete(key); // LRU: en son kullanılanı sona taşı
    finderCache.set(key, cached);
    return cached;
  }

  console.log(`[${region.id}] '${timeName}' alpha=${alpha} accessible=${accessible} grafiği kuruluyor...`);
  const finder = buildFinder(region.roadsScored, `safety_score_${timeName}`, alpha, region.id, accessible);
  finderCache.set(key, finder);

  while (finderCache.size > MAX_CACHED_FINDERS) {
    const oldestKey = finderCache.keys().next().value;
    finderCache.delete(oldestKey);
    console.log(`  önbellekten çıkarıldı: ${oldestKey}`);
  }
  return finder;
}

// Kullanıcının "güvenlik önceliği" kaydırıcısı (0-1) kesikli alpha seviyelerine
// yuvarlanır; her farklı alpha ayrı bir graf demek olduğundan sürekli değer
// pratik değil.
// Deneysel taramada (10 rastgele rota çifti) anlamlı sapmaların tetiklendiği eşikler
// 8, 14, 22, 30, 60 civarında çıktı; eski üst sınır (22) bazı durumlarda %35'e varan
// daha güvenli bir alternatifi tamamen kaçırıyordu çünkü rota o eşiğe hiç ulaşmıyordu.
// Üst uç yükseltildi ki "çok yüksek" gerçekten en agresif kaçınmayı temsil etsin.
const ALPHA_LEVELS = [2, 6, 14, 28, 55];

function alphaFromPreference(pref) {
  const p = Math.max(0, Math.min(1, Number.isFinite(pref) ? pref : 0.6));
  const idx = Math.round(p * (ALPHA_LEVELS.length - 1));
  return ALPHA_LEVELS[idx];
}

function getTimeName(requested) {
  return TIME_PROFILES.includes(requested) ? requested : currentTimeProfile();
}

function snapToNetwork(region, lng, lat) {
  return turf.nearestPoint(turf.point([lng, lat]), region.vertexPoints);
}

function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function turnLabel(delta) {
  const abs = Math.abs(delta);
  const yon = delta > 0 ? "sağa" : "sola";
  if (abs < 60) return `Hafif ${yon} dön`;
  if (abs < 130) return yon === "sağa" ? "Sağa dön" : "Sola dön";
  return `Keskin ${yon} dön`;
}

// Rota geometrisindeki yön (bearing) değişimlerinden basit adım adım yönlendirme üretir.
function buildSteps(lineCoords) {
  const line = turf.lineString(lineCoords);
  const totalKm = turf.length(line, { units: "kilometers" });
  const sampleKm = TURN_SAMPLE_M / 1000;

  const samples = [];
  for (let d = 0; d < totalKm; d += sampleKm) {
    samples.push(turf.along(line, d, { units: "kilometers" }).geometry.coordinates);
  }
  samples.push(lineCoords[lineCoords.length - 1]);

  if (samples.length < 3) {
    return [
      { instruction: "Başlangıç noktasından hedefe doğru yürü", distanceM: Math.round(totalKm * 1000), at: samples[0] },
      { instruction: "Hedefe ulaştın", distanceM: 0, at: lineCoords[lineCoords.length - 1] },
    ];
  }

  const steps = [{ instruction: "Yürümeye başla", distanceM: 0, at: samples[0] }];
  let currentBearing = turf.bearing(turf.point(samples[0]), turf.point(samples[1]));

  for (let i = 0; i < samples.length - 1; i++) {
    const segKm = turf.distance(turf.point(samples[i]), turf.point(samples[i + 1]), { units: "kilometers" });
    if (i > 0) {
      const b = turf.bearing(turf.point(samples[i]), turf.point(samples[i + 1]));
      const delta = angleDiff(currentBearing, b);
      if (Math.abs(delta) >= TURN_ANGLE_THRESHOLD) {
        steps.push({ instruction: turnLabel(delta), distanceM: 0, at: samples[i] });
        currentBearing = b;
      }
    }
    steps[steps.length - 1].distanceM += Math.round(segKm * 1000);
  }

  steps.push({ instruction: "Hedefe ulaştın", distanceM: 0, at: lineCoords[lineCoords.length - 1] });

  // Çok kısa ara adımları (gürültülü küçük dönüşleri) bir sonrakiyle birleştir
  const cleaned = [];
  for (const step of steps) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.distanceM < MIN_STEP_M && cleaned.length > 1) {
      prev.instruction = step.instruction;
      prev.distanceM += step.distanceM;
    } else {
      cleaned.push({ ...step });
    }
  }
  return cleaned;
}

// Rota çizgisi, kaynak yol ağıyla eşleştirilerek renk kodlu parçalara bölünür.
// pathToGeoJSON birleşik tek bir çizgi döndürdüğü için hangi bölümün hangi OSM
// segmentinden geldiği kaybolur; bu yüzden rota örneklenip her örnek noktası en
// yakın kaynak segmente geri eşlenir (map-matching).
const SEGMENT_SAMPLE_M = 25;
const MATCH_MAX_DIST_M = 35;

function buildSegmentIndex(roadsScored) {
  const index = new Map();
  const cell = 0.002;
  roadsScored.features.forEach((f, i) => {
    if (!f.geometry || f.geometry.type !== "LineString") return;
    const seen = new Set();
    for (const [lng, lat] of f.geometry.coordinates) {
      const key = `${Math.floor(lat / cell)},${Math.floor(lng / cell)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(i);
    }
  });
  return { index, cell };
}

function findNearestSegment(region, lng, lat) {
  const { index, cell } = region.segmentIndex;
  const cLat = Math.floor(lat / cell);
  const cLng = Math.floor(lng / cell);
  const pt = turf.point([lng, lat]);
  let best = null;
  let bestDist = Infinity;
  const checked = new Set();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const bucket = index.get(`${cLat + dLat},${cLng + dLng}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (checked.has(idx)) continue;
        checked.add(idx);
        const feature = region.roadsScored.features[idx];
        const snapped = turf.nearestPointOnLine(feature, pt, { units: "meters" });
        if (snapped.properties.dist < bestDist) {
          bestDist = snapped.properties.dist;
          best = feature;
        }
      }
    }
  }
  return bestDist <= MATCH_MAX_DIST_M ? best : null;
}

function buildSegments(region, lineCoords, scoreField, breakdownField) {
  const line = turf.lineString(lineCoords);
  const totalKm = turf.length(line, { units: "kilometers" });
  const stepKm = SEGMENT_SAMPLE_M / 1000;

  const parts = [];
  let prev = null;

  for (let d = 0; d <= totalKm; d += stepKm) {
    const coord = turf.along(line, Math.min(d, totalKm), { units: "kilometers" }).geometry.coordinates;
    const match = findNearestSegment(region, coord[0], coord[1]);
    const baseScore = match ? match.properties[scoreField] : null;
    const reportEffect = Math.round(reportEffectAt(region.id, coord[0], coord[1]));
    const score = baseScore == null ? null : Math.max(0, Math.min(100, baseScore - reportEffect));

    if (prev && prev.score === score) {
      prev.coordinates.push(coord);
      prev.lengthKm += stepKm;
    } else {
      if (prev) prev.coordinates.push(coord); // parçalar arasında görsel boşluk kalmasın
      prev = {
        score,
        baseScore,
        reportEffect,
        name: match ? match.properties.name || null : null,
        highway: match ? match.properties.highway : null,
        buurt: match ? match.properties.buurt || null : null,
        breakdown: match ? match.properties[breakdownField] || null : null,
        coordinates: [coord],
        lengthKm: stepKm,
      };
      parts.push(prev);
    }
  }
  return parts.filter((p) => p.coordinates.length >= 2);
}

function computeRoute(region, startLng, startLat, endLng, endLat, finder, timeName) {
  const startSnap = snapToNetwork(region, startLng, startLat);
  const endSnap = snapToNetwork(region, endLng, endLat);

  const result = finder.findPath(startSnap, endSnap);
  if (!result) return null;

  const line = pathToGeoJSON(result);
  const distanceKm = turf.length(line, { units: "kilometers" });

  // İstatistikler segmentlerden hesaplanır: böylece kullanıcı raporlarının etkisi
  // hem haritadaki renklere hem de özet skorlara aynı şekilde yansır.
  const segments = buildSegments(
    region,
    line.geometry.coordinates,
    `safety_score_${timeName}`,
    `safety_breakdown_${timeName}`
  );

  let avgSafety = null;
  let minSafety = null;
  const scored = segments.filter((s) => s.score != null);
  if (scored.length) {
    const totalLen = scored.reduce((s, x) => s + x.lengthKm, 0);
    avgSafety = totalLen
      ? Math.round(scored.reduce((s, x) => s + x.score * x.lengthKm, 0) / totalLen)
      : null;
    minSafety = Math.min(...scored.map((s) => s.score));
  }

  return {
    route: line,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMin: Math.round((distanceKm / WALK_SPEED_KMH) * 60),
    avgSafetyScore: avgSafety,
    minSafetyScore: minSafety,
    hasSteps: segments.some((s) => s.highway === "steps"),
    segments,
    steps: buildSteps(line.geometry.coordinates),
    snappedStart: startSnap.geometry.coordinates,
    snappedEnd: endSnap.geometry.coordinates,
  };
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(CLIENT_DIR));

app.get("/api/regions", (_req, res) => {
  res.json({
    // Bölge verisi tembel yüklendiği için burada statik yapılandırma kullanılır;
    // bbox frontend'de kullanılmıyor, gereksiz yükleme tetiklemeyelim.
    regions: Object.entries(REGIONS).map(([id, r]) => ({ id, label: r.label, center: r.center })),
    currentTimeProfile: currentTimeProfile(),
  });
});

app.get("/api/route", (req, res) => {
  const { startLat, startLng, endLat, endLng, region: regionId, time, safetyPref, accessible } = req.query;
  if (!startLat || !startLng || !endLat || !endLng) {
    return res.status(400).json({ error: "startLat, startLng, endLat, endLng zorunlu" });
  }

  const region = getRegion(regionId);
  const timeName = getTimeName(time);
  const alpha = alphaFromPreference(parseFloat(safetyPref));
  const isAccessible = accessible === "1" || accessible === "true";
  const sLng = parseFloat(startLng);
  const sLat = parseFloat(startLat);
  const eLng = parseFloat(endLng);
  const eLat = parseFloat(endLat);

  try {
    const fastFinder = getFinder(region, timeName, 0, isAccessible);
    const safeFinder = getFinder(region, timeName, alpha, isAccessible);
    const fastRoute = computeRoute(region, sLng, sLat, eLng, eLat, fastFinder, timeName);
    const safeRoute = computeRoute(region, sLng, sLat, eLng, eLat, safeFinder, timeName);

    if (!fastRoute || !safeRoute) {
      return res.status(404).json({ error: "Bu iki nokta arasında rota bulunamadı (ağ dışında olabilir)." });
    }

    res.json({ fast: fastRoute, safe: safeRoute, timeProfile: timeName, alpha });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası: " + err.message });
  }
});

app.get("/api/bounds", (req, res) => {
  const region = getRegion(req.query.region);
  res.json({ bbox: region.bbox });
});

// --- Şehir geneli ısı haritası ---
// Tüm yol ağını 27k+ ayrı Polyline olarak göndermek/render etmek hem payload'ı
// (~5MB) hem tarayıcıyı şişirir. Bunun yerine segmentler skor bandına göre 5 grupta
// (kırmızı..yeşil) tek MultiLineString'e birleştirilir — tarayıcı yalnızca 5 çizim
// nesnesi render eder, koordinatlar da hafif basitleştirilir.
const HEATMAP_BANDS = [
  { max: 35, color: "#dc2626", label: "0-34" },
  { max: 50, color: "#f97316", label: "35-49" },
  { max: 65, color: "#eab308", label: "50-64" },
  { max: 80, color: "#84cc16", label: "65-79" },
  { max: 101, color: "#16a34a", label: "80+" },
];
const heatmapCache = new Map(); // "regionId:timeName" -> hazır bant listesi

function buildHeatmap(region, timeName) {
  const scoreField = `safety_score_${timeName}`;
  const buckets = HEATMAP_BANDS.map(() => []);
  for (const f of region.roadsScored.features) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    const score = f.properties[scoreField];
    if (score == null) continue;
    const bandIdx = HEATMAP_BANDS.findIndex((b) => score < b.max);
    // Basitleştirme: her 3. koordinatı al (uçlar hariç) — şehir ölçeğinde görsel
    // farkı yaratmaz ama payload'ı ciddi küçültür.
    const coords = f.geometry.coordinates;
    const simplified =
      coords.length > 4 ? coords.filter((_, i) => i === 0 || i === coords.length - 1 || i % 3 === 0) : coords;
    buckets[bandIdx === -1 ? HEATMAP_BANDS.length - 1 : bandIdx].push(simplified);
  }
  return HEATMAP_BANDS.map((b, i) => ({ color: b.color, label: b.label, lines: buckets[i] }));
}

app.get("/api/heatmap", (req, res) => {
  const region = getRegion(req.query.region);
  const timeName = getTimeName(req.query.time);
  const key = `${region.id}:${timeName}`;
  if (!heatmapCache.has(key)) {
    heatmapCache.set(key, buildHeatmap(region, timeName));
  }
  res.json({ bands: heatmapCache.get(key), timeProfile: timeName });
});

// --- Sığınılabilecek noktalar: polis, hastane, eczane, market, 24s açık yerler ---
// Kapalı bir eczane sığınak değildir; bu yüzden her nokta seçilen saate göre
// "şu an açık mı" bilgisiyle döner. Polis/hastane 7/24 kabul edilir.
const SAFE_HAVEN_TYPES = {
  police: { label: "Polis", always: true },
  hospital: { label: "Hastane (acil)", always: true },
  fire_station: { label: "İtfaiye", always: true },
  pharmacy: { label: "Eczane", always: false },
  fuel: { label: "Benzinlik", always: false },
  clinic: { label: "Klinik", always: false },
  doctors: { label: "Aile hekimi", always: false },
  taxi: { label: "Taksi durağı", always: false },
  bank: { label: "Banka / ATM", always: false },
  post_office: { label: "PTT", always: false },
  library: { label: "Kütüphane", always: false },
  community_centre: { label: "Semt merkezi", always: false },
  townhall: { label: "Belediye binası", always: false },
  social_facility: { label: "Sosyal hizmet merkezi", always: false },
  place_of_worship: { label: "İbadethane", always: false },
};
const SAFE_HAVEN_SHOPS = { supermarket: "Market", convenience: "Büfe / market" };
// Otel resepsiyonu ve tren istasyonu gece de personelli/aydınlık olduğundan sığınak sayılır
const SAFE_HAVEN_OTHER = { hotel: "Otel (resepsiyon)", station: "İstasyon" };
const TIME_PROFILE_HOURS = { morning: 8, midday: 13, evening: 17, night: 20, lateNight: 0 };

function inHourRange(hour, open, close) {
  if (close <= open) close += 24;
  return (hour >= open && hour < close) || (hour + 24 >= open && hour + 24 < close);
}

const HAVEN_DEFAULT_HOURS = {
  pharmacy: [8, 19],
  fuel: [6, 23],
  supermarket: [8, 21],
  convenience: [7, 23],
  clinic: [8, 18],
  doctors: [8, 17],
  taxi: [0, 24],
  hotel: [0, 24], // resepsiyon 7/24
  station: [5, 26], // ilk seferden son sefere
  bank: [9, 18],
  post_office: [9, 18],
  library: [9, 20],
  community_centre: [9, 22], // akşam etkinlikleri de olur
  townhall: [8, 17],
  social_facility: [8, 20],
  place_of_worship: [7, 21], // pek çoğu gündüz-akşam ziyarete açık; gece 22-07 kapalı varsayılır
};

function havenKind(props) {
  return props.amenity || props.shop || props.tourism || props.railway || props.public_transport;
}

function isHavenOpenAt(props, hour) {
  const kind = havenKind(props);
  if (SAFE_HAVEN_TYPES[kind]?.always) return true;
  const oh = props.opening_hours;
  if (oh) {
    if (/24\/7/.test(oh)) return true;
    const ranges = [...oh.matchAll(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/g)];
    if (ranges.length) {
      return ranges.some((m) => inHourRange(hour, +m[1] + +m[2] / 60, +m[3] + +m[4] / 60));
    }
  }
  const fallback = HAVEN_DEFAULT_HOURS[kind];
  return fallback ? inHourRange(hour, fallback[0], fallback[1]) : false;
}

app.get("/api/safe-havens", (req, res) => {
  const region = getRegion(req.query.region);
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat ve lng zorunlu" });
  }

  const timeName = getTimeName(req.query.time);
  const hour = TIME_PROFILE_HOURS[timeName] ?? new Date().getHours();
  const from = turf.point([lng, lat]);

  const havens = region.amenities.features
    .filter((f) => {
      const kind = havenKind(f.properties);
      return SAFE_HAVEN_TYPES[kind] || SAFE_HAVEN_SHOPS[kind] || SAFE_HAVEN_OTHER[kind];
    })
    .map((f) => {
      const kind = havenKind(f.properties);
      const label = SAFE_HAVEN_TYPES[kind]?.label || SAFE_HAVEN_SHOPS[kind] || SAFE_HAVEN_OTHER[kind];
      const isOpen = isHavenOpenAt(f.properties, hour);
      return {
        type: kind,
        typeLabel: label,
        name: f.properties.name || label,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        distanceM: Math.round(turf.distance(from, f, { units: "meters" })),
        isOpen,
        alwaysOpen: !!SAFE_HAVEN_TYPES[kind]?.always,
      };
    })
    // Açık olanlar önce, sonra mesafeye göre
    .sort((a, b) => (a.isOpen === b.isOpen ? a.distanceM - b.distanceM : a.isOpen ? -1 : 1))
    .slice(0, 12);

  res.json({ havens, timeProfile: timeName });
});

// --- Kullanıcı raporları: uç noktalar ---
// Prototip olduğu için JSON dosyasında tutuluyor; üretimde veritabanı olurdu.
function readReports() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writeReports(reports) {
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
  // Raporlar rota maliyetini etkilediği için önbellekteki graflar geçersizleşir
  finderCache.clear();
  reportCache = null;
}

function getWeightedReports(regionId) {
  if (!reportCache) {
    const now = Date.now();
    reportCache = {};
    for (const r of readReports()) {
      const ageDays = (now - new Date(r.createdAt).getTime()) / 86400000;
      const decay = Math.pow(0.5, ageDays / REPORT_HALFLIFE_DAYS);
      const typeWeight = REPORT_WEIGHTS[r.type] ?? 0.5;
      const confirms = Array.isArray(r.confirmations) ? r.confirmations.length : r.confirmations || 0;
      const weight = typeWeight * decay * (1 + confirms * CONFIRM_BONUS);
      if (!reportCache[r.region]) reportCache[r.region] = [];
      reportCache[r.region].push({ lat: r.lat, lng: r.lng, weight, type: r.type });
    }
  }
  return reportCache[regionId] || [];
}

// Bir koordinattaki net rapor etkisi: pozitif = skoru düşürür (riskli),
// negatif = skoru yükseltir ("burası güvenli" raporları).
function reportEffectAt(regionId, lng, lat) {
  const list = getWeightedReports(regionId);
  if (!list.length) return 0;
  let sum = 0;
  for (const r of list) {
    const d = haversineMeters(lat, lng, r.lat, r.lng);
    if (d > REPORT_RADIUS_M) continue;
    // Merkeze yakın raporlar daha etkili (doğrusal azalma)
    sum += r.weight * (1 - d / REPORT_RADIUS_M);
  }
  if (sum === 0) return 0;
  const sign = Math.sign(sum);
  const scaled = Math.sqrt(Math.abs(sum) / REPORT_SATURATION);
  return sign * Math.min(1, scaled) * MAX_REPORT_EFFECT;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.get("/api/reports", (req, res) => {
  const regionId = req.query.region;
  const all = readReports();
  const filtered = regionId ? all.filter((r) => r.region === regionId) : all;
  const now = Date.now();
  res.json({
    reports: filtered.map((r) => {
      const ageDays = (now - new Date(r.createdAt).getTime()) / 86400000;
      const confirms = Array.isArray(r.confirmations) ? r.confirmations.length : r.confirmations || 0;
      return {
        ...r,
        confirmations: confirms,
        // 0-1 arası güven göstergesi (arayüzde şeffaflık için)
        trust: Math.round(
          Math.min(1, Math.pow(0.5, ageDays / REPORT_HALFLIFE_DAYS) * (1 + confirms * CONFIRM_BONUS)) * 100
        ),
      };
    }),
    types: REPORT_TYPES,
  });
});

app.post("/api/reports", (req, res) => {
  const { lat, lng, type, note, region: regionId } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !REPORT_TYPES[type]) {
    return res.status(400).json({ error: "Geçerli lat, lng ve type zorunlu" });
  }
  const reports = readReports();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    lat,
    lng,
    type,
    note: typeof note === "string" ? note.slice(0, 280) : "",
    region: getRegion(regionId).id,
    createdAt: new Date().toISOString(),
    confirmations: 0,
  };
  reports.push(entry);
  writeReports(reports);
  res.json({ ok: true, report: { ...entry, trust: 100 } });
});

// Başka kullanıcılar bir raporu teyit edebilir; teyit güven ağırlığını artırır.
app.post("/api/reports/:id/confirm", (req, res) => {
  const reports = readReports();
  const idx = reports.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Rapor bulunamadı" });
  const current = reports[idx].confirmations;
  reports[idx].confirmations = (Array.isArray(current) ? current.length : current || 0) + 1;
  writeReports(reports);
  res.json({ ok: true, confirmations: reports[idx].confirmations });
});

app.get("/api/geocode", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });

  const region = getRegion(req.query.region);
  const bbox = region.bbox;
  const viewbox = `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`;
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=6&addressdetails=0` +
    `&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(q)}`;

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "SafeRoute-thesis-project/1.0 (school project demo)" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json({
      results: data.map((d) => ({
        label: d.display_name,
        lat: parseFloat(d.lat),
        lng: parseFloat(d.lon),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Adres araması başarısız: " + err.message });
  }
});

// --- Acil durum: canlı konum paylaşımı ---
// Basit bellek-içi oturum: kullanıcı "konumumu paylaş" dediğinde bir id üretilir,
// telefon periyodik olarak konumunu bu id'ye "ping" eder, paylaşılan link ise aynı
// id'den son konumu okur (kısa aralıklarla yoklayarak canlı takip sağlar).
const EMERGENCY_TTL_MS = 6 * 60 * 60 * 1000; // 6 saat sonra oturum kendiliğinden kapanır
const emergencySessions = new Map();

function pruneEmergencySessions() {
  const now = Date.now();
  for (const [id, s] of emergencySessions) {
    if (now - s.updatedAt > EMERGENCY_TTL_MS) emergencySessions.delete(id);
  }
}

app.post("/api/emergency/start", (req, res) => {
  pruneEmergencySessions();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const { lat, lng, label } = req.body || {};
  emergencySessions.set(id, {
    id,
    label: typeof label === "string" ? label.slice(0, 60) : "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    active: true,
  });
  res.json({ id });
});

app.post("/api/emergency/:id/ping", (req, res) => {
  const s = emergencySessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Oturum bulunamadı (süresi dolmuş olabilir)" });
  const { lat, lng } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat ve lng zorunlu" });
  }
  s.lat = lat;
  s.lng = lng;
  s.updatedAt = Date.now();
  res.json({ ok: true });
});

app.post("/api/emergency/:id/stop", (req, res) => {
  const s = emergencySessions.get(req.params.id);
  if (s) s.active = false;
  res.json({ ok: true });
});

app.get("/api/emergency/:id", (req, res) => {
  const s = emergencySessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Oturum bulunamadı (süresi dolmuş olabilir)" });
  res.json({
    label: s.label,
    lat: s.lat,
    lng: s.lng,
    active: s.active,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    ageSeconds: Math.round((Date.now() - s.updatedAt) / 1000),
  });
});

// Haritadan seçilen noktayı okunabilir bir adrese çevirir (koordinat göstermek yerine).
const reverseCache = new Map();

app.get("/api/reverse", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat ve lng zorunlu" });
  }
  // Yakın koordinatlar aynı adresi verir; Nominatim'i yormamak için yuvarlayıp önbelleğe alıyoruz
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return res.json({ label: reverseCache.get(key) });

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=${lat}&lon=${lng}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "SafeRoute-thesis-project/1.0 (school project demo)" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const a = data.address || {};
    const parts = [a.road || a.pedestrian || a.footway || a.neighbourhood, a.suburb || a.city_district, a.city || a.town || a.village];
    const label = parts.filter(Boolean).join(", ") || data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (reverseCache.size > 500) reverseCache.clear();
    reverseCache.set(key, label);
    res.json({ label });
  } catch {
    res.json({ label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
  }
});

// --- Kullanıcı çalışması: kör A/B testi ---
// Tez için doğrulama verisi: kullanıcıya hangisinin "güvenli" hangisinin "hızlı"
// olduğu SÖYLENMEDEN iki rota gösterilir ("A" ve "B", rastgele sırayla), "gece
// yalnız yürürken hangisini seçerdin?" sorulur. Sonuç: algoritmanın önerdiği rota
// kör test altında ne sıklıkla tercih ediliyor?
const STUDY_PATH = path.join(DATA_ROOT, "study_responses.json");
function readStudyResponses() {
  try {
    return JSON.parse(fs.readFileSync(STUDY_PATH, "utf8"));
  } catch {
    return [];
  }
}

app.get("/api/study/scenario", (req, res) => {
  const region = getRegion(req.query.region);
  const timeName = getTimeName(req.query.time);
  const [minLng, minLat, maxLng, maxLat] = region.bbox;

  let attempt = 0;
  let fastRoute = null;
  let safeRoute = null;
  let sLat, sLng, eLat, eLng;

  // Anlamlı bir seçim olsun diye rota gerçekten farklılaşana kadar rastgele
  // nokta çiftleri dener.
  while (attempt < 30) {
    attempt++;
    sLat = minLat + Math.random() * (maxLat - minLat);
    sLng = minLng + Math.random() * (maxLng - minLng);
    eLat = Math.max(minLat, Math.min(maxLat, sLat + (Math.random() - 0.5) * 0.02));
    eLng = Math.max(minLng, Math.min(maxLng, sLng + (Math.random() - 0.5) * 0.03));

    try {
      const fastFinder = getFinder(region, timeName, 0, false);
      const safeFinder = getFinder(region, timeName, 8, false);
      fastRoute = computeRoute(region, sLng, sLat, eLng, eLat, fastFinder, timeName);
      safeRoute = computeRoute(region, sLng, sLat, eLng, eLat, safeFinder, timeName);
    } catch {
      fastRoute = null;
      safeRoute = null;
      continue;
    }
    if (!fastRoute || !safeRoute) continue;
    if (fastRoute.distanceKm < 0.3 || fastRoute.distanceKm > 2.5) continue;
    const meaningfullyDifferent = safeRoute.avgSafetyScore - fastRoute.avgSafetyScore >= 5;
    if (meaningfullyDifferent) break;
    fastRoute = null;
    safeRoute = null;
  }

  if (!fastRoute || !safeRoute) {
    return res.status(404).json({ error: "Bu bölgede anlamlı bir senaryo bulunamadı, tekrar dene." });
  }

  // Rastgele A/B etiketleme — kullanıcı hangisinin "güvenli" olduğunu göremesin
  const safeIsA = Math.random() < 0.5;
  const scenarioId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  res.json({
    scenarioId,
    region: region.id,
    timeProfile: timeName,
    routeA: safeIsA ? safeRoute : fastRoute,
    routeB: safeIsA ? fastRoute : safeRoute,
    safeIsA,
  });
});

app.post("/api/study/respond", (req, res) => {
  const { scenarioId, region, chosen, safeIsA, distanceA, distanceB, avgSafetyA, avgSafetyB } = req.body || {};
  if (!scenarioId || (chosen !== "A" && chosen !== "B")) {
    return res.status(400).json({ error: "scenarioId ve chosen ('A' ya da 'B') zorunlu" });
  }
  const responses = readStudyResponses();
  const chosenIsSafe = (chosen === "A") === !!safeIsA;
  responses.push({
    scenarioId,
    region: getRegion(region).id,
    chosen,
    chosenIsSafe,
    safeIsA: !!safeIsA,
    distanceA,
    distanceB,
    avgSafetyA,
    avgSafetyB,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(STUDY_PATH, JSON.stringify(responses, null, 2));
  res.json({ ok: true });
});

app.get("/api/study/results", (req, res) => {
  const regionId = req.query.region;
  const all = readStudyResponses();
  const filtered = regionId ? all.filter((r) => r.region === regionId) : all;
  const total = filtered.length;
  const safeChosen = filtered.filter((r) => r.chosenIsSafe).length;
  const avgDetourPct = total
    ? filtered.reduce((s, r) => {
        const fastD = r.safeIsA ? r.distanceB : r.distanceA;
        const safeD = r.safeIsA ? r.distanceA : r.distanceB;
        return s + (fastD ? ((safeD - fastD) / fastD) * 100 : 0);
      }, 0) / total
    : null;

  res.json({
    total,
    safeChosen,
    safeChosenPct: total ? Math.round((safeChosen / total) * 100) : null,
    avgDetourPct: avgDetourPct != null ? Math.round(avgDetourPct * 10) / 10 : null,
  });
});

app.listen(PORT, () => {
  console.log(`SafeRoute API http://localhost:${PORT} üzerinde çalışıyor`);
});
