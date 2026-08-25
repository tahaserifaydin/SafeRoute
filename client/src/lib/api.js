async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export const api = {
  regions: () => getJson("/api/regions"),

  route: ({ start, end, region, time, safetyPref, accessible }) =>
    getJson(
      `/api/route?startLat=${start.lat}&startLng=${start.lng}&endLat=${end.lat}&endLng=${end.lng}` +
        `&region=${region}&time=${time}&safetyPref=${safetyPref}${accessible ? "&accessible=1" : ""}`
    ),

  geocode: (q, region) => getJson(`/api/geocode?q=${encodeURIComponent(q)}&region=${region}`),

  reverse: (lat, lng) => getJson(`/api/reverse?lat=${lat}&lng=${lng}`),

  safeHavens: ({ lat, lng, region, time }) =>
    getJson(`/api/safe-havens?lat=${lat}&lng=${lng}&region=${region}&time=${time}`),

  heatmap: (region, time) => getJson(`/api/heatmap?region=${region}&time=${time}`),

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
