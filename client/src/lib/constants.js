export const DEFAULT_CENTER = [51.4416, 5.4697];
export const ARRIVAL_RADIUS_M = 15;
export const SIM_SPEED_KMH = 30; // demo amaçlı hızlandırılmış yürüyüş
export const SIM_TICK_MS = 400;

export const TIME_LABELS = {
  morning: "Sabah",
  midday: "Öğle",
  evening: "Akşam",
  night: "Gece",
  lateNight: "Gece yarısı",
};

export const TIME_RANGES = {
  morning: "08–13",
  midday: "13–17",
  evening: "17–20",
  night: "20–24",
  lateNight: "00–08",
};

export const REPORT_TYPE_LABELS = {
  dark: "Karanlık / lamba yok",
  unsafe: "Tekinsiz hissettim",
  harassment: "Taciz / rahatsız edilme",
  blocked: "Yol kapalı / geçilmiyor",
  safe: "Burası güvenli",
};

export const REPORT_TYPE_ICONS = {
  dark: "🌑",
  unsafe: "😟",
  harassment: "🚨",
  blocked: "🚧",
  safe: "✅",
};

export const BREAKDOWN_LABELS = {
  lighting: "Aydınlatma",
  pedInfra: "Yaya altyapısı",
  frontage: "Açık işletme (gözetim)",
  roadType: "Yol karakteri",
  nightlifeRisk: "Bar/gece hayatı yoğunluğu",
  crimeRisk: "Kayıtlı suç riski (mahalle)",
};

export const SAFETY_PREF_LABELS = ["Çok düşük", "Düşük", "Orta", "Yüksek", "Çok yüksek"];

export const SCORE_BANDS = [
  { max: 35, color: "#dc2626", label: "0–34", name: "Riskli" },
  { max: 50, color: "#f97316", label: "35–49", name: "Dikkatli ol" },
  { max: 65, color: "#eab308", label: "50–64", name: "Orta" },
  { max: 80, color: "#84cc16", label: "65–79", name: "İyi" },
  { max: 101, color: "#16a34a", label: "80+", name: "Güvenli" },
];

// Cihaz saatinden zaman profili tahmini (sunucudakiyle aynı sınırlar)
export function localTimeProfile() {
  const h = new Date().getHours();
  if (h >= 8 && h < 13) return "morning";
  if (h >= 13 && h < 17) return "midday";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 24) return "night";
  return "lateNight";
}

export function scoreColor(score) {
  if (score == null) return "#94a3b8";
  return (SCORE_BANDS.find((b) => score < b.max) || SCORE_BANDS[SCORE_BANDS.length - 1]).color;
}

export function scoreName(score) {
  if (score == null) return "Bilinmiyor";
  return (SCORE_BANDS.find((b) => score < b.max) || SCORE_BANDS[SCORE_BANDS.length - 1]).name;
}

export function formatDistance(m) {
  if (m == null) return "-";
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function toLatLngs(coords) {
  return coords.map(([lng, lat]) => [lat, lng]);
}

// Rota çizgisi üzerinde, başlangıçtan verilen km uzaklıktaki noktayı bulur
export function interpolateAlongRoute(coords, targetKm) {
  let acc = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lat: coords[i][1], lng: coords[i][0] };
    const b = { lat: coords[i + 1][1], lng: coords[i + 1][0] };
    const segKm = haversineM(a, b) / 1000;
    if (acc + segKm >= targetKm) {
      const t = segKm === 0 ? 0 : (targetKm - acc) / segKm;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    acc += segKm;
  }
  const last = coords[coords.length - 1];
  return { lat: last[1], lng: last[0] };
}
