// Verilen bir OSM alan adı için yol ağı, lamba ve işletme verisini Overpass API'den çekip
// GeoJSON olarak kaydeder. Kullanım: node fetch-region.js "Nuenen" nuenen [--force]
const fs = require("fs");
const path = require("path");
const osmtogeojson = require("osmtogeojson");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const areaName = process.argv[2];
const outDirName = process.argv[3];
if (!areaName || !outDirName) {
  console.error('Kullanım: node fetch-region.js "<OSM alan adı>" <çıktı-klasör-adı> [--force]');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, "..", "..", "data", outDirName);

async function runQuery(query) {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      "User-Agent": "SafeRoute-thesis-project/1.0 (curl-like client)",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) {
    throw new Error(`Overpass hata: HTTP ${res.status} - ${await res.text()}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAndSave(name, query, retries = 4) {
  console.log(`-> ${name} çekiliyor...`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const osmJson = await runQuery(query);
      const geojson = osmtogeojson(osmJson);
      const outPath = path.join(OUT_DIR, `${name}.geojson`);
      fs.writeFileSync(outPath, JSON.stringify(geojson));
      console.log(`   ${name}: ${geojson.features.length} feature -> ${outPath}`);
      return geojson;
    } catch (err) {
      console.log(`   deneme ${attempt}/${retries} başarısız: ${err.message.split("\n")[0]}`);
      if (attempt === retries) throw err;
      await sleep(8000 * attempt);
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const areaFilter = `area["name"="${areaName}"]["admin_level"="8"]->.a;`;

  // Yaya-dostu yol ağı: her zaman yürünebilir yol tipleri + kaldırımı
  // etiketlenmiş ana caddeler (kaldırımsız hızlı trafik yollarını dışarıda bırakır)
  const roadsQuery = `
    [out:json][timeout:180];
    ${areaFilter}
    (
      way["highway"~"^(residential|living_street|pedestrian|footway|path|steps|track|service|unclassified|cycleway)$"](area.a);
      way["highway"~"^(tertiary|secondary|primary|trunk)$"]["sidewalk"~"^(yes|both|left|right|separate)$"](area.a);
    );
    out geom;
  `;

  // Sokak lambaları
  const lampsQuery = `
    [out:json][timeout:120];
    ${areaFilter}
    (
      node["highway"="street_lamp"](area.a);
    );
    out geom;
  `;

  // Açık işletmeler + sığınılabilecek noktalar.
  // ÖNEMLİ: Hastane ve polis merkezleri OSM'de çoğunlukla NOKTA değil ALAN (way/relation)
  // olarak etiketlenir; sadece node çekmek Eindhoven'ın en büyük iki hastanesini
  // (Máxima, Catharina) kaçırıyordu. Bu yüzden way/relation da çekilip `out center`
  // ile merkez noktaları alınıyor.
  const amenityTypes =
    "cafe|restaurant|bar|pub|nightclub|biergarten|pharmacy|fast_food|fuel|hospital|police|clinic|doctors|taxi" +
    "|bank|post_office|library|community_centre|townhall|fire_station|social_facility|place_of_worship";
  const amenitiesQuery = `
    [out:json][timeout:180];
    ${areaFilter}
    (
      node["amenity"~"^(${amenityTypes})$"](area.a);
      way["amenity"~"^(${amenityTypes})$"](area.a);
      relation["amenity"~"^(${amenityTypes})$"](area.a);
      node["shop"](area.a);
      way["shop"](area.a);
      node["tourism"="hotel"](area.a);
      way["tourism"="hotel"](area.a);
      node["railway"="station"](area.a);
      way["railway"="station"](area.a);
      node["public_transport"="station"](area.a);
    );
    out center;
  `;

  const tasks = [
    ["roads", roadsQuery],
    ["lamps", lampsQuery],
    ["amenities", amenitiesQuery],
  ];
  for (const [name, query] of tasks) {
    const outPath = path.join(OUT_DIR, `${name}.geojson`);
    if (fs.existsSync(outPath) && !process.argv.includes("--force")) {
      console.log(`-> ${name} zaten mevcut, atlanıyor (--force ile yeniden çek).`);
      continue;
    }
    await fetchAndSave(name, query);
    await sleep(3000);
  }

  console.log(`\n${areaName} tamamlandı.`);
}

main().catch((err) => {
  console.error("HATA:", err.message);
  process.exit(1);
});
