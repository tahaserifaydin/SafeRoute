import { useCallback, useEffect, useState } from "react";
import { MapContainer, TileLayer, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./lib/api";
import { engine, REGIONS as REGION_CONFIG } from "./engine/engineClient.js";
import { toLatLngs } from "./lib/constants";
import "./App.css";

// Senaryo (rastgele nokta çifti + hızlı/güvenli rota) artık tamamen tarayıcıda
// üretiliyor — canlı (statik) sitede bunun için bir sunucu yoktu, /api/study/scenario
// SPA fallback HTML döndürüp özelliği baştan sona bozuyordu. Yalnızca yanıt/sonuç
// kaydı (paylaşılan, kalıcı olması gereken kısım) sunucu tarafında (Pages Functions
// + KV) kalıyor.
async function generateScenario(region, time) {
  const { bbox } = await engine.bounds(region);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  let attempt = 0;
  while (attempt < 30) {
    attempt++;
    const sLat = minLat + Math.random() * (maxLat - minLat);
    const sLng = minLng + Math.random() * (maxLng - minLng);
    const eLat = Math.max(minLat, Math.min(maxLat, sLat + (Math.random() - 0.5) * 0.02));
    const eLng = Math.max(minLng, Math.min(maxLng, sLng + (Math.random() - 0.5) * 0.03));
    let fastRoute, safeRoute;
    try {
      [fastRoute, safeRoute] = await Promise.all([
        engine.route({ start: { lat: sLat, lng: sLng }, end: { lat: eLat, lng: eLng }, region, time, safetyPref: 0, accessible: false }).then((r) => r.fast),
        engine.route({ start: { lat: sLat, lng: sLng }, end: { lat: eLat, lng: eLng }, region, time, safetyPref: 0.25, accessible: false }).then((r) => r.safe),
      ]);
    } catch {
      continue;
    }
    if (fastRoute.distanceKm < 0.3 || fastRoute.distanceKm > 2.5) continue;
    if (safeRoute.avgSafetyScore - fastRoute.avgSafetyScore < 5) continue;
    const safeIsA = Math.random() < 0.5;
    const scenarioId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    return {
      scenarioId,
      region,
      timeProfile: time,
      routeA: safeIsA ? safeRoute : fastRoute,
      routeB: safeIsA ? fastRoute : safeRoute,
      safeIsA,
    };
  }
  throw new Error("Bu bölgede anlamlı bir senaryo bulunamadı, tekrar dene.");
}

// Tek kaynaktan (engineClient.js) okunur ki yeni bölge eklendiğinde burada
// unutulup eski hardcoded listeyle çelişmesin (bkz. proje notları: Bornova
// StudyView'da seçilemiyordu çünkü bu liste ayrıca elle tutuluyordu).
const REGIONS = Object.values(REGION_CONFIG).map((r) => ({ id: r.id, label: r.label }));
const TIME_OPTIONS = [
  { id: "midday", label: "Öğle (gündüz)" },
  { id: "lateNight", label: "Gece yarısı" },
];

function FitBounds({ coordsA, coordsB, tick }) {
  const map = useMap();
  useEffect(() => {
    if (!coordsA || !coordsB) return;
    const all = [...toLatLngs(coordsA), ...toLatLngs(coordsB)];
    map.fitBounds(all, { padding: [40, 40] });
    setTimeout(() => map.invalidateSize(), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  return null;
}

export default function StudyView() {
  const [region, setRegion] = useState("eindhoven");
  const [time, setTime] = useState("lateNight");
  const [scenario, setScenario] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reveal, setReveal] = useState(null); // { chosen, correct } gönderim sonrası
  const [results, setResults] = useState(null);
  const [count, setCount] = useState(0);
  const [fitTick, setFitTick] = useState(0);

  const loadScenario = useCallback(
    async (attemptsLeft = 3) => {
      setLoading(true);
      setError(null);
      setReveal(null);
      try {
        const s = await generateScenario(region, time);
        setScenario(s);
        setFitTick((t) => t + 1);
      } catch (err) {
        if (attemptsLeft > 0) {
          loadScenario(attemptsLeft - 1);
          return;
        }
        setError("Senaryo bulunamadı: " + err.message);
      } finally {
        setLoading(false);
      }
    },
    [region, time]
  );

  useEffect(() => {
    loadScenario();
    api
      .studyResults(region)
      .then(setResults)
      .catch(() => setResults(null));
  }, [region, time, loadScenario]);

  const choose = async (letter) => {
    if (!scenario || reveal) return;
    const chosenIsSafe = (letter === "A") === scenario.safeIsA;
    setReveal({ chosen: letter, chosenIsSafe });
    setCount((c) => c + 1);
    try {
      await api.studyRespond({
        scenarioId: scenario.scenarioId,
        region,
        chosen: letter,
        safeIsA: scenario.safeIsA,
        distanceA: scenario.routeA.distanceKm,
        distanceB: scenario.routeB.distanceKm,
        avgSafetyA: scenario.routeA.avgSafetyScore,
        avgSafetyB: scenario.routeB.avgSafetyScore,
      });
      const r = await api.studyResults(region);
      setResults(r);
    } catch (err) {
      setError("Cevap kaydedilemedi: " + err.message);
    }
  };

  return (
    <div className="study-view">
      <header className="study-header">
        <div>
          <h1>SafeRoute — Kullanıcı Çalışması</h1>
          <p>
            Aşağıda aynı iki nokta arasında hesaplanmış <b>iki farklı rota</b> var. Hangisinin
            "hızlı" hangisinin "güvenli" olduğunu bilmiyorsun — sadece haritaya bakarak seç:
          </p>
        </div>
        <div className="study-controls">
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <select value={time} onChange={(e) => setTime(e.target.value)}>
            {TIME_OPTIONS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="study-question">
        Gece yalnız yürüyen biri olsan, hangi rotayı seçerdin?
      </div>

      <div className="study-map-wrap">
        <MapContainer center={[51.44, 5.47]} zoom={14} className="map">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {scenario && (
            <>
              <Polyline
                positions={toLatLngs(scenario.routeA.route.geometry.coordinates)}
                pathOptions={{ color: "#3b82f6", weight: 7, opacity: reveal && reveal.chosen !== "A" ? 0.35 : 0.9 }}
              />
              <Polyline
                positions={toLatLngs(scenario.routeB.route.geometry.coordinates)}
                pathOptions={{ color: "#a855f7", weight: 7, opacity: reveal && reveal.chosen !== "B" ? 0.35 : 0.9 }}
              />
              <FitBounds
                coordsA={scenario.routeA.route.geometry.coordinates}
                coordsB={scenario.routeB.route.geometry.coordinates}
                tick={fitTick}
              />
            </>
          )}
        </MapContainer>
      </div>

      {loading && <div className="study-status">Senaryo hazırlanıyor…</div>}
      {error && <div className="study-status error">{error}</div>}

      {scenario && !loading && (
        <div className="study-choices">
          <button
            className={`study-choice a ${reveal?.chosen === "A" ? "chosen" : ""}`}
            onClick={() => choose("A")}
            disabled={!!reveal}
          >
            <span className="study-choice-dot" /> Rota A
            <span className="study-choice-meta">
              {scenario.routeA.distanceKm} km · {scenario.routeA.durationMin} dk
            </span>
          </button>
          <button
            className={`study-choice b ${reveal?.chosen === "B" ? "chosen" : ""}`}
            onClick={() => choose("B")}
            disabled={!!reveal}
          >
            <span className="study-choice-dot" /> Rota B
            <span className="study-choice-meta">
              {scenario.routeB.distanceKm} km · {scenario.routeB.durationMin} dk
            </span>
          </button>
        </div>
      )}

      {reveal && scenario && (
        <div className="study-reveal">
          <p>
            Seçtiğin rota <b>{reveal.chosenIsSafe ? "algoritmanın önerdiği GÜVENLİ rotaydı" : "algoritmanın önerdiği HIZLI rotaydı"}</b>.
          </p>
          <p className="study-reveal-detail">
            A: güvenlik skoru {scenario.routeA.avgSafetyScore}/100 · B: güvenlik skoru{" "}
            {scenario.routeB.avgSafetyScore}/100
          </p>
          <button className="btn-primary" onClick={() => loadScenario()}>
            Sonraki senaryo
          </button>
        </div>
      )}

      {results && results.total > 0 && (
        <div className="study-stats">
          <div className="study-stats-title">Şimdiye kadarki sonuçlar ({results.total} yanıt)</div>
          <div className="study-stats-bar">
            <div className="study-stats-fill" style={{ width: `${results.safeChosenPct}%` }} />
          </div>
          <div className="study-stats-label">
            Katılımcıların <b>%{results.safeChosenPct}</b>'i, hangisi olduğunu bilmeden algoritmanın
            önerdiği güvenli rotayı seçti
            {results.avgDetourPct != null ? ` (ortalama %${results.avgDetourPct} sapma karşılığında)` : ""}.
          </div>
        </div>
      )}

      <footer className="study-footer">Bu oturumda {count} senaryo yanıtladın. Katkın için teşekkürler.</footer>
    </div>
  );
}
