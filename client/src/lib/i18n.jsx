import { createContext, useCallback, useContext, useMemo, useState } from "react";

const STORAGE_KEY = "saferoute.lang";

// Tüm statik arayüz metinleri burada. {değişken} biçimindeki yer tutucular
// t(key, {değişken: değer}) ile doldurulur.
const STRINGS = {
  "app.subtitle": { tr: "Güvenli yaya navigasyonu", en: "Safe pedestrian navigation" },
  "app.locating": { tr: "Konumun belirleniyor…", en: "Finding your location…" },

  "panel.collapse": { tr: "Paneli küçült", en: "Collapse panel" },
  "panel.expand": { tr: "Paneli aç", en: "Expand panel" },

  "region.groupLabel": { tr: "Bölge", en: "Region" },
  "time.groupLabel": { tr: "Zaman dilimi", en: "Time of day" },
  "time.now": { tr: "Şimdi · {label}", en: "Now · {label}" },

  "search.from": { tr: "Nereden", en: "From" },
  "search.to": { tr: "Nereye", en: "To" },
  "search.searching": { tr: "Aranıyor…", en: "Searching…" },
  "search.noResults": { tr: "Sonuç bulunamadı", en: "No results found" },

  "safety.prefLabel": { tr: "Güvenlik önceliği: {label}", en: "Safety priority: {label}" },
  "safety.hint": {
    tr: "Yüksek = daha uzun ama daha güvenli rotaya razıyım",
    en: "High = I accept a longer but safer route",
  },

  "a11y.title": { tr: "Erişilebilir Mod", en: "Accessible Mode" },
  "a11y.desc": {
    tr: "Merdivenden kaçın, düz/kaplamalı yolları tercih et",
    en: "Avoid stairs, prefer flat/paved paths",
  },
  "a11y.stepsWarning": {
    tr: "⚠️ Bu rota kaçınılamayan kısa bir merdiven içeriyor.",
    en: "⚠️ This route includes a short, unavoidable staircase.",
  },

  "weather.rain": { tr: "Yağmur", en: "Rain" },
  "weather.snow": { tr: "Kar", en: "Snow" },
  "weather.penaltyNote": {
    tr: "{kind} yağıyor{temp} — merdiven ve toprak/kaplamasız yollar rota hesabında cezalandırılıyor.",
    en: "{kind} right now{temp} — stairs and unpaved paths are penalized in route scoring.",
  },
  "weather.snowing": { tr: "yağıyor", en: "falling" },

  "toolbar.havens": { tr: "🛟 Güvenli nokta", en: "🛟 Safe havens" },
  "toolbar.nearby": { tr: "🍽️ Yakın yerler", en: "🍽️ Nearby places" },
  "toolbar.heatmap": { tr: "🗺️ Isı haritası", en: "🗺️ Heat map" },
  "toolbar.heatmapText": { tr: "Isı haritası", en: "Heat map" },
  "toolbar.report": { tr: "⚠️ Bildir", en: "⚠️ Report" },
  "toolbar.emergency": { tr: "🆘 Acil Durum", en: "🆘 Emergency" },
  "toolbar.study": { tr: "🔬 Çalışmaya katıl", en: "🔬 Join the study" },
  "toolbar.share": { tr: "🔗 Paylaş", en: "🔗 Share" },
  "toolbar.save": { tr: "☆ Kaydet", en: "☆ Save" },

  "report.tapHint": { tr: "Bildirmek istediğin noktaya haritada dokun.", en: "Tap the point on the map you want to report." },
  "report.modeBadge": { tr: "Bildirme modu — haritaya dokun", en: "Report mode — tap the map" },
  "report.title": { tr: "Bu noktayı bildir", en: "Report this point" },
  "report.notePlaceholder": { tr: "Kısa not (isteğe bağlı)", en: "Short note (optional)" },
  "report.disclaimer": {
    tr: "Raporlar zamanla ağırlığını yitirir ve başkalarınca teyit edilince güçlenir; tek bir rapor rotayı belirlemez.",
    en: "Reports lose weight over time and gain strength when confirmed by others; a single report never determines a route.",
  },
  "report.effectNote": {
    tr: "Kullanıcı raporları nedeniyle {base} → {score} ({sign}{delta} puan)",
    en: "Due to user reports: {base} → {score} ({sign}{delta} pts)",
  },
  "report.trustPercent": { tr: "güven %{trust}", en: "{trust}% trust" },
  "report.confirmationsCount": { tr: "{n} teyit", en: "{n} confirmations" },
  "report.confirmToo": { tr: "Ben de gördüm", en: "I saw this too" },

  "route.calculating": { tr: "Rota hesaplanıyor…", en: "Calculating route…" },
  "route.firstTimePrep": {
    tr: "Bu zaman dilimi ilk kez kullanılıyor, yol ağı hazırlanıyor…",
    en: "First time using this time profile, preparing the road network…",
  },
  "route.namePrompt": { tr: "Bu rotaya bir ad ver:", en: "Name this route:" },
  "route.fastest": { tr: "En Hızlı", en: "Fastest" },
  "route.safest": { tr: "En Güvenli", en: "Safest" },
  "route.minutes": { tr: "{n} dk", en: "{n} min" },
  "route.average": { tr: "ortalama", en: "average" },
  "route.lowest": { tr: "en düşük", en: "lowest" },
  "route.lightPercent": { tr: "💡 %{n} aydınlık", en: "💡 {n}% lit" },
  "route.sidewalkPercent": { tr: "🚶 %{n} kaldırım", en: "🚶 {n}% sidewalk" },
  "route.longerByPercent": { tr: "%{n} daha uzun", en: "{n}% longer" },
  "route.sameDistance": { tr: "Aynı mesafede", en: "Same distance" },
  "route.saferBy": {
    tr: "{detour}, ama güvenlik skoru {gain} puan{weakest} daha yüksek.",
    en: "{detour}, but the safety score is {gain} pts{weakest} higher.",
  },
  "route.weakestAlsoHigher": {
    tr: " ve en zayıf noktası +{n} puan",
    en: " and the weakest point +{n} pts",
  },
  "route.noAlternative": {
    tr: "Bu iki nokta arasında daha güvenli bir alternatif bulunamadı — tek makul yol bu.",
    en: "No safer alternative was found between these two points — this is the only reasonable route.",
  },
  "route.selectedLabel": { tr: "Seçili rota: ", en: "Selected route: " },

  "nav.start": { tr: "Navigasyonu başlat", en: "Start navigation" },
  "nav.simulate": { tr: "Simülasyon (demo)", en: "Simulate (demo)" },
  "nav.stop": { tr: "Navigasyonu durdur", en: "Stop navigation" },
  "nav.simTag": { tr: "Simülasyon", en: "Simulation" },
  "nav.inDistance": { tr: "{dist} sonra", en: "in {dist}" },
  "nav.then": { tr: "Sonra: ", en: "Then: " },
  "nav.currentSegment": { tr: "Bulunduğun bölüm: ", en: "Your current segment: " },
  "voice.mute": { tr: "Sesi kapat", en: "Mute voice" },
  "voice.unmute": { tr: "Sesi aç", en: "Unmute voice" },

  "action.clear": { tr: "Temizle", en: "Clear" },
  "action.submit": { tr: "Gönder", en: "Submit" },
  "action.cancel": { tr: "İptal", en: "Cancel" },
  "action.close": { tr: "Kapat", en: "Close" },
  "action.copied": { tr: "Kopyalandı ✓", en: "Copied ✓" },
  "action.shareOrCopy": { tr: "Paylaş / Kopyala", en: "Share / Copy" },
  "action.stop": { tr: "Durdur", en: "Stop" },

  "hint.pickStart": {
    tr: "Adres yaz ya da haritaya dokunarak başlangıç noktası seç.",
    en: "Type an address or tap the map to choose a starting point.",
  },
  "hint.pickEnd": { tr: "Şimdi de varış noktasını seç.", en: "Now choose your destination." },

  "address.resolving": { tr: "Adres çözümleniyor…", en: "Resolving address…" },

  "toast.reportSaved": { tr: "Rapor kaydedildi, teşekkürler.", en: "Report saved, thank you." },
  "toast.confirmSaved": { tr: "Teyidin kaydedildi.", en: "Your confirmation was saved." },
  "toast.linkCopied": { tr: "Bağlantı kopyalandı.", en: "Link copied." },
  "toast.linkInAddressBar": { tr: "Bağlantı adres çubuğunda.", en: "Link is in the address bar." },
  "toast.routeSaved": { tr: "Rota kaydedildi.", en: "Route saved." },

  "error.serverUnreachable": {
    tr: "Sunucuya bağlanılamadı. Arka uç çalışıyor mu?",
    en: "Could not reach the server. Is the backend running?",
  },
  "error.noGeoBrowser": { tr: "Bu tarayıcıda konum servisi kullanılamıyor.", en: "Location services aren't available in this browser." },
  "error.noGeoDevice": { tr: "Bu cihazda konum servisi yok.", en: "This device has no location service." },
  "error.locationFailed": { tr: "Konum alınamadı: {msg}", en: "Couldn't get location: {msg}" },
  "error.reportFailed": { tr: "Rapor gönderilemedi: {msg}", en: "Couldn't send report: {msg}" },
  "error.confirmFailed": { tr: "Teyit gönderilemedi: {msg}", en: "Couldn't send confirmation: {msg}" },
  "error.sessionStartFailed": { tr: "Oturum başlatılamadı: {msg}", en: "Couldn't start session: {msg}" },

  "havens.none": { tr: "Yakında sığınılabilecek nokta bulunamadı.", en: "No nearby safe havens found." },
  "havens.title": { tr: "Sığınılabilecek noktalar ", en: "Safe havens " },
  "havens.byTime": { tr: "{time} saatine göre", en: "as of {time}" },
  "havens.open247": { tr: "7/24 açık", en: "Open 24/7" },
  "havens.openNow": { tr: "Şu an açık", en: "Open now" },
  "havens.closedNow": { tr: "Şu an kapalı", en: "Closed now" },

  "saved.title": { tr: "Kayıtlı rotalar", en: "Saved routes" },
  "saved.delete": { tr: "Sil", en: "Delete" },

  "road.unnamed": { tr: "İsimsiz yol", en: "Unnamed road" },
  "breakdown.legendNote": {
    tr: "Kırmızı satırlar puan düşürür, diğerleri katkı sağlar.",
    en: "Red rows lower the score, the others contribute positively.",
  },
  "legend.title": { tr: "Rota rengi = güvenlik skoru", en: "Route color = safety score" },
  "legend.hint": { tr: "Haritada bir parçaya dokun → neden bu puan?", en: "Tap a route segment → why this score?" },

  "heatmap.legendTitle": { tr: "{time} — şehir geneli güvenlik skoru", en: "{time} — citywide safety score" },

  "emergency.call112": { tr: "📞 112'yi Ara", en: "📞 Call 112" },
  "emergency.shareLocation": { tr: "📍 Canlı Konumumu Paylaş", en: "📍 Share My Live Location" },
  "emergency.liveActive": { tr: "Canlı konum paylaşımı aktif", en: "Live location sharing active" },
  "emergency.disclaimer": {
    tr: "Paylaştığın bağlantıyı açan herkes konumunu 6 saat boyunca (ya da sen durdurana kadar) canlı görebilir. Sadece güvendiğin kişilerle paylaş.",
    en: "Anyone who opens your shared link can see your live location for 6 hours (or until you stop it). Only share it with people you trust.",
  },
  "emergency.shareText": { tr: "Canlı konumumu görüntüle (SafeRoute):", en: "View my live location (SafeRoute):" },
  "emergency.shareTitle": { tr: "Canlı konum", en: "Live location" },

  "language.toggle": { tr: "EN", en: "TR" },
};

export const TIME_LABELS_I18N = {
  morning: { tr: "Sabah", en: "Morning" },
  midday: { tr: "Öğle", en: "Midday" },
  evening: { tr: "Akşam", en: "Evening" },
  night: { tr: "Gece", en: "Night" },
  lateNight: { tr: "Gece yarısı", en: "Late night" },
};

export const REPORT_TYPE_LABELS_I18N = {
  dark: { tr: "Karanlık / lamba yok", en: "Dark / no lighting" },
  unsafe: { tr: "Tekinsiz hissettim", en: "Felt unsafe" },
  harassment: { tr: "Taciz / rahatsız edilme", en: "Harassment" },
  blocked: { tr: "Yol kapalı / geçilmiyor", en: "Path blocked" },
  safe: { tr: "Burası güvenli", en: "This is safe" },
};

export const BREAKDOWN_LABELS_I18N = {
  lighting: { tr: "Aydınlatma", en: "Lighting" },
  pedInfra: { tr: "Yaya altyapısı", en: "Pedestrian infrastructure" },
  frontage: { tr: "Açık işletme (gözetim)", en: "Active frontage (surveillance)" },
  roadType: { tr: "Yol karakteri", en: "Road character" },
  nightlifeRisk: { tr: "Bar/gece hayatı yoğunluğu", en: "Bar/nightlife density" },
  crimeRisk: { tr: "Kayıtlı suç riski (mahalle)", en: "Recorded crime risk (neighborhood)" },
};

export const SAFETY_PREF_LABELS_I18N = [
  { tr: "Çok düşük", en: "Very low" },
  { tr: "Düşük", en: "Low" },
  { tr: "Orta", en: "Medium" },
  { tr: "Yüksek", en: "High" },
  { tr: "Çok yüksek", en: "Very high" },
];

export const SCORE_BAND_NAMES_I18N = [
  { tr: "Çok tehlikeli", en: "Very dangerous" },
  { tr: "Tehlikeli", en: "Dangerous" },
  { tr: "Hafif tehlikeli", en: "Slightly risky" },
  { tr: "İyi", en: "Good" },
  { tr: "Güvenli", en: "Safe" },
];

export const SCORE_UNKNOWN_I18N = { tr: "Bilinmiyor", en: "Unknown" };

// Rota motorunun (worker.js) ürettiği yön talimatları sabit bir kalıptan geliyor
// (bkz. engine/worker.js turnLabel/buildSteps) — motor her zaman Türkçe üretiyor,
// burada bilinen kalıpları İngilizce'ye çeviriyoruz. Motoru dile duyarlı hale
// getirmek (her adımda dil parametresi taşımak) çok daha büyük bir değişiklik
// olurdu; talimatlar sabit/numaralandırılabilir olduğu için bu çeviri tablosu yeterli.
const INSTRUCTION_EN = {
  "Yürümeye başla": "Start walking",
  "Hedefe ulaştın": "You've arrived",
  "Sağa dön": "Turn right",
  "Sola dön": "Turn left",
  "Hafif sağa dön": "Turn slightly right",
  "Hafif sola dön": "Turn slightly left",
  "Keskin sağa dön": "Turn sharply right",
  "Keskin sola dön": "Turn sharply left",
};

export function translateInstruction(instruction, lang) {
  if (lang !== "en") return instruction;
  return INSTRUCTION_EN[instruction] || instruction;
}

function interpolate(template, vars) {
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "tr";
    } catch {
      return "tr";
    }
  });

  const setLang = useCallback((l) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* localStorage yoksa (gizli sekme vb.) dil sadece bu oturumda kalır */
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === "tr" ? "en" : "tr");
  }, [lang, setLang]);

  const t = useCallback(
    (key, vars) => {
      const entry = STRINGS[key];
      if (!entry) return key;
      return interpolate(entry[lang] || entry.tr, vars);
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, toggleLang, t }), [lang, setLang, toggleLang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage, LanguageProvider içinde kullanılmalı");
  return ctx;
}
