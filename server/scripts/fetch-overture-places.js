// OSM'in tek başına çok yetersiz kaldığı yerlerde (özellikle küçük Türkiye
// yerleşimleri — bkz. Mustafakemalpaşa: tüm ilçede OSM'de sadece 3 yeme-içme
// noktası) işletme/POI verisini Overture Maps Foundation'ın "place" temasından
// zenginleştirir. Google Places'in aksine bu veri CDLA Permissive v2.0 ile
// AÇIKÇA yeniden dağıtıma/önbelleklemeye izin veriyor (Meta + Microsoft +
// OSM'in birleştirilmiş, açık lisanslı hali) — bkz. https://docs.overturemaps.org/attribution/
//
// Kullanım: node fetch-overture-places.js <bölge-klasör-adı>
// Önce fetch-region.js ile OSM verisi (roads_scored.geojson, amenities.geojson)
// çekilmiş olmalı; bu script bbox'ı roads_scored.geojson'dan alır ve sonucu
// mevcut amenities.geojson'un ÜZERİNE (OSM + Overture birleşik) yazar.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const turf = require("@turf/turf");

const regionDir = process.argv[2];
if (!regionDir) {
  console.error("Kullanım: node fetch-overture-places.js <bölge-klasör-adı>");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "..", "data", regionDir);
// 0.5 iken küçük esnaf işletmelerinin çoğunu (zincirlerin aksine tek kaynaktan
// -genelde Facebook- bilinen, bu yüzden Overture'ın "güven" skoru düşük çıkan
// yerler) eliyordu — ör. "Burger34", "Balci'nin Yeri Esnaf Lokantası" gibi
// gerçek işletmeler kayboluyordu. En düşük güvenli (~0.11) kayıtlar bile
// incelendiğinde hepsi meşru, spesifik işletmelerdi (spam/çöp veri yoktu) —
// bu yüzden eşik neredeyse tamamen kaldırıldı, sadece adı olma şartı kaldı.
const MIN_CONFIDENCE = 0.05;
const DEDUPE_RADIUS_M = 30; // bu yarıçapta zaten bir OSM noktası varsa Overture kopyası eklenmez

// Overture'ın ~1000+ kategorisinin tamamını değil, uygulamanın gerçekten
// kullandığı (arama kategorileri, güvenli nokta türleri, yakın-yerler
// listesi — bkz. scoring.js) OSM etiket karşılıklarını eşliyoruz. Eşlenmeyen
// ama adı olan her şey yine de aratılabilsin diye shop:"yes" (OSM'in "türü
// belirtilmemiş dükkan" kuralı) ile genel bir kova altında tutuluyor.
const EXACT_MAP = {
  cafe: { amenity: "cafe" },
  coffee_shop: { amenity: "cafe" },
  tea_room: { amenity: "cafe" },
  internet_cafe: { amenity: "cafe" },
  restaurant: { amenity: "restaurant" },
  turkish_restaurant: { amenity: "restaurant", cuisine: "turkish" },
  steakhouse: { amenity: "restaurant", cuisine: "steak_house" },
  diner: { amenity: "restaurant" },
  barbecue_restaurant: { amenity: "restaurant", cuisine: "barbecue" },
  mediterranean_restaurant: { amenity: "restaurant", cuisine: "mediterranean" },
  buffet_restaurant: { amenity: "restaurant" },
  soup_restaurant: { amenity: "restaurant", cuisine: "soup" },
  fish_and_chips_restaurant: { amenity: "restaurant", cuisine: "fish_and_chips" },
  chicken_restaurant: { amenity: "fast_food", cuisine: "chicken" },
  middle_eastern_restaurant: { amenity: "restaurant", cuisine: "middle_eastern" },
  malaysian_restaurant: { amenity: "restaurant", cuisine: "asian" },
  fast_food_restaurant: { amenity: "fast_food" },
  pizza_restaurant: { amenity: "fast_food", cuisine: "pizza" },
  burger_restaurant: { amenity: "fast_food", cuisine: "burger" },
  sandwich_shop: { amenity: "fast_food", cuisine: "sandwich" },
  bagel_shop: { amenity: "fast_food", cuisine: "sandwich" },
  doner_kebab: { amenity: "fast_food", cuisine: "kebab" },
  bar: { amenity: "bar" },
  beer_bar: { amenity: "bar" },
  pub: { amenity: "pub" },
  brewery: { amenity: "pub" },
  dance_club: { amenity: "nightclub" },
  lounge: { amenity: "nightclub" },
  bakery: { shop: "bakery" },
  desserts: { shop: "pastry" },
  ice_cream_shop: { amenity: "ice_cream" },
  chocolatier: { shop: "confectionery" },
  candy_store: { shop: "confectionery" },
  butcher_shop: { shop: "butcher" },
  fishmonger: { shop: "butcher" },
  delicatessen: { shop: "deli" },
  cheese_shop: { shop: "deli" },
  grocery_store: { shop: "grocery" },
  organic_grocery_store: { shop: "grocery" },
  convenience_store: { shop: "convenience" },
  superstore: { shop: "supermarket" },
  department_store: { shop: "supermarket" },
  farmers_market: { amenity: "marketplace" },
  fruits_and_vegetables: { shop: "greengrocer" },
  liquor_store: { shop: "alcohol" },
  tobacco_shop: { shop: "tobacco" },
  clothing_store: { shop: "clothes" },
  womens_clothing_store: { shop: "clothes" },
  mens_clothing_store: { shop: "clothes" },
  childrens_clothing_store: { shop: "clothes" },
  boutique: { shop: "clothes" },
  thrift_store: { shop: "clothes" },
  shoe_store: { shop: "shoes" },
  electronics: { shop: "electronics" },
  mobile_phone_store: { shop: "mobile_phone" },
  computer_store: { shop: "computer" },
  appliance_store: { shop: "electronics" },
  hardware_store: { shop: "hardware" },
  home_improvement_store: { shop: "hardware" },
  building_supply_store: { shop: "hardware" },
  lumber_store: { shop: "hardware" },
  bookstore: { shop: "books" },
  comic_books_store: { shop: "books" },
  stationery: { shop: "stationery" },
  jewelry_store: { shop: "jewelry" },
  flowers_and_gifts_shop: { shop: "florist" },
  gift_shop: { shop: "gift" },
  souvenir_shop: { shop: "gift" },
  pet_store: { shop: "pet" },
  furniture_store: { shop: "furniture" },
  carpet_store: { shop: "carpet" },
  antique_store: { shop: "antiques" },
  musical_instrument_store: { shop: "musical_instrument" },
  bicycle_shop: { shop: "bicycle" },
  car_repair: { shop: "car_repair" },
  automotive_repair: { shop: "car_repair" },
  automotive_services_and_repair: { shop: "car_repair" },
  tire_dealer_and_repair: { shop: "tyres" },
  motorcycle_repair: { shop: "motorcycle" },
  motorcycle_dealer: { shop: "motorcycle" },
  hairdresser: { shop: "hairdresser" },
  hair_salon: { shop: "hairdresser" },
  barber: { shop: "hairdresser" },
  beauty_salon: { shop: "hairdresser" },
  nail_salon: { shop: "hairdresser" },
  pharmacy: { amenity: "pharmacy" },
  hospital: { amenity: "hospital" },
  medical_center: { amenity: "clinic" },
  diagnostic_services: { amenity: "clinic" },
  health_and_medical: { amenity: "clinic" },
  dentist: { amenity: "dentist" },
  veterinarian: { amenity: "veterinary" },
  nutritionist: { amenity: "doctors" },
  physical_therapy: { amenity: "doctors" },
  psychologist: { amenity: "doctors" },
  speech_therapist: { amenity: "doctors" },
  elementary_school: { amenity: "school" },
  high_school: { amenity: "school" },
  middle_school: { amenity: "school" },
  private_school: { amenity: "school" },
  school: { amenity: "school" },
  vocational_and_technical_school: { amenity: "school" },
  religious_school: { amenity: "school" },
  language_school: { amenity: "school" },
  driving_school: { amenity: "school" },
  preschool: { amenity: "kindergarten" },
  day_care_preschool: { amenity: "kindergarten" },
  college_university: { amenity: "university" },
  campus_building: { amenity: "university" },
  bank_credit_union: { amenity: "bank" },
  banks: { amenity: "bank" },
  atms: { amenity: "bank" },
  post_office: { amenity: "post_office" },
  town_hall: { amenity: "townhall" },
  police_department: { amenity: "police" },
  fire_station: { amenity: "fire_station" },
  library: { amenity: "library" },
  community_center: { amenity: "community_centre" },
  cultural_center: { amenity: "community_centre" },
  bus_station: { amenity: "bus_station" },
  gas_station: { amenity: "fuel" },
  taxi_service: { amenity: "taxi" },
  car_rental_agency: { amenity: "car_rental" },
  mosque: { amenity: "place_of_worship" },
  religious_organization: { amenity: "place_of_worship" },
  park: { leisure: "park" },
  dog_park: { leisure: "park" },
  botanical_garden: { leisure: "park" },
  playground: { leisure: "playground" },
  gym: { leisure: "fitness_centre" },
  fitness_trainer: { leisure: "fitness_centre" },
  martial_arts_club: { leisure: "fitness_centre" },
  swimming_pool: { leisure: "swimming_pool" },
  water_park: { leisure: "swimming_pool" },
  cinema: { amenity: "cinema" },
  theaters_and_performance_venues: { amenity: "theatre" },
  art_gallery: { tourism: "gallery" },
  zoo: { tourism: "zoo" },
  aquarium: { tourism: "aquarium" },
  museum: { tourism: "museum" },
  hotel: { tourism: "hotel" },
  accommodation: { tourism: "hotel" },
  bed_and_breakfast: { tourism: "guest_house" },
  guest_house: { tourism: "guest_house" },
  // NOT: "landmark_and_historical_building" kasıtlı olarak eşlenmedi —
  // Mustafakemalpaşa verisinde incelendiğinde bu kategorideki kayıtların
  // neredeyse tamamı ("Kardelen Sitesi", "Barış Apartmanı" gibi) sıradan
  // apartman/site kompleksleriydi, gerçek tarihi/turistik yer değil. Overture
  // kaynağında bu kategori güvenilmez göründüğünden "gezilecek yer" aramasını
  // kirletmemesi için dışarıda bırakıldı (yine de shop:"yes" ile ada göre
  // aranabilir kalıyor).
  arts_and_entertainment: { tourism: "attraction" },
  sightseeing_tour_agency: { tourism: "attraction" },
  public_plaza: { tourism: "attraction" },
  campground: { tourism: "camp_site" },
  marina: { tourism: "attraction" },
  cave: { tourism: "attraction" },
  hiking_trail: { tourism: "attraction" },
  viewpoint: { tourism: "viewpoint" },
};

function mapCategory(cat) {
  if (!cat) return { shop: "yes" };
  if (EXACT_MAP[cat]) return EXACT_MAP[cat];
  if (cat.endsWith("_restaurant")) return { amenity: "restaurant" };
  if (cat.endsWith("_school")) return { amenity: "school" };
  return { shop: "yes" }; // eşlenmeyen ama adı olan her şey yine de aranabilsin
}

function loadRoadsBbox() {
  const roads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "roads_scored.geojson")));
  return turf.bbox(roads); // [minLng, minLat, maxLng, maxLat]
}

function downloadOverturePlaces(bbox) {
  const outPath = path.join(DATA_DIR, "_overture_raw.geojson");
  console.log(`-> Overture 'place' teması indiriliyor (bbox: ${bbox.join(",")})...`);
  execFileSync(
    "python3",
    ["-m", "overturemaps", "download", `--bbox=${bbox.join(",")}`, "-f", "geojson", "--type=place", "-o", outPath],
    { stdio: "inherit" }
  );
  const data = JSON.parse(fs.readFileSync(outPath));
  fs.unlinkSync(outPath);
  const statePath = outPath + ".state";
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  return data;
}

function main() {
  const bbox = loadRoadsBbox();
  const overture = downloadOverturePlaces(bbox);
  console.log(`   ${overture.features.length} Overture kaydı indirildi.`);

  const osmPath = path.join(DATA_DIR, "amenities.geojson");
  const osm = JSON.parse(fs.readFileSync(osmPath));
  // Script daha önce çalıştırılmışsa amenities.geojson zaten Overture ile
  // birleşmiş olabilir — dedup indeksini SADECE gerçek OSM kaynaklı noktalardan
  // kur, yoksa önceki çalıştırmada eklenen Overture noktaları "zaten var" sanılıp
  // hepsi yeniden elenir (script'i ikinci kez çalıştırmayı anlamsız kılar).
  const osmOnly = osm.features.filter((f) => f.properties?.source !== "overture");
  console.log(`   mevcut OSM amenities: ${osmOnly.length} (dosyada toplam ${osm.features.length})`);

  // Basit ızgara tabanlı yakınlık indeksi — birkaç bin nokta için O(n) yeterli,
  // ayrı bir mekansal kütüphaneye gerek yok.
  const CELL = 0.001; // ~100m
  const osmIndex = new Map();
  const cellKey = (lng, lat) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
  for (const f of osmOnly) {
    if (f.geometry?.type !== "Point") continue;
    const [lng, lat] = f.geometry.coordinates;
    const key = cellKey(lng, lat);
    if (!osmIndex.has(key)) osmIndex.set(key, []);
    osmIndex.get(key).push([lng, lat, f.properties?.name]);
  }
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
  // 30m yakınlıktaki HERHANGİ bir OSM noktasını "aynı yer" saymak yanlıştı:
  // yoğun çarşı/sanayi sitesi gibi alanlarda birbirinden tamamen farklı onlarca
  // işletme birbirine 10-30m mesafede oluyor (ör. "Kardeşler Kuruyemiş" sırf
  // 27m ötede "A101" var diye elenmiş, "Body Bulding" salonu sırf "BİM"e yakın
  // diye elenmiş — bir test alanında 244 GERÇEKTEN FARKLI işletme bu yüzden
  // kaybolmuştu). Artık sadece yakında VE adı benzer bir OSM noktası varsa
  // gerçek bir çakışma sayılıyor; OSM tarafında isim yoksa (ör. isimsiz bir
  // POI) kimlik doğrulanamadığından çakışma sayılmıyor, Overture kaydı korunuyor.
  function findNearbyOsmMatch(lng, lat, name) {
    const cLat = Math.floor(lat / CELL);
    const cLng = Math.floor(lng / CELL);
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const bucket = osmIndex.get(`${cLat + dLat},${cLng + dLng}`);
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
    skippedLowConf = 0,
    skippedDupe = 0;
  const overtureFeatures = [];
  for (const f of overture.features) {
    const p = f.properties;
    const conf = p.confidence ?? 0;
    if (conf < MIN_CONFIDENCE) {
      skippedLowConf++;
      continue;
    }
    const name = p.names?.primary;
    if (!name) continue;
    const [lng, lat] = f.geometry.coordinates;
    if (findNearbyOsmMatch(lng, lat, name)) {
      skippedDupe++;
      continue;
    }
    const tags = mapCategory(p.categories?.primary);
    overtureFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { ...tags, name, source: "overture" },
    });
    added++;
  }

  console.log(
    `   eklendi: ${added}, düşük güven (<${MIN_CONFIDENCE}) elendi: ${skippedLowConf}, OSM ile çakıştığı için elendi: ${skippedDupe}`
  );

  const merged = {
    type: "FeatureCollection",
    features: [...osm.features.filter((f) => f.properties?.source !== "overture"), ...overtureFeatures],
  };
  fs.writeFileSync(osmPath, JSON.stringify(merged));
  console.log(`   ${osmPath} güncellendi: toplam ${merged.features.length} işletme/POI.`);
}

main();
