// roads_scored.geojson ve amenities.geojson dosyalarını istemci (tarayıcı/telefon)
// tarafında kullanılacak şekilde küçültür: geometri basitleştirilir, koordinat
// hassasiyeti azaltılır, kullanılmayan alanlar atılır. Çıktı client/public/data/
// altına yazılır — rota motoru artık tamamen tarayıcıda çalışacağı için bu
// dosyalar tarayıcıya indirilecek statik varlıklardır.
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

// NOT: Geometri sadeleştirme (turf.simplify) KASITLI OLARAK KAPALI. Her feature
// bağımsız sadeleştirildiğinde, bir yolun ortasına bağlanan T-kavşak noktaları
// (o noktayı sadece kesişen küçük sokağın ucu olarak "gören" özellik dışında)
// silinebiliyor — bu da yol ağını yüzlerce kopuk parçaya bölüyor (test: Nuenen'de
// 51 bağlı bileşen yerine 702, ana bileşen boyutu 11993->4399 köşe). Sadeleştirme
// olmadan ~26MB ham veri de gzip ile ~1.3MB'a iniyor (bkz. proje notları), bu yüzden
// bağlantı bütünlüğü feda edilmeden payload zaten kabul edilebilir seviyede.
const SIMPLIFY_TOLERANCE = 0;
const COORD_PRECISION = 6; // ~11cm hassasiyet, OSM kaynağından zaten daha kaba

function roundCoords(coords, precision) {
  return coords.map(([lng, lat]) => [+lng.toFixed(precision), +lat.toFixed(precision)]);
}

// Basit union-find: yol ağının kaç ayrı bağlı bileşene bölündüğünü bulur.
class UnionFind {
  constructor() {
    this.parent = new Map();
    this.size = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // yol sıkıştırma
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const sa = this.size.get(ra);
    const sb = this.size.get(rb);
    if (sa < sb) {
      this.parent.set(ra, rb);
      this.size.set(rb, sa + sb);
    } else {
      this.parent.set(rb, ra);
      this.size.set(ra, sa + sb);
    }
  }
}

// Bir yaya OSM'de gerçekte var olan ama veri setinde çekilmemiş bir bağlantı
// yüzünden (nadir OSM etiketleme boşlukları, harita dışı kısımlar vb.) küçük,
// ana ağdan kopuk bir "adacığa" düşerse, o adacığın içindeki HERHANGİ bir
// noktaya rota istendiğinde "bulunamadı" hatası alınır — kullanıcı için anlamsız
// bir hata deneyimi. Küçük adacıkları veri setinden tamamen çıkarmak (yalnızca
// en büyük bağlı bileşeni tutmak), tıklanan iki nokta ne olursa olsun rotanın
// her zaman bulunabilmesini garanti eder. İzmir bölgelerinde bu adım olmadan
// rastgele nokta çiftlerinin ~%13-80'i "bulunamadı" veriyordu (bkz. proje notları).
function keepLargestComponent(features) {
  const uf = new UnionFind();
  const keyOf = ([lng, lat]) => `${lng},${lat}`;
  for (const f of features) {
    const coords = f.geometry.coordinates;
    for (let i = 1; i < coords.length; i++) {
      uf.union(keyOf(coords[i - 1]), keyOf(coords[i]));
    }
  }
  // En büyük köke sahip bileşeni bul
  const rootSizes = new Map();
  for (const key of uf.parent.keys()) {
    const root = uf.find(key);
    rootSizes.set(root, (rootSizes.get(root) || 0) + 1);
  }
  let bestRoot = null;
  let bestSize = -1;
  for (const [root, size] of rootSizes) {
    if (size > bestSize) {
      bestSize = size;
      bestRoot = root;
    }
  }
  const kept = features.filter((f) => uf.find(keyOf(f.geometry.coordinates[0])) === bestRoot);
  return { kept, totalVertices: uf.parent.size, mainComponentVertices: bestSize };
}

function buildRoads(dataDir, outDir) {
  const roads = JSON.parse(fs.readFileSync(path.join(dataDir, "roads_scored.geojson")));
  let coordsBefore = 0,
    coordsAfter = 0;

  const lite = {
    type: "FeatureCollection",
    features: roads.features
      .filter((f) => f.geometry && f.geometry.type === "LineString" && f.geometry.coordinates.length >= 2)
      .map((f) => {
        let coords = f.geometry.coordinates;
        coordsBefore += coords.length;
        if (SIMPLIFY_TOLERANCE && coords.length > 3) {
          coords = turf.simplify(turf.lineString(coords), { tolerance: SIMPLIFY_TOLERANCE, highQuality: false })
            .geometry.coordinates;
        }
        coords = roundCoords(coords, COORD_PRECISION);
        coordsAfter += coords.length;

        // Sadece rota motoru + arayüzün gerçekten kullandığı alanlar taşınır
        const p = f.properties;
        const props = { highway: p.highway, length_m: p.length_m };
        if (p.name) props.name = p.name;
        if (p.buurt) props.buurt = p.buurt;
        for (const t of ["morning", "midday", "evening", "night", "lateNight"]) {
          props[`s_${t}`] = p[`safety_score_${t}`];
          if (p[`safety_breakdown_${t}`]) props[`b_${t}`] = p[`safety_breakdown_${t}`];
        }
        return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props };
      }),
  };

  const { kept, totalVertices, mainComponentVertices } = keepLargestComponent(lite.features);
  const droppedCount = lite.features.length - kept.length;
  lite.features = kept;
  console.log(
    `  bağlı bileşen: ${mainComponentVertices}/${totalVertices} köşe (%${Math.round(
      (100 * mainComponentVertices) / totalVertices
    )}) ana ağda, ${droppedCount} segment kopuk adacık olduğu için çıkarıldı`
  );

  fs.mkdirSync(outDir, { recursive: true });

  // Cloudflare Pages dosya başına 25MB sınırı koyuyor (Eindhoven tek parça ~27MB).
  // Yol ağını bölmek (simplify ile) bağlantı bütünlüğünü bozduğundan (bkz. yukarıdaki
  // not), bunun yerine veri kaybı olmadan birden fazla dosyaya parçalanıyor; tarayıcı
  // motoru (worker.js) tüm parçaları çekip tek FeatureCollection'da birleştiriyor.
  const MAX_SHARD_BYTES = 18 * 1024 * 1024; // güvenlik payı bırakılarak 25MB sınırının altında
  const shards = [];
  let current = [];
  let currentBytes = 0;
  for (const feature of lite.features) {
    const featBytes = Buffer.byteLength(JSON.stringify(feature));
    if (current.length && currentBytes + featBytes > MAX_SHARD_BYTES) {
      shards.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(feature);
    currentBytes += featBytes;
  }
  if (current.length) shards.push(current);

  shards.forEach((features, i) => {
    const outPath = path.join(outDir, `roads-${i}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features }));
  });
  fs.writeFileSync(path.join(outDir, "roads-manifest.json"), JSON.stringify({ shardCount: shards.length }));

  const totalSizeMB = (
    shards.reduce((s, features, i) => s + fs.statSync(path.join(outDir, `roads-${i}.json`)).size, 0) /
    1024 /
    1024
  ).toFixed(2);
  console.log(
    `  roads-*.json: ${lite.features.length} segment, koordinat ${coordsBefore}->${coordsAfter}, ` +
      `${shards.length} parça, toplam ${totalSizeMB}MB`
  );
}

function buildAmenities(dataDir, outDir) {
  const am = JSON.parse(fs.readFileSync(path.join(dataDir, "amenities.geojson")));
  const lite = {
    type: "FeatureCollection",
    features: am.features
      .filter((f) => f.geometry && f.geometry.type === "Point")
      .map((f) => {
        const p = f.properties;
        const props = {};
        if (p.amenity) props.amenity = p.amenity;
        if (p.shop) props.shop = p.shop;
        if (p.tourism) props.tourism = p.tourism;
        if (p.railway) props.railway = p.railway;
        if (p.name) props.name = p.name;
        if (p.opening_hours) props.opening_hours = p.opening_hours;
        return { type: "Feature", geometry: f.geometry, properties: props };
      }),
  };
  const outPath = path.join(outDir, "amenities.json");
  fs.writeFileSync(outPath, JSON.stringify(lite));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`  amenities.json: ${lite.features.length} işletme, ${sizeMB}MB`);
}

function main() {
  const regions = ["eindhoven", "nuenen", "bornova", "buca", "gaziemir", "alsancak"];
  for (const region of regions) {
    console.log(`[${region}]`);
    const dataDir = path.join(__dirname, "..", "..", "data", region);
    const outDir = path.join(__dirname, "..", "..", "client", "public", "data", region);
    buildRoads(dataDir, outDir);
    buildAmenities(dataDir, outDir);
  }
  console.log("\nTamamlandı.");
}

main();
