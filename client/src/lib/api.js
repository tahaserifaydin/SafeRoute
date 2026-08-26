import { engine } from "../engine/engineClient.js";

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Nominatim'e doğrudan tarayıcıdan gidilir (artık aradaki sunucu yok).
// Bölge bbox'ı motor (worker) üzerinden okunur.
async function nominatimSearch(q, region) {
  const { bbox } = await engine.bounds(region);
  const viewbox = `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`;
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=0` +
    `&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": "SafeRoute-thesis-project/1.0 (school project demo)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.map((d) => ({ label: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }));
}

// Arama: önce "market", "eczane" gibi kategori sözcüğü mü diye bakılır — öyleyse
// adı yazılmadan bölgedeki eşleşen tüm noktalar `near`e (kullanıcı konumu ya da
// harita merkezi) en yakından en uzağa sıralanıp döner (Google Maps'teki
// "yakınımda X" aramasına benzer). Değilse Nominatim'de isim araması yapılır;
// `near` verilmişse sonuçlar yine mesafeye göre yeniden sıralanır ve her sonucun
// yanında mesafe gösterilir.
async function geocode(q, region, near) {
  if (q.trim().length < 2) return { results: [] };

  if (near) {
    const cat = await engine.categorySearch({ region, query: q, near }).catch(() => null);
    if (cat && cat.results.length) return { results: cat.results, isCategory: true };
  }

  const raw = await nominatimSearch(q, region);
  const results = near
    ? raw.map((r) => ({ ...r, distanceM: Math.round(haversineM(near, r)) })).sort((a, b) => a.distanceM - b.distanceM)
    : raw;
  return { results };
}

const reverseCache = new Map();
async function nominatimReverse(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return { label: reverseCache.get(key) };
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=${lat}&lon=${lng}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "SafeRoute-thesis-project/1.0 (school project demo)" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const a = data.address || {};
    const parts = [a.road || a.pedestrian || a.footway || a.neighbourhood, a.suburb || a.city_district, a.city || a.town || a.village];
    const label = parts.filter(Boolean).join(", ") || data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (reverseCache.size > 500) reverseCache.clear();
    reverseCache.set(key, label);
    return { label };
  } catch {
    return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
}

export const api = {
  regions: () => engine.regions(),

  route: (opts) => engine.route(opts),

  geocode: (q, region, near) => geocode(q, region, near),

  reverse: (lat, lng) => nominatimReverse(lat, lng),

  safeHavens: (opts) => engine.safeHavens(opts),

  heatmap: (region, time) => engine.heatmap(region, time),

  reports: (region) => getJson(`/api/reports?region=${region}`),

  addReport: (body) =>
    getJson("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  confirmReport: (id) => getJson(`/api/reports/${id}/confirm`, { method: "POST" }),

  emergencyStart: (body) =>
    getJson("/api/emergency/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  emergencyPing: (id, lat, lng) =>
    getJson(`/api/emergency/${id}/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    }),
  emergencyStop: (id) => getJson(`/api/emergency/${id}/stop`, { method: "POST" }),
  emergencyGet: (id) => getJson(`/api/emergency/${id}`),

  studyScenario: (region, time) => getJson(`/api/study/scenario?region=${region}&time=${time}`),
  studyRespond: (body) =>
    getJson("/api/study/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  studyResults: (region) => getJson(`/api/study/results${region ? `?region=${region}` : ""}`),
};

// --- Kaydedilmiş rotalar (tarayıcı belleğinde) ---
const SAVED_KEY = "saferoute.saved";

export function loadSavedRoutes() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveRoute(entry) {
  const saved = loadSavedRoutes();
  const next = [entry, ...saved.filter((s) => s.id !== entry.id)].slice(0, 10);
  localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  return next;
}

export function deleteSavedRoute(id) {
  const next = loadSavedRoutes().filter((s) => s.id !== id);
  localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  return next;
}

// --- Paylaşılabilir bağlantı: rota durumu URL'de tutulur ---
export function encodeStateToUrl({ start, end, region, timeMode, safetyPref }) {
  const p = new URLSearchParams();
  if (start) p.set("s", `${start.lat.toFixed(5)},${start.lng.toFixed(5)}`);
  if (end) p.set("e", `${end.lat.toFixed(5)},${end.lng.toFixed(5)}`);
  if (region) p.set("r", region);
  if (timeMode) p.set("t", timeMode);
  if (safetyPref != null) p.set("p", String(safetyPref));
  return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
}

export function decodeStateFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const parsePoint = (v) => {
    if (!v) return null;
    const [lat, lng] = v.split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  };
  return {
    start: parsePoint(p.get("s")),
    end: parsePoint(p.get("e")),
    region: p.get("r") || null,
    timeMode: p.get("t") || null,
    safetyPref: p.has("p") ? parseFloat(p.get("p")) : null,
  };
}
