// Sunucudaki (server/index.js) rota/skor mantığının tarayıcı tarafına taşınmış hali.
// Alan adları küçültülmüş veri şemasıyla eşleşir: safety_score_<time> -> s_<time>,
// safety_breakdown_<time> -> b_<time> (bkz. scripts/build-client-data.js).

export const TIME_PROFILES = ["morning", "midday", "evening", "night", "lateNight"];
export const TIME_PROFILE_HOURS = { morning: 8, midday: 13, evening: 17, night: 20, lateNight: 0 };

export function currentTimeProfile() {
  const h = new Date().getHours();
  if (h >= 8 && h < 13) return "morning";
  if (h >= 13 && h < 17) return "midday";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 24) return "night";
  return "lateNight";
}

export function getTimeName(requested) {
  return TIME_PROFILES.includes(requested) ? requested : currentTimeProfile();
}

// Deneysel taramada anlamlı sapmaların tetiklendiği eşikler 8-60 aralığında
// çıktığından üst uç yüksek tutulur (bkz. proje geçmişi / README).
export const ALPHA_LEVELS = [2, 6, 14, 28, 55];
export function alphaFromPreference(pref) {
  const p = Math.max(0, Math.min(1, Number.isFinite(pref) ? pref : 0.6));
  const idx = Math.round(p * (ALPHA_LEVELS.length - 1));
  return ALPHA_LEVELS[idx];
}

// Erişilebilir mod: merdiven ağır cezalandırılır (tamamen yasaklanmaz), kaplamasız
// yollar orta düzeyde cezalandırılır.
export const ACCESSIBLE_HIGHWAY_PENALTY = { steps: 50, path: 2.5, track: 3 };

// --- Sığınılabilecek noktalar ---
export const SAFE_HAVEN_TYPES = {
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
export const SAFE_HAVEN_SHOPS = { supermarket: "Market", convenience: "Büfe / market" };
export const SAFE_HAVEN_OTHER = { hotel: "Otel (resepsiyon)", station: "İstasyon" };

export const HAVEN_DEFAULT_HOURS = {
  pharmacy: [8, 19],
  fuel: [6, 23],
  supermarket: [8, 21],
  convenience: [7, 23],
  clinic: [8, 18],
  doctors: [8, 17],
  taxi: [0, 24],
  hotel: [0, 24],
  station: [5, 26],
  bank: [9, 18],
  post_office: [9, 18],
  library: [9, 20],
  community_centre: [9, 22],
  townhall: [8, 17],
  social_facility: [8, 20],
  place_of_worship: [7, 21],
};

export function inHourRange(hour, open, close) {
  if (close <= open) close += 24;
  return (hour >= open && hour < close) || (hour + 24 >= open && hour + 24 < close);
}

export function havenKind(props) {
  return props.amenity || props.shop || props.tourism || props.railway;
}

export function isHavenOpenAt(props, hour) {
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

// --- Kullanıcı raporları: güvenilirlik modeli (bkz. README) ---
export const REPORT_WEIGHTS = { harassment: 1.0, unsafe: 0.7, dark: 0.55, blocked: 0.45, safe: -0.5 };
export const REPORT_HALFLIFE_DAYS = 180;
export const CONFIRM_BONUS = 0.5;
export const MAX_REPORT_EFFECT = 15;
export const REPORT_RADIUS_M = 60;
export const REPORT_SATURATION = 3;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function weightedReports(reports) {
  const now = Date.now();
  return reports.map((r) => {
    const ageDays = (now - new Date(r.createdAt).getTime()) / 86400000;
    const decay = Math.pow(0.5, ageDays / REPORT_HALFLIFE_DAYS);
    const typeWeight = REPORT_WEIGHTS[r.type] ?? 0.5;
    const confirms = r.confirmations || 0;
    return { lat: r.lat, lng: r.lng, weight: typeWeight * decay * (1 + confirms * CONFIRM_BONUS) };
  });
}

export function reportEffectAt(weighted, lng, lat) {
  if (!weighted.length) return 0;
  let sum = 0;
  for (const r of weighted) {
    const d = haversineMeters(lat, lng, r.lat, r.lng);
    if (d > REPORT_RADIUS_M) continue;
    sum += r.weight * (1 - d / REPORT_RADIUS_M);
  }
  if (sum === 0) return 0;
  const sign = Math.sign(sum);
  const scaled = Math.sqrt(Math.abs(sum) / REPORT_SATURATION);
  return sign * Math.min(1, scaled) * MAX_REPORT_EFFECT;
}

export function adjustScore(baseScore, weightedReportsArr, lng, lat) {
  const effect = reportEffectAt(weightedReportsArr, lng, lat);
  if (!effect) return baseScore;
  return Math.max(0, Math.min(100, baseScore - effect));
}

// --- Kategori araması: "market", "eczane" gibi genel kelimeler adı yazılmadan
// yakındaki eşleşen işletmeleri bulsun diye (Google Maps'teki "yakınımda X" araması
// gibi). Her kategori OSM etiketlerine (amenity/shop/tourism/leisure/...) karşılık
// gelir; kullanıcı sorgusu bu anahtar kelimelerden biriyle eşleşirse isim araması
// yerine bölgedeki tüm eşleşen noktalar mesafeye göre sıralanıp döner.
export const CATEGORY_KEYWORDS = [
  { keywords: ["market", "süpermarket", "supermarket", "bakkal", "büfe"], label: "Market", match: (p) => p.shop === "supermarket" || p.shop === "convenience" || p.shop === "grocery" || p.shop === "greengrocer" },
  { keywords: ["eczane", "pharmacy"], label: "Eczane", match: (p) => p.amenity === "pharmacy" },
  { keywords: ["banka", "atm", "bank"], label: "Banka", match: (p) => p.amenity === "bank" },
  { keywords: ["hastane", "hospital", "acil"], label: "Hastane", match: (p) => p.amenity === "hospital" },
  { keywords: ["okul", "school", "lise", "ilkokul"], label: "Okul", match: (p) => p.amenity === "school" || p.amenity === "kindergarten" },
  { keywords: ["üniversite", "universite", "university", "kampüs"], label: "Üniversite", match: (p) => p.amenity === "university" || p.amenity === "college" },
  { keywords: ["restoran", "restaurant", "yemek", "lokanta"], label: "Restoran", match: (p) => p.amenity === "restaurant" || p.amenity === "fast_food" },
  { keywords: ["kafe", "cafe", "kahve"], label: "Kafe", match: (p) => p.amenity === "cafe" },
  { keywords: ["otel", "hotel", "konaklama"], label: "Otel", match: (p) => p.tourism === "hotel" || p.tourism === "guest_house" },
  { keywords: ["benzinlik", "istasyon", "fuel", "petrol", "akaryakıt"], label: "Benzinlik", match: (p) => p.amenity === "fuel" },
  { keywords: ["park", "yeşil alan"], label: "Park", match: (p) => p.leisure === "park" || p.leisure === "garden" || p.leisure === "playground" },
  { keywords: ["stadyum", "stadium", "saha"], label: "Stadyum", match: (p) => p.leisure === "stadium" || p.leisure === "pitch" },
  { keywords: ["polis", "police", "karakol"], label: "Polis", match: (p) => p.amenity === "police" },
  { keywords: ["itfaiye", "fire"], label: "İtfaiye", match: (p) => p.amenity === "fire_station" },
  { keywords: ["postane", "ptt", "post"], label: "PTT", match: (p) => p.amenity === "post_office" },
  { keywords: ["kütüphane", "kutuphane", "library"], label: "Kütüphane", match: (p) => p.amenity === "library" },
  { keywords: ["otobüs", "otobus", "durak", "bus"], label: "Otobüs durağı", match: (p) => p.highway === "bus_stop" || p.amenity === "bus_station" || !!p.public_transport },
  { keywords: ["tren", "metro", "istasyon", "station", "raylı"], label: "İstasyon", match: (p) => p.railway === "station" },
  { keywords: ["taksi", "taxi"], label: "Taksi durağı", match: (p) => p.amenity === "taxi" },
  { keywords: ["cami", "kilise", "havra", "ibadethane"], label: "İbadethane", match: (p) => p.amenity === "place_of_worship" },
  { keywords: ["sinema", "cinema"], label: "Sinema", match: (p) => p.amenity === "cinema" },
  { keywords: ["tiyatro", "theatre"], label: "Tiyatro", match: (p) => p.amenity === "theatre" },
  { keywords: ["müze", "muze", "museum"], label: "Müze", match: (p) => p.tourism === "museum" },
  { keywords: ["spor", "fitness", "gym", "spor salonu"], label: "Spor salonu", match: (p) => p.leisure === "fitness_centre" || p.leisure === "sports_centre" },
  { keywords: ["veteriner", "vet"], label: "Veteriner", match: (p) => p.amenity === "veterinary" },
  { keywords: ["diş", "dis", "dentist", "dişçi"], label: "Diş hekimi", match: (p) => p.amenity === "dentist" },
  { keywords: ["otopark", "parking", "park yeri"], label: "Otopark", match: (p) => p.amenity === "parking" },
  { keywords: ["tamirci", "oto tamir", "tamirhane", "servis", "mekanik", "lastikçi", "lastikci"], label: "Tamirci", match: (p) => ["car_repair", "tyres", "motorcycle"].includes(p.shop) },
  { keywords: ["kuaför", "kuafor", "berber", "hairdresser"], label: "Kuaför", match: (p) => p.shop === "hairdresser" },
  { keywords: ["fırın", "firin", "pastane", "bakery"], label: "Fırın", match: (p) => p.shop === "bakery" || p.shop === "pastry" },
  { keywords: ["kırtasiye", "kirtasiye", "kitapçı", "kitapci", "kitap"], label: "Kitap/Kırtasiye", match: (p) => p.shop === "books" || p.shop === "stationery" },
  { keywords: ["giyim", "kıyafet", "kiyafet", "clothes"], label: "Giyim", match: (p) => p.shop === "clothes" || p.shop === "shoes" },
  { keywords: ["elektronik", "telefon", "bilgisayar"], label: "Elektronik", match: (p) => ["electronics", "mobile_phone", "computer", "hifi"].includes(p.shop) },
  { keywords: ["çiçekçi", "cicekci", "florist"], label: "Çiçekçi", match: (p) => p.shop === "florist" },
];

export function normalizeTr(s) {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .trim();
}

// Sorgu bir kategori anahtar kelimesiyle eşleşirse o kategoriyi döner (isim
// araması değil, "yakınımdaki X" araması yapılmalı demektir).
export function matchCategory(query) {
  const q = normalizeTr(query);
  if (q.length < 2) return null;
  for (const cat of CATEGORY_KEYWORDS) {
    for (const kw of cat.keywords) {
      const nkw = normalizeTr(kw);
      if (q === nkw || nkw.startsWith(q) || q.startsWith(nkw)) return cat;
    }
  }
  return null;
}

// --- Yakın yerler: haritada pin olarak gösterilen genel ilgi noktaları
// (restoran, kafe, market, mağaza vb.) — "Güvenli nokta" özelliğinden farklı,
// güvenlik amacı yok, sadece "çevremde ne var" sorusuna cevap.
export const NEARBY_AMENITY_TYPES = {
  restaurant: { label: "Restoran", emoji: "🍽️" },
  fast_food: { label: "Fast food", emoji: "🍔" },
  cafe: { label: "Kafe", emoji: "☕" },
  bar: { label: "Bar", emoji: "🍺" },
  pub: { label: "Pub", emoji: "🍺" },
  nightclub: { label: "Gece kulübü", emoji: "🎶" },
  biergarten: { label: "Bahçe", emoji: "🍺" },
  cinema: { label: "Sinema", emoji: "🎬" },
  theatre: { label: "Tiyatro", emoji: "🎭" },
};
const NEARBY_SHOP_MARKET = new Set(["supermarket", "convenience", "grocery", "greengrocer", "butcher"]);
// Google Maps'teki gibi sık aranan mağaza türleri kendi etiket/ikonuyla ayrılıyor;
// geri kalan onlarca shop=* değeri (OSM'de ~120 farklı tür var) genel "Mağaza"
// altında toplanıyor — hepsine ayrı ikon vermek yerine en çok aranan ~10 tanesi
// öne çıkarılıyor.
const NEARBY_SHOP_LABELS = {
  bakery: { label: "Fırın", emoji: "🥖" },
  pastry: { label: "Pastane", emoji: "🍰" },
  car_repair: { label: "Tamirci", emoji: "🔧" },
  tyres: { label: "Lastikçi", emoji: "🔧" },
  motorcycle: { label: "Motosiklet Tamirci", emoji: "🔧" },
  bicycle: { label: "Bisikletçi", emoji: "🚲" },
  shoe_repair: { label: "Ayakkabı Tamiri", emoji: "👞" },
  hairdresser: { label: "Kuaför", emoji: "💇" },
  clothes: { label: "Giyim", emoji: "👕" },
  shoes: { label: "Ayakkabı", emoji: "👟" },
  books: { label: "Kitapçı", emoji: "📚" },
  stationery: { label: "Kırtasiye", emoji: "✏️" },
  electronics: { label: "Elektronik", emoji: "🔌" },
  mobile_phone: { label: "Telefon", emoji: "📱" },
  computer: { label: "Bilgisayar", emoji: "💻" },
  florist: { label: "Çiçekçi", emoji: "💐" },
  optician: { label: "Optisyen", emoji: "👓" },
  jewelry: { label: "Kuyumcu", emoji: "💍" },
};

export function nearbyPlaceInfo(props) {
  if (props.amenity && NEARBY_AMENITY_TYPES[props.amenity]) return NEARBY_AMENITY_TYPES[props.amenity];
  if (props.shop) {
    if (NEARBY_SHOP_MARKET.has(props.shop)) return { label: "Market", emoji: "🛒" };
    if (NEARBY_SHOP_LABELS[props.shop]) return NEARBY_SHOP_LABELS[props.shop];
    return { label: "Mağaza", emoji: "🛍️" };
  }
  if (props.tourism === "museum") return { label: "Müze", emoji: "🏛️" };
  if (props.leisure === "park" || props.leisure === "garden") return { label: "Park", emoji: "🌳" };
  return null;
}

// --- Isı haritası bantları ---
export const HEATMAP_BANDS = [
  { max: 35, color: "#dc2626", label: "0-34" },
  { max: 50, color: "#f97316", label: "35-49" },
  { max: 65, color: "#eab308", label: "50-64" },
  { max: 80, color: "#84cc16", label: "65-79" },
  { max: 101, color: "#16a34a", label: "80+" },
];
