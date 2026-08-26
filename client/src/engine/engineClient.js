// Ana iş parçacığından Web Worker'a Promise tabanlı köprü. api.js'teki eski
// sunucu-fetch fonksiyonlarıyla aynı imzaları taşır ki App.jsx / bileşenler
// değişmeden çalışsın.
let worker = null;
let nextId = 1;
const pending = new Map();

export const REGIONS = {
  eindhoven: { id: "eindhoven", label: "Eindhoven", center: [51.4416, 5.4697] },
  nuenen: { id: "nuenen", label: "Nuenen", center: [51.4743, 5.549] },
  // Deneysel: Türkiye bölgeleri — Hollanda'daki gibi resmi suç verisi yok,
  // skor yalnızca OSM tabanlı sinyallere (aydınlatma/kaldırım/yol tipi/işletme) dayanıyor.
  bornova: { id: "bornova", label: "Bornova (İzmir)", center: [38.4581, 27.2397] },
  buca: { id: "buca", label: "Buca (İzmir)", center: [38.3666, 27.2115] },
  gaziemir: { id: "gaziemir", label: "Gaziemir (İzmir)", center: [38.3213, 27.1412] },
  alsancak: { id: "alsancak", label: "Alsancak (İzmir)", center: [38.4384, 27.1434] },
};

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    worker.onerror = (e) => {
      for (const [id, p] of pending) {
        p.reject(new Error(e.message || "Motor hatası"));
        pending.delete(id);
      }
    };
  }
  return worker;
}

function call(type, payload) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

export function currentTimeProfile() {
  const h = new Date().getHours();
  if (h >= 8 && h < 13) return "morning";
  if (h >= 13 && h < 17) return "midday";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 24) return "night";
  return "lateNight";
}

// Rapor etkisi motora yalnızca kullanıcı raporları değiştiğinde gönderilir
// (canlı veri kaynağı bağlanınca burada güncellenecek — şimdilik boş liste).
export function setReports(reports) {
  return call("setReports", { reports });
}

export const engine = {
  regions: async () => ({
    regions: Object.values(REGIONS).map(({ id, label, center }) => ({ id, label, center })),
    currentTimeProfile: currentTimeProfile(),
  }),

  route: ({ start, end, region, time, safetyPref, accessible }) =>
    call("route", {
      region,
      startLat: start.lat,
      startLng: start.lng,
      endLat: end.lat,
      endLng: end.lng,
      time,
      safetyPref,
      accessible: !!accessible,
    }),

  safeHavens: ({ lat, lng, region, time }) => call("safeHavens", { lat, lng, region, time }),

  heatmap: (region, time) => call("heatmap", { region, time }),

  bounds: (region) => call("bounds", { region }),

  categorySearch: ({ region, query, near }) =>
    call("categorySearch", { region, query, nearLat: near.lat, nearLng: near.lng }),
};
