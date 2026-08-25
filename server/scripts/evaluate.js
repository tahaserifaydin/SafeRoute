// Toplu değerlendirme: rastgele başlangıç-bitiş çiftleri üzerinde standart (en kısa)
// rota ile güvenlik-ağırlıklı rotayı karşılaştırıp özet istatistik üretir.
//
// Kullanım: node scripts/evaluate.js [bölge] [örnek-sayısı] [zaman-profili]
// Örn:      node scripts/evaluate.js eindhoven 40 lateNight
//
// Not: Sunucunun (npm start) çalışıyor olması gerekir.
// Karşılaştırma tabanı olarak "en hızlı rota" kullanılır; bu, Google Maps/OSRM gibi
// ticari motorların varsayılan davranışıyla (yalnızca mesafe/süre optimizasyonu)
// aynı hedef fonksiyonudur.
const API = process.env.API || "http://localhost:3001";

const region = process.argv[2] || "eindhoven";
const sampleCount = parseInt(process.argv[3] || "30", 10);
const timeProfile = process.argv[4] || "lateNight";
const safetyPref = parseFloat(process.argv[5] || "0.6");

const MIN_DIST_KM = 0.4;
const MAX_DIST_KM = 3.0;

function randomIn(min, max) {
  return min + Math.random() * (max - min);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

async function main() {
  const regionsRes = await fetch(`${API}/api/regions`);
  const { regions } = await regionsRes.json();
  const r = regions.find((x) => x.id === region);
  if (!r) throw new Error(`Bölge bulunamadı: ${region}`);
  const [minLng, minLat, maxLng, maxLat] = r.bbox;

  console.log(`Değerlendirme: ${r.label}, ${sampleCount} rota çifti, zaman profili: ${timeProfile}`);
  console.log("Rastgele nokta çiftleri deneniyor...\n");

  const rows = [];
  let attempts = 0;
  while (rows.length < sampleCount && attempts < sampleCount * 6) {
    attempts++;
    // Başlangıcı bölge içinde rastgele seç; hedefi onun yakınında seç. Tamamen
    // rastgele iki nokta genelde 8-10 km uzaklıkta çıkıp yürüme mesafesi
    // filtresine takıldığı için örnekleme çok verimsiz oluyordu.
    const sLat = randomIn(minLat, maxLat);
    const sLng = randomIn(minLng, maxLng);
    const offsetLat = randomIn(-0.012, 0.012); // ~1.3 km
    const offsetLng = randomIn(-0.018, 0.018);
    const eLat = Math.min(maxLat, Math.max(minLat, sLat + offsetLat));
    const eLng = Math.min(maxLng, Math.max(minLng, sLng + offsetLng));

    const url =
      `${API}/api/route?startLat=${sLat}&startLng=${sLng}&endLat=${eLat}&endLng=${eLng}` +
      `&region=${region}&time=${timeProfile}&safetyPref=${safetyPref}`;
    let data;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch {
      continue;
    }
    if (data.error || !data.fast || !data.safe) continue;
    if (data.fast.distanceKm < MIN_DIST_KM || data.fast.distanceKm > MAX_DIST_KM) continue;

    rows.push({
      distFast: data.fast.distanceKm,
      distSafe: data.safe.distanceKm,
      avgFast: data.fast.avgSafetyScore,
      avgSafe: data.safe.avgSafetyScore,
      minFast: data.fast.minSafetyScore,
      minSafe: data.safe.minSafetyScore,
      detourPct: ((data.safe.distanceKm - data.fast.distanceKm) / data.fast.distanceKm) * 100,
      gainAvg: data.safe.avgSafetyScore - data.fast.avgSafetyScore,
      gainMin: data.safe.minSafetyScore - data.fast.minSafetyScore,
      identical: data.safe.distanceKm === data.fast.distanceKm && data.safe.avgSafetyScore === data.fast.avgSafetyScore,
    });
    process.stdout.write(`\r  toplanan: ${rows.length}/${sampleCount}`);
  }
  console.log("\n");

  if (!rows.length) {
    console.log("Yeterli örnek toplanamadı.");
    return;
  }

  const changed = rows.filter((x) => !x.identical);
  const fmt = (v, d = 1) => (v == null ? "-" : v.toFixed(d));

  console.log("=".repeat(58));
  console.log(`ÖRNEKLEM: ${rows.length} rota çifti  |  rota değişen: ${changed.length} (%${fmt((changed.length / rows.length) * 100, 0)})`);
  console.log("=".repeat(58));
  console.log("");
  console.log("Metrik                        | En hızlı | En güvenli |  Fark");
  console.log("-".repeat(58));
  console.log(
    `Ortalama güvenlik skoru       |  ${fmt(mean(rows.map((x) => x.avgFast)))}   |   ${fmt(
      mean(rows.map((x) => x.avgSafe))
    )}    | ${fmt(mean(rows.map((x) => x.gainAvg)), 1) > 0 ? "+" : ""}${fmt(mean(rows.map((x) => x.gainAvg)))}`
  );
  console.log(
    `En düşük nokta (rotanın zayıf halkası) | ${fmt(mean(rows.map((x) => x.minFast)))} | ${fmt(
      mean(rows.map((x) => x.minSafe))
    )} | +${fmt(mean(rows.map((x) => x.gainMin)))}`
  );
  console.log(
    `Mesafe (km)                   |  ${fmt(mean(rows.map((x) => x.distFast)), 2)}   |   ${fmt(
      mean(rows.map((x) => x.distSafe)),
      2
    )}    | +${fmt(mean(rows.map((x) => x.detourPct)), 1)}%`
  );
  console.log("");
  console.log(`Medyan sapma (detour)         : %${fmt(median(rows.map((x) => x.detourPct)))}`);
  console.log(`Medyan güvenlik kazancı       : ${fmt(median(rows.map((x) => x.gainAvg)))} puan`);
  console.log("");

  // Sapma karşılığında elde edilen kazanç dağılımı
  const buckets = [
    { label: "Sapma yok (%0)", test: (x) => x.detourPct < 0.5 },
    { label: "Az sapma (%0-5)", test: (x) => x.detourPct >= 0.5 && x.detourPct < 5 },
    { label: "Orta sapma (%5-15)", test: (x) => x.detourPct >= 5 && x.detourPct < 15 },
    { label: "Yüksek sapma (>%15)", test: (x) => x.detourPct >= 15 },
  ];
  console.log("Sapma dağılımı ve karşılığında güvenlik kazancı:");
  for (const b of buckets) {
    const g = rows.filter(b.test);
    if (!g.length) continue;
    console.log(
      `  ${b.label.padEnd(22)} ${String(g.length).padStart(3)} rota | ort. kazanç: +${fmt(mean(g.map((x) => x.gainAvg)))} puan`
    );
  }
}

main().catch((err) => {
  console.error("HATA:", err.message);
  process.exit(1);
});
