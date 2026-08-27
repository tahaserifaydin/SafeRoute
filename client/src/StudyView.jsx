import { useCallback, useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./lib/api";
import { engine, REGIONS as REGION_CONFIG } from "./engine/engineClient.js";
import { toLatLngs, haversineM } from "./lib/constants";
import "./App.css";

// Senaryo (rastgele nokta çifti + hızlı/güvenli rota) artık tamamen tarayıcıda
// üretiliyor — canlı (statik) sitede bunun için bir sunucu yoktu, /api/study/scenario
// SPA fallback HTML döndürüp özelliği baştan sona bozuyordu. Yalnızca yanıt/sonuç
// kaydı (paylaşılan, kalıcı olması gereken kısım) sunucu tarafında (Pages Functions
// + KV) kalıyor.
async function generateScenario(region, time) {
  let attempt = 0;
  while (attempt < 18) {
    attempt++;
    // Noktalar artık tamamen rastgele lat/lng değil, gerçek yol ağı
    // düğümlerinden seçiliyor (bkz. worker.js handleRandomScenarioPoints) —
    // aksi halde Mustafakemalpaşa gibi seyrek yol ağlı, büyük bölgelerde
    // noktalar yola çok uzak düşüp rota ya çöküyor ya da anlamsız oluyordu.
    const pair = await engine.randomScenarioPoints({ region }).catch(() => null);
    if (!pair) continue;
    let fastRoute, safeRoute;
    try {
      [fastRoute, safeRoute] = await Promise.all([
        engine.route({ start: pair.start, end: pair.end, region, time, safetyPref: 0, accessible: false }).then((r) => r.fast),
        engine.route({ start: pair.start, end: pair.end, region, time, safetyPref: 0.25, accessible: false }).then((r) => r.safe),
      ]);
    } catch {
      continue;
    }
    if (fastRoute.distanceKm < 0.15 || fastRoute.distanceKm > 3) continue;
    if (fastRoute.avgSafetyScore == null || safeRoute.avgSafetyScore == null) continue;
    // İki uç nokta arasında ağda tek güzergah varsa (kırsal/seyrek bölgelerde
    // sık görülüyor) güvenlik tercihi hiçbir şeyi değiştirmez, fast===safe
    // çıkar; bunu "A/B" diye göstermek anlamsız ve kafa karıştırıcı olur. Eşik
    // gap>=5'ten gap>=2'ye düşürüldü: Türkiye bölgelerinde puanlama yalnızca
    // OSM sinyallerine (aydınlatma/kaldırım/yol tipi) dayanıyor, Eindhoven'daki
    // gibi resmi suç verisi yok — aynı kasaba ızgarası içindeki gerçek
    // alternatif güzergahlar bile genelde 1-4 puanlık daha ince bir fark
    // veriyor; 5 eşiği neredeyse hiçbir çifti geçirmiyordu.
    const gap = safeRoute.avgSafetyScore - fastRoute.avgSafetyScore;
    if (gap < 2) continue;
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
  throw new Error(
    "Bu bölgede yol ağı henüz alternatif güzergah üretecek kadar zengin değil, bu yüzden karşılaştırmalı senaryo oluşturulamadı. Başka bir bölge deneyebilir ya da tekrar deneyebilirsin."
  );
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
  const requestId = useRef(0); // eski (bölge değişmeden önceki) isteğin sonucu yenisini ezmesin diye

  // Ana uygulamadaki gibi: konuma en yakın bölge otomatik seçilsin, hep
  // Eindhoven ile açılmasın (kullanıcı Mustafakemalpaşa'yı test merkezi
  // yaptı, çalışma sayfası da oraya göre başlamalı).
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const here = { lat: p.coords.latitude, lng: p.coords.longitude };
        let nearest = null;
        let nearestDist = Infinity;
        for (const r of Object.values(REGION_CONFIG)) {
          const d = haversineM(here, { lat: r.center[0], lng: r.center[1] });
          if (d < nearestDist) {
            nearestDist = d;
            nearest = r;
          }
        }
        if (nearest) setRegion(nearest.id);
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 }
    );
  }, []);

  const loadScenario = useCallback(
    // generateScenario kendi içinde zaten 30 kombinasyon deniyor (bkz. o
    // fonksiyon) — bunun üstüne eskiden 3 kez daha tam baştan denenmesi
    // (Mustafakemalpaşa gibi zayıf sonuç veren bölgelerde) "Senaryo
    // hazırlanıyor…" yazısını 30+ saniye ekranda bırakıyordu. Artık sadece
    // 1 kez daha (toplam 2 tam deneme) tekrar ediliyor.
    async (attemptsLeft = 1, myId = ++requestId.current) => {
      setLoading(true);
      setError(null);
      setReveal(null);
      // Yeni bölge/zaman için yükleme başlarken eski senaryo (ör. önceki
      // bölgenin rotaları) haritada asılı kalmasın — aksi halde bölge
      // değiştirildiğinde ya da senaryo bulunamayınca eski (yanlış) bölge
      // ekranda görünmeye devam ediyordu.
      if (myId === requestId.current) setScenario(null);
      try {
        const s = await generateScenario(region, time);
        if (myId !== requestId.current) return; // bölge/zaman bu arada değişti, sonuç eskidi
        setScenario(s);
        setFitTick((t) => t + 1);
        setLoading(false);
      } catch (err) {
        if (myId !== requestId.current) return;
        if (attemptsLeft > 0) {
          // loading burada kapatılmıyor — yeniden deneme hâlâ sürüyor;
          // önceden buradaki finally her durumda loading'i kapattığı için
          // "Senaryo hazırlanıyor…" mesajı deneme hâlâ devam ederken
          // kayboluyor, kullanıcı ekranda ne yükleniyor ne hata görmeden
          // sessizce takılı kalıyordu.
          loadScenario(attemptsLeft - 1, myId);
          return;
        }
        setError("Senaryo bulunamadı: " + err.message);
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
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, işletme verisi kısmen &copy; <a href="https://overturemaps.org">Overture Maps Foundation</a>'
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
