// Foursquare Open Source Places (Apache 2.0, açık lisans - bkz.
// https://opensource.foursquare.com/os-places/) ile OSM+Overture'a üçüncü bir
// katman ekler. Gerçek POI toplama geçmişi (check-in tabanlı, 15+ yıllık)
// Meta/Microsoft'tan bağımsız olduğundan Overture'ın kaçırdığı işletmeleri
// de yakalıyor.
//
// Erişim "gated" (ücretsiz ama Hugging Face hesabı + veri kullanım onayı
// gerekiyor) - bkz. https://huggingface.co/datasets/foursquare/fsq-os-places
// HF_TOKEN ortam değişkeni olarak bir read-token gerekli (kullanıcının kendi
// hesabından, asla koda/commit'e yazılmaz).
//
// Kullanım: HF_TOKEN=hf_... node fetch-foursquare-places.js <bölge-klasör-adı>
// fetch-region.js (OSM) ve fetch-overture-places.js'den SONRA çalıştırılmalı.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const turf = require("@turf/turf");

const regionDir = process.argv[2];
if (!regionDir) {
  console.error("Kullanım: HF_TOKEN=hf_... node fetch-foursquare-places.js <bölge-klasör-adı>");
  process.exit(1);
}
if (!process.env.HF_TOKEN) {
  console.error("HF_TOKEN ortam değişkeni gerekli (bkz. dosyanın başındaki not).");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "..", "data", regionDir);
const DEDUPE_RADIUS_M = 30;

function normalizeForMatch(s) {
  return (s || "")
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]/g, "");
}
function namesLikelyMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length < 3 || nb.length < 3) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return long.includes(short);
}

function loadRoadsBbox() {
  const roads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "roads_scored.geojson")));
  return turf.bbox(roads);
}

function queryFoursquare(bbox) {
  const outPath = path.join(DATA_DIR, "_fsq_raw.geojson");
  const scriptPath = path.join(__dirname, "fsq_query.py");
  console.log(`-> Foursquare OS Places sorgulanıyor (bbox: ${bbox.join(",")})...`);
  execFileSync("python3", [scriptPath, ...bbox.map(String), outPath], { stdio: "inherit" });
  const data = JSON.parse(fs.readFileSync(outPath));
  fs.unlinkSync(outPath);
  return data;
}

function main() {
  const bbox = loadRoadsBbox();
  const fsq = queryFoursquare(bbox);
  console.log(`   ${fsq.features.length} Foursquare POI (filtrelenmiş) alındı.`);

  const osmPath = path.join(DATA_DIR, "amenities.geojson");
  const current = JSON.parse(fs.readFileSync(osmPath));
  // Dedup referansı: hem orijinal OSM hem daha önce eklenmiş Overture
  // kayıtları (Foursquare'in kendi eski katmanı hariç, idempotent olsun diye).
  const baseline = current.features.filter((f) => f.properties?.source !== "foursquare");
  console.log(`   dedup referansı: ${baseline.length} kayıt (OSM+Overture)`);

  const CELL = 0.001;
  const index = new Map();
  const cellKey = (lng, lat) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
  for (const f of baseline) {
    if (f.geometry?.type !== "Point") continue;
    const [lng, lat] = f.geometry.coordinates;
    const key = cellKey(lng, lat);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push([lng, lat, f.properties?.name]);
  }
  function findNearbyMatch(lng, lat, name) {
    const cLat = Math.floor(lat / CELL);
    const cLng = Math.floor(lng / CELL);
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const bucket = index.get(`${cLat + dLat},${cLng + dLng}`);
        if (!bucket) continue;
        for (const [olng, olat, oname] of bucket) {
          const dLatM = (olat - lat) * 111320;
          const dLngM = (olng - lng) * Math.cos((lat * Math.PI) / 180) * 111320;
          if (Math.sqrt(dLatM * dLatM + dLngM * dLngM) <= DEDUPE_RADIUS_M && namesLikelyMatch(oname, name)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  let added = 0,
    skippedDupe = 0;
  const fsqFeatures = [];
  for (const f of fsq.features) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    if (findNearbyMatch(lng, lat, p.name)) {
      skippedDupe++;
      continue;
    }
    fsqFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { ...p, source: "foursquare" },
    });
    added++;
  }
  console.log(`   eklendi: ${added}, OSM/Overture ile çakıştığı için elendi: ${skippedDupe}`);

  const merged = { type: "FeatureCollection", features: [...baseline, ...fsqFeatures] };
  fs.writeFileSync(osmPath, JSON.stringify(merged));
  console.log(`   ${osmPath} güncellendi: toplam ${merged.features.length} işletme/POI.`);
}

main();
