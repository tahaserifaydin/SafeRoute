// Hollanda Polisi açık verisinden mahalle (buurt) bazlı suç istatistiklerini ve
// CBS/PDOK'tan mahalle sınır poligonlarını çekip birleştirir.
//
// Kullanım: node fetch-crime.js <çıktı-klasör-adı> <minLat> <minLng> <maxLat> <maxLng>
// Örn:      node fetch-crime.js eindhoven 51.40 5.33 51.51 5.57
//
// Çıktı: data/<klasör>/crime_buurten.geojson
//        Her poligonda: crime_per_1000 (yaya güvenliğiyle ilgili suçlar, yıllık, kişi başı)
//
// VERİ KAYNAKLARI
// - Suç: Politie açık verisi, tablo 47022NED (suç türü x mahalle x ay, 2012-günümüz)
// - Sınırlar: PDOK CBS Wijken & Buurten WFS servisi
//
// NEDEN BU SUÇ TÜRLERİ: Tüm suçlar değil, yalnızca yaya güvenliğini doğrudan
// ilgilendiren sokak suçları alınıyor. Ev soygunu ya da araç hırsızlığı bir yayanın
// o sokakta yürürken karşılaşacağı riski temsil etmez; darp, tehdit, cinsel suç,
// alenî şiddet ve yankesicilik eder.
const fs = require("fs");
const path = require("path");

// Suç türleri, bir YAYANIN maruz kaldığı tehdit ağırlığına göre sınıflanır.
// Yankesicilik mal kaybıdır, darp ise can güvenliği tehdididir; ikisini eşit saymak
// şehir merkezlerini (yankesiciliğin yoğun olduğu yerler) haksız cezalandırıyordu.
const CRIME_CLASSES = {
  "1.4.1": { label: "Cinsel suçlar", class: "violent" },
  "1.4.2": { label: "Öldürme", class: "violent" },
  "1.4.3": { label: "Alenî şiddet (kişiye)", class: "violent" },
  "1.4.4": { label: "Tehdit", class: "violent" },
  "1.4.5": { label: "Darp/saldırı", class: "violent" },
  "1.4.6": { label: "Soygun (straatroof dahil)", class: "violent" },
  "1.4.7": { label: "Gasp", class: "violent" },
  "1.2.4": { label: "Yankesicilik", class: "property" },
  "2.5.2": { label: "Kamu düzenini bozma", class: "disorder" },
};

const MONTHS_BACK = 12;
const PDOK_WFS = "https://service.pdok.nl/cbs/wijkenbuurten/2024/wfs/v1_0";
const POLITIE_ODATA = "https://dataderden.cbs.nl/ODataApi/odata/47022NED";

const [, , dirName, minLat, minLng, maxLat, maxLng] = process.argv;
if (!dirName || !minLat) {
  console.error("Kullanım: node fetch-crime.js <klasör> <minLat> <minLng> <maxLat> <maxLng>");
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, "..", "..", "data", dirName);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "SafeRoute-thesis-project/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.log(`   deneme ${attempt}/${retries}: ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(4000 * attempt);
    }
  }
}

// Son N ayın dönem kodlarını üretir (veri kaynağındaki en son aya göre)
async function recentPeriods() {
  const data = await getJson(`${POLITIE_ODATA}/Perioden?$format=json`);
  const monthly = data.value.map((v) => v.Key.trim()).filter((k) => /^\d{4}MM\d{2}$/.test(k));
  return monthly.slice(-MONTHS_BACK);
}

async function fetchBuurtPolygons() {
  console.log("-> Mahalle sınırları (PDOK) çekiliyor...");
  const url =
    `${PDOK_WFS}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=wijkenbuurten:buurten&outputFormat=application/json&srsName=EPSG:4326` +
    `&bbox=${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
  const gj = await getJson(url);
  console.log(`   ${gj.features.length} mahalle poligonu alındı.`);
  return gj;
}

// Tüm Hollanda'yı tek sorguda çekmek API'yi 500'e düşürüyor; sorguyu ilgili
// belediyelerin buurt kodu ön ekiyle (BU + gemeentecode) daraltıyoruz.
async function fetchCrimeForPeriod(period, prefixes) {
  const rows = [];
  for (const prefix of prefixes) {
    const filter = encodeURIComponent(`startswith(WijkenEnBuurten,'${prefix}') and Perioden eq '${period}'`);
    const url = `${POLITIE_ODATA}/TypedDataSet?$filter=${filter}&$format=json`;
    const data = await getJson(url);
    rows.push(...(data.value || []));
    await sleep(600);
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const buurten = await fetchBuurtPolygons();
  const wantedCodes = new Set(buurten.features.map((f) => f.properties.buurtcode));

  // Bölgedeki belediyelerin kod ön ekleri (ör. GM0772 -> BU0772)
  const prefixes = [...new Set(buurten.features.map((f) => "BU" + f.properties.gemeentecode.replace("GM", "")))];
  console.log(`   ${prefixes.length} belediye kapsanıyor: ${prefixes.join(", ")}`);

  const periods = await recentPeriods();
  console.log(`-> Suç verisi çekiliyor: ${periods.length} ay (${periods[0]} - ${periods[periods.length - 1]})`);

  // buurtcode -> sınıfa göre suç sayıları
  const crimeByBuurt = new Map();
  for (const period of periods) {
    const rows = await fetchCrimeForPeriod(period, prefixes);
    let matched = 0;
    for (const row of rows) {
      const code = (row.WijkenEnBuurten || "").trim();
      if (!wantedCodes.has(code)) continue;
      const info = CRIME_CLASSES[(row.SoortMisdrijf || "").trim()];
      if (!info) continue;
      const count = row.GeregistreerdeMisdrijven_1;
      if (typeof count !== "number") continue;
      const cur = crimeByBuurt.get(code) || { violent: 0, property: 0, disorder: 0 };
      cur[info.class] += count;
      crimeByBuurt.set(code, cur);
      matched++;
    }
    console.log(`   ${period}: ${rows.length} satır, ${matched} eşleşen kayıt`);
    await sleep(1200); // API'yi yormamak için
  }

  let withData = 0;
  const enriched = buurten.features.map((f) => {
    const code = f.properties.buurtcode;
    const c = crimeByBuurt.get(code) || null;
    const pop = f.properties.aantalInwoners;
    if (c && typeof pop === "number" && pop > 50) withData++;
    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        buurtcode: code,
        buurtnaam: f.properties.buurtnaam,
        gemeentenaam: f.properties.gemeentenaam,
        aantalInwoners: pop,
        // Sınıf bazında ham sayımlar; ağırlıklandırma ve normalize etme
        // skorlama aşamasında (score-region.js) yapılır.
        crime_violent: c ? c.violent : null,
        crime_property: c ? c.property : null,
        crime_disorder: c ? c.disorder : null,
        crime_count: c ? c.violent + c.property + c.disorder : null,
      },
    };
  });

  const out = { type: "FeatureCollection", features: enriched };
  const outPath = path.join(OUT_DIR, "crime_buurten.geojson");
  fs.writeFileSync(outPath, JSON.stringify(out));

  const withCrime = enriched.filter((f) => f.properties.crime_count != null);
  const tot = withCrime.reduce(
    (a, f) => ({
      v: a.v + f.properties.crime_violent,
      p: a.p + f.properties.crime_property,
      d: a.d + f.properties.crime_disorder,
    }),
    { v: 0, p: 0, d: 0 }
  );
  console.log(`\nTamamlandı -> ${outPath}`);
  console.log(`  veri bulunan mahalle: ${withData}/${enriched.length}`);
  console.log(`  yıllık toplam -> şiddet: ${tot.v}, mal: ${tot.p}, kamu düzeni: ${tot.d}`);
}

main().catch((err) => {
  console.error("HATA:", err.message);
  process.exit(1);
});
