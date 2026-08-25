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

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "roads.json");
  fs.writeFileSync(outPath, JSON.stringify(lite));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(
    `  roads.json: ${lite.features.length} segment, koordinat ${coordsBefore}->${coordsAfter}, ${sizeMB}MB`
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
  const regions = ["eindhoven", "nuenen"];
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
