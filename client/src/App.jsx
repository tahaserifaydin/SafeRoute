import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RouteMap from "./components/RouteMap";
import SearchField from "./components/SearchField";
import RouteCards from "./components/RouteCards";
import SegmentInspector, { ScoreLegend } from "./components/SegmentInspector";
import NavBanner from "./components/NavBanner";
import EmergencyPanel from "./components/EmergencyPanel";
import { HavensList, ReportForm, SavedRoutes, StepsList } from "./components/Panels";
import { PROXIMITY_WARNING_M, isVoiceSupported, speak, stopSpeaking } from "./lib/voice";
import {
  api,
  decodeStateFromUrl,
  deleteSavedRoute,
  encodeStateToUrl,
  loadSavedRoutes,
  saveRoute,
} from "./lib/api";
import {
  ARRIVAL_RADIUS_M,
  SAFETY_PREF_LABELS,
  SIM_SPEED_KMH,
  SIM_TICK_MS,
  TIME_LABELS,
  TIME_RANGES,
  haversineM,
  interpolateAlongRoute,
  localTimeProfile,
} from "./lib/constants";
import "./App.css";

const urlState = decodeStateFromUrl();
const hadExplicitRegion = !!urlState.region; // paylaşılan bir bağlantıdan geldiyse bölgeyi ezme

export default function App() {
  // --- Bölge / zaman ---
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState(urlState.region || "eindhoven");
  const autoRegionDone = useRef(hadExplicitRegion); // true ise bir daha otomatik seçim denenmez
  // Bölge state'i teknik olarak hâlâ "eindhoven" ile başlıyor (26 yerde
  // kullanıldığından hepsini null'a hazırlamak riskli), ama kullanıcı bunu
  // GÖRMESİN diye konum belirlenene kadar (ya da 7sn içinde belirlenemezse)
  // tüm arayüz yerine basit bir yükleniyor ekranı gösteriliyor — "önce
  // Eindhoven sonra gerçek konum" yanıp sönmesi tamamen ortadan kalkıyor.
  const [locationReady, setLocationReady] = useState(hadExplicitRegion);
  useEffect(() => {
    if (locationReady) return;
    const t = setTimeout(() => setLocationReady(true), 7000);
    return () => clearTimeout(t);
  }, [locationReady]);
  const [timeMode, setTimeMode] = useState(urlState.timeMode || "auto");
  const [autoTimeProfile, setAutoTimeProfile] = useState(localTimeProfile());
  const [flyTrigger, setFlyTrigger] = useState(0);
  const [fitTrigger, setFitTrigger] = useState(0);

  // --- Rota girdileri ---
  const [start, setStart] = useState(urlState.start);
  // "Nereden" varsayılan olarak kullanıcının canlı konumu olsun ve o hareket
  // ettikçe TAKİP ETSİN — ama kullanıcı haritaya dokunup ya da arama kutusuna
  // yazıp KENDİ başlangıç noktasını seçerse artık üzerine yazılmasın. Paylaşılan
  // bir bağlantıdan (URL) gelen başlangıç noktası da "kullanıcı seçti" sayılır.
  const startIsAuto = useRef(!urlState.start);
  const lastAutoStartRef = useRef(null);
  const [end, setEnd] = useState(urlState.end);
  const [startQuery, setStartQuery] = useState("");
  const [endQuery, setEndQuery] = useState("");
  const [resolvingStart, setResolvingStart] = useState(false);
  const [resolvingEnd, setResolvingEnd] = useState(false);
  const [safetyPref, setSafetyPref] = useState(urlState.safetyPref ?? 0.6);
  const [accessibleMode, setAccessibleMode] = useState(false);
  // --- Hava durumu (ıslak mod) ---
  // Yağmur/kar yağarken merdiven vb. kayma riski taşıyan yollar rota
  // hesabında otomatik cezalandırılıyor (bkz. WET_HIGHWAY_PENALTY,
  // scoring.js). Kullanıcı açıp kapatmıyor — sadece şeffaflık için bildiriliyor.
  const [isWet, setIsWet] = useState(false);
  const [wetKind, setWetKind] = useState(null); // "rain" | "snow" | null
  const [temperature, setTemperature] = useState(null);

  // --- Sonuç ---
  const [result, setResult] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState("safe");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState(null);
  const [inspectedSegment, setInspectedSegment] = useState(null);
  const requestId = useRef(0);

  // --- Katmanlar ---
  const [havens, setHavens] = useState([]);
  const [showHavens, setShowHavens] = useState(false);
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  const [showNearby, setShowNearby] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapBands, setHeatmapBands] = useState(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [reports, setReports] = useState([]);
  const [reportMode, setReportMode] = useState(false);
  const [pendingReport, setPendingReport] = useState(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [savedRoutes, setSavedRoutes] = useState(loadSavedRoutes);
  const [toast, setToast] = useState(null);

  // --- Navigasyon ---
  const [navActive, setNavActive] = useState(false);
  const [navIsSim, setNavIsSim] = useState(false);
  const [userPos, setUserPos] = useState(null);
  // Navigasyon dışında da (arama kutusunu mesafeye göre sıralamak, bölgeyi
  // otomatik seçmek için) kaba bir konuma ihtiyaç var. Düşük güçlü sürekli
  // izleme (watchPosition) kullanılıyor — tek seferlik getCurrentPosition izin
  // isteği bir kere başarısız/zaman aşımına uğradığında (ör. tarayıcı konum
  // isteğini ilk anda yanıtlayamadıysa) bir daha HİÇ denemiyordu, bu da
  // sayfanın kalıcı olarak Eindhoven varsayılanında takılı kalmasına yol
  // açıyordu. Konum izni tamamen REDDEDİLMİŞSE (ör. bu tarayıcıda/ortamda)
  // watchPosition de asla tetiklenmez — o durumda kullanıcının IP'sinden kaba
  // bir konum tahmini alan ücretsiz bir servise (ipapi.co, anahtar gerekmez)
  // tek seferlik başvuruluyor, en azından doğru ÜLKE/şehir civarına düşsün.
  const [approxPos, setApproxPos] = useState(null);
  const approxPosRef = useRef(null);
  useEffect(() => {
    approxPosRef.current = approxPos;
  }, [approxPos]);
  useEffect(() => {
    let cancelled = false;
    let ipFallbackTimer = null;

    // İki farklı, anahtar gerektirmeyen sağlayıcı deneniyor — bazı reklam
    // engelleyiciler/gizlilik uzantıları ya da ağlar IP-konum servislerini
    // "izleme" sayıp engelleyebiliyor; biri engellense bile diğeri (farklı
    // domain) genelde çalışıyor.
    function tryIpFallback() {
      fetch("https://ipapi.co/json/")
        .then((r) => r.json())
        .then((d) => {
          if (cancelled || approxPosRef.current) return;
          if (typeof d.latitude === "number" && typeof d.longitude === "number") {
            setApproxPos({ lat: d.latitude, lng: d.longitude });
            return;
          }
          throw new Error("no coords");
        })
        .catch(() => {
          if (cancelled || approxPosRef.current) return;
          fetch("https://get.geojs.io/v1/ip/geo.json")
            .then((r) => r.json())
            .then((d) => {
              if (cancelled || approxPosRef.current) return;
              const lat = parseFloat(d.latitude);
              const lng = parseFloat(d.longitude);
              if (Number.isFinite(lat) && Number.isFinite(lng)) {
                setApproxPos({ lat, lng });
              }
            })
            .catch(() => {});
        });
    }

    if (!navigator.geolocation) {
      tryIpFallback();
      return;
    }
    // Tarayıcı konumu birkaç saniye içinde gelmezse (izin isteği asılı kalmış,
    // kullanıcı henüz karar vermemiş olabilir) IP tahminiyle en azından bölgeyi
    // kabaca doğru seçelim; gerçek konum sonradan gelirse zaten üzerine yazar.
    ipFallbackTimer = setTimeout(tryIpFallback, 4000);

    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (cancelled) return;
        clearTimeout(ipFallbackTimer);
        setApproxPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        // izin reddedildi ya da hata verdi — IP yedeğini hemen dene, 4sn beklemeye gerek yok
        clearTimeout(ipFallbackTimer);
        tryIpFallback();
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 }
    );
    return () => {
      cancelled = true;
      clearTimeout(ipFallbackTimer);
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);
  const [stepIndex, setStepIndex] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(() => localStorage.getItem("saferoute.voice") !== "off");
  const warnedStepRef = useRef(-1);

  const toggleVoice = () => {
    setVoiceEnabled((v) => {
      const next = !v;
      localStorage.setItem("saferoute.voice", next ? "on" : "off");
      if (!next) stopSpeaking();
      return next;
    });
  };
  const watchIdRef = useRef(null);
  const simIntervalRef = useRef(null);
  const simProgressRef = useRef(0);

  // --- Mobil düzen ---
  const [sheetOpen, setSheetOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const effectiveTime = timeMode === "auto" ? autoTimeProfile : timeMode;
  const currentRegion = regions.find((r) => r.id === region);
  const active = result ? result[selectedRoute] : null;

  // Arama sonuçlarını mesafeye göre sıralamak/yakınımdaki X'i bulmak için referans
  // nokta: gerçek konum bilinmiyorsa bölge merkezi kullanılır (yine de bir sıralama
  // sağlar). "Nereye" alanı için başlangıç noktası seçilmişse oradan mesafe daha
  // anlamlı (Google Maps de varış araması için başlangıçtan mesafe gösterir).
  const regionCenterPt = currentRegion ? { lat: currentRegion.center[0], lng: currentRegion.center[1] } : null;
  const nearForStart = userPos || approxPos || regionCenterPt;
  const nearForEnd = start || userPos || approxPos || regionCenterPt;

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Bölge merkezi için güncel yağış durumunu sorgula (API anahtarı gerekmeyen
  // Open-Meteo). Rota içindeki her nokta için değil, bölge geneli tek bir
  // hava durumu kabul ediliyor — bu ölçekte (ilçe/kasaba) yeterli.
  const wetLat = regionCenterPt?.lat;
  const wetLng = regionCenterPt?.lng;
  useEffect(() => {
    if (wetLat == null || wetLng == null) return;
    let cancelled = false;
    const checkWeather = () => {
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${wetLat}&longitude=${wetLng}&current=precipitation,rain,snowfall,temperature_2m`
      )
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const rain = d?.current?.rain ?? 0;
          const snow = d?.current?.snowfall ?? 0;
          setIsWet(rain > 0 || snow > 0);
          setWetKind(snow > 0 ? "snow" : rain > 0 ? "rain" : null);
          setTemperature(d?.current?.temperature_2m ?? null);
        })
        .catch(() => {
          // Hava durumu servisine ulaşılamıyorsa sessizce normal (kuru) moda düş —
          // rota hesaplamasını bu yüzden bloklamaya değmez.
          if (!cancelled) {
            setIsWet(false);
            setWetKind(null);
            setTemperature(null);
          }
        });
    };
    checkWeather();
    const iv = setInterval(checkWeather, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [wetLat, wetLng]);

  // --- Başlangıç verileri ---
  useEffect(() => {
    api
      .regions()
      .then((d) => {
        setRegions(d.regions || []);
        setAutoTimeProfile(d.currentTimeProfile || localTimeProfile());
      })
      .catch(() => setError("Sunucuya bağlanılamadı. Arka uç çalışıyor mu?"));
  }, []);

  // Sayfa her zaman Eindhoven ile açılmasın diye: paylaşılan bir bağlantıdan
  // (URL'de bölge parametresi) gelinmediyse, gerçek konuma en yakın bölge
  // otomatik seçilir (ör. Türkiye'deyken İzmir bölgelerinden biri açılır).
  useEffect(() => {
    if (autoRegionDone.current || !approxPos || !regions.length) return;
    autoRegionDone.current = true;
    let nearest = null;
    let nearestDist = Infinity;
    for (const r of regions) {
      const d = haversineM(approxPos, { lat: r.center[0], lng: r.center[1] });
      if (d < nearestDist) {
        nearestDist = d;
        nearest = r;
      }
    }
    if (nearest && nearest.id !== region) {
      setRegion(nearest.id);
      setFlyTrigger((t) => t + 1);
    }
    setLocationReady(true);
  }, [approxPos, regions, region]);

  useEffect(() => {
    api
      .reports(region)
      .then((d) => setReports(d.reports || []))
      .catch(() => setReports([]));
  }, [region]);

  // --- Nokta seçilince adresini çöz (koordinat yerine sokak adı göster) ---
  const resolveLabel = useCallback(async (point, setQuery, setBusy) => {
    setBusy(true);
    setQuery("Adres çözümleniyor…");
    try {
      const { label } = await api.reverse(point.lat, point.lng);
      setQuery(label);
    } catch {
      setQuery(`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // URL'den gelen noktaların adreslerini bir kez çöz
  useEffect(() => {
    if (urlState.start) resolveLabel(urlState.start, setStartQuery, setResolvingStart);
    if (urlState.end) resolveLabel(urlState.end, setEndQuery, setResolvingEnd);
  }, [resolveLabel]);

  // "Nereden" alanını kullanıcının canlı konumuna otomatik ayarla ve hareket
  // ettikçe güncelle — kullanıcı kendi başlangıç noktasını seçene kadar (bkz.
  // startIsAuto). GPS küçük sapmalarla (jitter) sürekli tetiklenmesin diye
  // sadece son otomatik ayarlanan noktadan gerçekten anlamlı ölçüde
  // (>40m) uzaklaştıysa güncelleniyor.
  useEffect(() => {
    if (!startIsAuto.current || !approxPos) return;
    if (lastAutoStartRef.current && haversineM(approxPos, lastAutoStartRef.current) < 40) return;
    lastAutoStartRef.current = approxPos;
    setStart(approxPos);
    resolveLabel(approxPos, setStartQuery, setResolvingStart);
  }, [approxPos, resolveLabel]);

  // --- Rota hesapla ---
  useEffect(() => {
    if (!start || !end || !effectiveTime) return;
    const myId = ++requestId.current;
    setLoading(true);
    setError(null);
    setLoadingMsg("Rota hesaplanıyor…");
    // İlk istekte sunucu grafiği kuruyor olabilir; kullanıcıyı bilgilendir
    const slowTimer = setTimeout(() => {
      if (myId === requestId.current) setLoadingMsg("Bu zaman dilimi ilk kez kullanılıyor, yol ağı hazırlanıyor…");
    }, 1200);

    api
      .route({ start, end, region, time: effectiveTime, safetyPref, accessible: accessibleMode, wet: isWet })
      .then((data) => {
        if (myId !== requestId.current) return;
        setResult(data);
        setSelectedRoute("safe");
        setInspectedSegment(null);
        setFitTrigger((t) => t + 1);
      })
      .catch((err) => {
        if (myId !== requestId.current) return;
        setError(err.message);
        setResult(null);
      })
      .finally(() => {
        clearTimeout(slowTimer);
        if (myId === requestId.current) setLoading(false);
      });

    return () => clearTimeout(slowTimer);
  }, [start, end, region, effectiveTime, safetyPref, accessibleMode, isWet]);

  // --- Güvenli noktalar (saate duyarlı) ---
  useEffect(() => {
    if (!showHavens) return;
    const ref = userPos || start || (currentRegion ? { lat: currentRegion.center[0], lng: currentRegion.center[1] } : null);
    if (!ref) return;
    api
      .safeHavens({ lat: ref.lat, lng: ref.lng, region, time: effectiveTime })
      .then((d) => setHavens(d.havens || []))
      .catch(() => setHavens([]));
  }, [showHavens, userPos, start, region, effectiveTime, currentRegion]);

  // --- Yakın yerler: restoran/kafe/market/mağaza vb. (güvenlik amaçlı değil) ---
  useEffect(() => {
    if (!showNearby) return;
    const ref = userPos || start || (currentRegion ? { lat: currentRegion.center[0], lng: currentRegion.center[1] } : null);
    if (!ref) return;
    api
      .nearbyPlaces({ lat: ref.lat, lng: ref.lng, region })
      .then((d) => setNearbyPlaces(d.places || []))
      .catch(() => setNearbyPlaces([]));
  }, [showNearby, userPos, start, region, currentRegion]);

  // --- Şehir geneli ısı haritası ---
  useEffect(() => {
    if (!showHeatmap || !effectiveTime) return;
    setHeatmapLoading(true);
    api
      .heatmap(region, effectiveTime)
      .then((d) => setHeatmapBands(d.bands || []))
      .catch(() => setHeatmapBands(null))
      .finally(() => setHeatmapLoading(false));
  }, [showHeatmap, region, effectiveTime]);

  // --- Harita tıklaması ---
  const handleMapClick = useCallback(
    (point) => {
      if (reportMode) {
        setPendingReport({ lat: point.lat, lng: point.lng, type: "unsafe", note: "" });
        if (isMobile) setSheetOpen(true);
        return;
      }
      setInspectedSegment(null);
      setError(null);
      if (!start) {
        startIsAuto.current = false;
        setStart(point);
        resolveLabel(point, setStartQuery, setResolvingStart);
        setEnd(null);
        setEndQuery("");
        setResult(null);
      } else if (!end) {
        setEnd(point);
        resolveLabel(point, setEndQuery, setResolvingEnd);
      } else {
        startIsAuto.current = false;
        setStart(point);
        resolveLabel(point, setStartQuery, setResolvingStart);
        setEnd(null);
        setEndQuery("");
        setResult(null);
      }
    },
    [reportMode, start, end, isMobile, resolveLabel]
  );

  const handleSegmentClick = useCallback(
    (seg) => {
      setInspectedSegment(seg);
      if (isMobile) setSheetOpen(true);
    },
    [isMobile]
  );

  // --- Navigasyon ---
  const stopNav = useCallback(() => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    if (simIntervalRef.current != null) clearInterval(simIntervalRef.current);
    simIntervalRef.current = null;
    setNavActive(false);
    setNavIsSim(false);
    setUserPos(null);
    stopSpeaking();
  }, []);

  useEffect(() => () => stopNav(), [stopNav]);

  const startNav = () => {
    if (!active) return;
    if (!navigator.geolocation) {
      setError("Bu tarayıcıda konum servisi kullanılamıyor.");
      return;
    }
    setError(null);
    setStepIndex(0);
    setNavActive(true);
    setNavIsSim(false);
    if (isMobile) setSheetOpen(false);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setError("Konum alınamadı: " + err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  };

  const startSim = () => {
    if (!active) return;
    setError(null);
    setStepIndex(0);
    setNavActive(true);
    setNavIsSim(true);
    if (isMobile) setSheetOpen(false);
    simProgressRef.current = 0;
    const coords = active.route.geometry.coordinates;
    const kmPerTick = (SIM_SPEED_KMH / 3600) * (SIM_TICK_MS / 1000);
    simIntervalRef.current = setInterval(() => {
      simProgressRef.current += kmPerTick;
      setUserPos(interpolateAlongRoute(coords, simProgressRef.current));
      if (simProgressRef.current >= active.distanceKm) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
    }, SIM_TICK_MS);
  };

  // Konum ilerledikçe bir sonraki adıma otomatik geç
  useEffect(() => {
    if (!navActive || !userPos || !active) return;
    if (stepIndex >= active.steps.length - 1) return;
    const next = active.steps[stepIndex + 1];
    if (!next?.at) return;
    if (haversineM(userPos, { lng: next.at[0], lat: next.at[1] }) < ARRIVAL_RADIUS_M) {
      setStepIndex((i) => Math.min(i + 1, active.steps.length - 1));
    }
  }, [userPos, navActive, active, stepIndex]);

  const currentStep = active && navActive ? active.steps[stepIndex] : null;
  const nextStep = active && navActive ? active.steps[stepIndex + 1] : null;
  const liveDistance =
    nextStep?.at && userPos ? haversineM(userPos, { lng: nextStep.at[0], lat: nextStep.at[1] }) : null;

  // Yeni adıma geçince anons et
  useEffect(() => {
    if (!navActive || !voiceEnabled || !currentStep) return;
    speak(currentStep.instruction);
    warnedStepRef.current = -1; // yeni adımda yaklaşma uyarısı tekrar verilebilsin
  }, [navActive, voiceEnabled, stepIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bir sonraki dönüşe yaklaşınca ("50 metre sonra sağa dön") tek seferlik erken uyarı
  useEffect(() => {
    if (!navActive || !voiceEnabled || !nextStep || liveDistance == null) return;
    if (liveDistance <= PROXIMITY_WARNING_M && warnedStepRef.current !== stepIndex) {
      warnedStepRef.current = stepIndex;
      speak(`${Math.round(liveDistance)} metre sonra ${nextStep.instruction.toLowerCase()}`);
    }
  }, [liveDistance, navActive, voiceEnabled, nextStep, stepIndex]);

  // Navigasyon sırasında bulunulan parçanın skoru
  const currentScore = useMemo(() => {
    if (!navActive || !userPos || !active?.segments?.length) return null;
    let best = null;
    let bestDist = Infinity;
    for (const seg of active.segments) {
      for (const [lng, lat] of seg.coordinates) {
        const d = haversineM(userPos, { lat, lng });
        if (d < bestDist) {
          bestDist = d;
          best = seg;
        }
      }
    }
    return bestDist < 60 ? best?.score ?? null : null;
  }, [navActive, userPos, active]);

  // --- Eylemler ---
  const clearAll = () => {
    stopNav();
    startIsAuto.current = true; // sıfırlanınca "Nereden" tekrar canlı konumu takip etsin
    lastAutoStartRef.current = approxPos;
    if (approxPos) {
      setStart(approxPos);
      resolveLabel(approxPos, setStartQuery, setResolvingStart);
    } else {
      setStart(null);
      setStartQuery("");
    }
    setEnd(null);
    setEndQuery("");
    setResult(null);
    setError(null);
    setInspectedSegment(null);
    setPendingReport(null);
    setReportMode(false);
  };

  const submitReport = async () => {
    if (!pendingReport) return;
    try {
      await api.addReport({ ...pendingReport, region });
      // api.reports() hem state'i hem motoru (worker) güncel rapor listesiyle
      // senkronize eder — yeni rapor, bir sonraki rota hesaplamasında hemen
      // skora yansısın diye önce bu bekleniyor.
      const d = await api.reports(region);
      setReports(d.reports || []);
      setPendingReport(null);
      setReportMode(false);
      showToast("Rapor kaydedildi, teşekkürler.");
      if (start && end) setSafetyPref((p) => p + 1e-9); // rota yeniden hesaplansın diye (gözle fark edilmez) tetikleyici
    } catch (err) {
      setError("Rapor gönderilemedi: " + err.message);
    }
  };

  const confirmReport = async (id) => {
    try {
      await api.confirmReport(id);
      const d = await api.reports(region);
      setReports(d.reports || []);
      showToast("Teyidin kaydedildi.");
      // submitReport'taki gibi: teyit güven skorunu (dolayısıyla rapor
      // ağırlığını) artırıyor ama bu, ekrandaki mevcut rota otomatik
      // yeniden hesaplanmadan görünmüyordu — kullanıcı teyit ettiğinde
      // rotanın rengi/skoru hiç değişmiyormuş gibi görünüyordu.
      if (start && end) setSafetyPref((p) => p + 1e-9);
    } catch (err) {
      setError("Teyit gönderilemedi: " + err.message);
    }
  };

  const shareLink = async () => {
    const url = encodeStateToUrl({ start, end, region, timeMode, safetyPref });
    try {
      await navigator.clipboard.writeText(url);
      showToast("Bağlantı kopyalandı.");
    } catch {
      window.history.replaceState({}, "", url);
      showToast("Bağlantı adres çubuğunda.");
    }
  };

  const doSaveRoute = () => {
    if (!start || !end) return;
    const name = window.prompt("Bu rotaya bir ad ver:", `${startQuery.split(",")[0]} → ${endQuery.split(",")[0]}`);
    if (!name) return;
    const entry = {
      id: `${start.lat},${start.lng}-${end.lat},${end.lng}`,
      name,
      start,
      end,
      region,
      startLabel: startQuery.split(",")[0],
      endLabel: endQuery.split(",")[0],
    };
    setSavedRoutes(saveRoute(entry));
    showToast("Rota kaydedildi.");
  };

  const loadRoute = (r) => {
    startIsAuto.current = false;
    setRegion(r.region);
    setStart(r.start);
    setEnd(r.end);
    setStartQuery(r.startLabel);
    setEndQuery(r.endLabel);
    if (isMobile) setSheetOpen(true);
  };

  const switchRegion = (id) => {
    if (id === region) return;
    setRegion(id);
    clearAll();
    setFlyTrigger((t) => t + 1);
  };

  const regionList = regions.length
    ? regions
    : [
        { id: "eindhoven", label: "Eindhoven" },
        { id: "nuenen", label: "Nuenen" },
      ];

  if (!locationReady) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          height: "100dvh",
          background: "var(--bg)",
          color: "var(--text-dim)",
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "3px solid var(--surface-2)",
            borderTopColor: "var(--text-dim)",
            animation: "saferoute-spin 0.8s linear infinite",
          }}
        />
        <div>Konumun belirleniyor…</div>
        <style>{"@keyframes saferoute-spin { to { transform: rotate(360deg); } }"}</style>
      </div>
    );
  }

  return (
    <div className={`app ${isMobile ? "mobile" : ""}`}>
      <aside className={`panel ${isMobile && !sheetOpen ? "collapsed" : ""} ${accessibleMode ? "a11y-mode" : ""}`}>
        {isMobile && (
          <button
            className="sheet-handle"
            onClick={() => setSheetOpen((v) => !v)}
            aria-label={sheetOpen ? "Paneli küçült" : "Paneli aç"}
          >
            <span />
          </button>
        )}

        <div className="panel-scroll">
          <header className="brand">
            <h1>SafeRoute</h1>
            <p>Güvenli yaya navigasyonu</p>
          </header>

          {navActive ? (
            <NavBanner
              currentStep={currentStep}
              nextStep={nextStep}
              liveDistance={liveDistance}
              onStop={stopNav}
              currentScore={currentScore}
              isSim={navIsSim}
              voiceEnabled={voiceEnabled}
              onToggleVoice={toggleVoice}
              voiceSupported={isVoiceSupported()}
            />
          ) : (
            <>
              <div className="segmented" role="group" aria-label="Bölge">
                {regionList.map((r) => (
                  <button
                    key={r.id}
                    className={`seg-btn ${region === r.id ? "active" : ""}`}
                    onClick={() => switchRegion(r.id)}
                    aria-pressed={region === r.id}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              <div className="time-switch" role="group" aria-label="Zaman dilimi">
                <button
                  className={`time-btn ${timeMode === "auto" ? "active" : ""}`}
                  onClick={() => setTimeMode("auto")}
                >
                  Şimdi · {TIME_LABELS[autoTimeProfile]}
                </button>
                {Object.entries(TIME_LABELS).map(([key, label]) => (
                  <button
                    key={key}
                    className={`time-btn ${timeMode === key ? "active" : ""}`}
                    onClick={() => setTimeMode(key)}
                    title={TIME_RANGES[key]}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <SearchField
                placeholder="Nereden"
                value={startQuery}
                onChange={setStartQuery}
                dotClass="dot-start"
                region={region}
                near={nearForStart}
                busy={resolvingStart}
                onSelect={(s) => {
                  startIsAuto.current = false;
                  if (!s) {
                    setStart(null);
                    setResult(null);
                    return;
                  }
                  setStart({ lat: s.lat, lng: s.lng });
                  setStartQuery(s.label);
                }}
              />
              <SearchField
                placeholder="Nereye"
                value={endQuery}
                onChange={setEndQuery}
                dotClass="dot-end"
                region={region}
                near={nearForEnd}
                busy={resolvingEnd}
                onSelect={(s) => {
                  if (!s) {
                    setEnd(null);
                    setResult(null);
                    return;
                  }
                  setEnd({ lat: s.lat, lng: s.lng });
                  setEndQuery(s.label);
                }}
              />

              <div className="slider-row">
                <label htmlFor="safety-pref">
                  Güvenlik önceliği: <b>{SAFETY_PREF_LABELS[Math.round(safetyPref * 4)]}</b>
                </label>
                <input
                  id="safety-pref"
                  type="range"
                  min="0"
                  max="1"
                  step="0.25"
                  value={safetyPref}
                  onChange={(e) => setSafetyPref(parseFloat(e.target.value))}
                  // Panelde kaydırırken tekerleğin değeri değiştirmesini engelle
                  onWheel={(e) => e.currentTarget.blur()}
                />
                <div className="slider-hint">Yüksek = daha uzun ama daha güvenli rotaya razıyım</div>
              </div>

              <button
                className={`a11y-toggle ${accessibleMode ? "active" : ""}`}
                onClick={() => setAccessibleMode((v) => !v)}
                aria-pressed={accessibleMode}
              >
                <span aria-hidden="true">♿</span>
                <span>
                  <b>Erişilebilir Mod</b>
                  <small>Merdivenden kaçın, düz/kaplamalı yolları tercih et</small>
                </span>
                <span className="a11y-switch" aria-hidden="true" />
              </button>

              {result?.[selectedRoute]?.hasSteps && accessibleMode && (
                <div className="status error">
                  ⚠️ Bu rota kaçınılamayan kısa bir merdiven içeriyor.
                </div>
              )}

              {isWet && (
                <div className="status">
                  {wetKind === "snow" ? "❄️" : "🌧️"} {wetKind === "snow" ? "Kar" : "Yağmur"} yağıyor
                  {temperature != null ? ` (${Math.round(temperature)}°C)` : ""} — merdiven ve
                  toprak/kaplamasız yollar rota hesabında cezalandırılıyor.
                </div>
              )}

              <div className="toolbar">
                <button
                  className={`tool-btn ${showHavens ? "active" : ""}`}
                  onClick={() => setShowHavens((v) => !v)}
                >
                  🛟 Güvenli nokta
                </button>
                <button
                  className={`tool-btn ${showNearby ? "active" : ""}`}
                  onClick={() => setShowNearby((v) => !v)}
                >
                  🍽️ Yakın yerler
                </button>
                <button
                  className={`tool-btn ${showHeatmap ? "active" : ""}`}
                  onClick={() => setShowHeatmap((v) => !v)}
                >
                  {heatmapLoading ? <span className="field-spinner" aria-hidden="true" /> : "🗺️"} Isı haritası
                </button>
                <button
                  className={`tool-btn ${reportMode ? "active" : ""}`}
                  onClick={() => {
                    setReportMode((v) => !v);
                    setPendingReport(null);
                  }}
                >
                  ⚠️ Bildir
                </button>
                <button className="tool-btn emergency" onClick={() => setEmergencyOpen(true)}>
                  🆘 Acil Durum
                </button>
                <a className="tool-btn" href="?study=1" target="_blank" rel="noreferrer">
                  🔬 Çalışmaya katıl
                </a>
                {result && (
                  <>
                    <button className="tool-btn" onClick={shareLink}>
                      🔗 Paylaş
                    </button>
                    <button className="tool-btn" onClick={doSaveRoute}>
                      ☆ Kaydet
                    </button>
                  </>
                )}
              </div>

              {emergencyOpen && <EmergencyPanel onClose={() => setEmergencyOpen(false)} />}

              {reportMode && !pendingReport && (
                <div className="status">Bildirmek istediğin noktaya haritada dokun.</div>
              )}
              {pendingReport && (
                <ReportForm
                  pending={pendingReport}
                  onChange={setPendingReport}
                  onSubmit={submitReport}
                  onCancel={() => setPendingReport(null)}
                />
              )}

              {loading && (
                <div className="status loading">
                  <span className="spinner" aria-hidden="true" />
                  {loadingMsg}
                </div>
              )}
              {error && <div className="status error">{error}</div>}

              {!start && !reportMode && !loading && (
                <div className="hint">Adres yaz ya da haritaya dokunarak başlangıç noktası seç.</div>
              )}
              {start && !end && !reportMode && !loading && (
                <div className="hint">Şimdi de varış noktasını seç.</div>
              )}

              {result && (
                <>
                  <RouteCards result={result} selectedRoute={selectedRoute} onSelect={setSelectedRoute} />
                  <div className="nav-buttons">
                    <button className="btn-primary" onClick={startNav}>
                      Navigasyonu başlat
                    </button>
                    <button className="btn-secondary" onClick={startSim}>
                      Simülasyon (demo)
                    </button>
                  </div>
                  <ScoreLegend />
                  {inspectedSegment && (
                    <SegmentInspector segment={inspectedSegment} onClose={() => setInspectedSegment(null)} />
                  )}
                  <StepsList steps={active.steps} activeIndex={-1} />
                </>
              )}

              {showHavens && <HavensList havens={havens} timeLabel={TIME_LABELS[effectiveTime]} />}

              <SavedRoutes
                routes={savedRoutes}
                onLoad={loadRoute}
                onDelete={(id) => setSavedRoutes(deleteSavedRoute(id))}
              />

              {(start || end) && (
                <button className="btn-ghost wide" onClick={clearAll}>
                  Temizle
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <main className="map-wrap">
        <RouteMap
          start={start}
          end={end}
          result={result}
          activeRoute={active}
          selectedRoute={selectedRoute}
          onSelectRoute={setSelectedRoute}
          onMapClick={handleMapClick}
          onSegmentClick={handleSegmentClick}
          userPos={userPos}
          approxPos={approxPos}
          navActive={navActive}
          regionCenter={currentRegion?.center}
          flyTrigger={flyTrigger}
          fitTrigger={fitTrigger}
          layoutTrigger={`${sheetOpen}-${isMobile}`}
          havens={havens}
          showHavens={showHavens}
          nearbyPlaces={nearbyPlaces}
          showNearby={showNearby}
          reports={reports}
          onConfirmReport={confirmReport}
          heatmapBands={showHeatmap ? heatmapBands : null}
        />
        {isWet && <div className={`map-weather-fx ${wetKind === "snow" ? "snow" : "rain"}`} aria-hidden="true" />}
        {temperature != null && (
          <div className="map-weather-badge">
            {wetKind === "snow" ? "❄️" : wetKind === "rain" ? "🌧️" : "🌡️"} {Math.round(temperature)}°C
          </div>
        )}
        {reportMode && <div className="map-mode-badge">Bildirme modu — haritaya dokun</div>}
        {showHeatmap && (
          <div className="heatmap-legend">
            <span>{TIME_LABELS[effectiveTime]} — şehir geneli güvenlik skoru</span>
            <div className="legend-scale">
              {[
                { c: "#dc2626", t: "0-34" },
                { c: "#f97316", t: "35-49" },
                { c: "#eab308", t: "50-64" },
                { c: "#84cc16", t: "65-79" },
                { c: "#16a34a", t: "80+" },
              ].map((x) => (
                <span key={x.t} className="legend-item">
                  <i style={{ background: x.c }} />
                  {x.t}
                </span>
              ))}
            </div>
          </div>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
