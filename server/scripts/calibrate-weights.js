// Elle seçilen bileşen ağırlıklarını (0.35 aydınlatma, 0.20 yaya altyapısı, ...)
// GERÇEK suç verisine karşı test eder. Mantık: bileşenlerin (aydınlatma, yaya
// altyapısı, gözetim, yol karakteri) mahalle ortalamaları ile o mahallenin gerçek
// (nüfus-düzeltmeli) suç oranı arasında doğrusal regresyon kurulur. Katsayıların
// işareti teoriyi doğruluyor mu (daha iyi aydınlatma → daha az suç), büyüklüğü
// ise hangi bileşenin GERÇEKTEN ne kadar belirleyici olduğunu gösterir.
//
// Kullanım: node scripts/calibrate-weights.js <bölge>
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const dirName = process.argv[2];
if (!dirName) {
  console.error("Kullanım: node calibrate-weights.js <bölge>");
  process.exit(1);
}
const DATA_DIR = path.join(__dirname, "..", "..", "data", dirName);
const POI_AMBIENT_WEIGHT = 25;
const SHRINKAGE_K = 1500;
const CRIME_CLASS_WEIGHTS = { violent: 1.0, property: 0.35, disorder: 0.5 };

// --- Basit OLS (En Küçük Kareler) regresyon: Gauss-Jordan ile matris tersi ---
function invertMatrix(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const div = A[col][col];
    if (Math.abs(div) < 1e-12) throw new Error("Tekil matris (kolineer özellikler) — regresyon çözülemedi.");
    for (let j = 0; j < 2 * n; j++) A[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      for (let j = 0; j < 2 * n; j++) A[r][j] -= factor * A[col][j];
    }
  }
  return A.map((row) => row.slice(n));
}

function matMulVec(M, v) {
  return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

function transpose(M) {
  return M[0].map((_, j) => M.map((row) => row[j]));
}

function matMul(A, B) {
  const Bt = transpose(B);
  return A.map((row) => Bt.map((col) => row.reduce((s, x, i) => s + x * col[i], 0)));
}

// beta = (X^T X)^-1 X^T y
function olsRegression(X, y) {
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const XtXinv = invertMatrix(XtX);
  const Xty = Xt.map((row) => row.reduce((s, x, i) => s + x * y[i], 0));
  const beta = matMulVec(XtXinv, Xty);

  // R^2 hesapla
  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  const predictions = X.map((row) => row.reduce((s, x, j) => s + x * beta[j], 0));
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const ssRes = y.reduce((s, yi, i) => s + (yi - predictions[i]) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  return { beta, r2 };
}

function main() {
  console.log(`[${dirName}] Kalibrasyon verisi hazırlanıyor...\n`);
  const roads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "roads_scored.geojson")));
  const crimeGj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "crime_buurten.geojson")));
  const amenities = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "amenities.geojson")));

  const usableCrime = crimeGj.features.filter(
    (f) => f.properties.crime_count != null && typeof f.properties.aantalInwoners === "number"
  );

  // Ambient nüfus (sakin + işletme) — score-region.js ile aynı mantık
  const buurtBboxes = usableCrime.map((b) => ({ b, bbox: turf.bbox(b) }));
  const poiCount = new Map();
  for (const f of amenities.features) {
    const [lng, lat] = f.geometry.coordinates;
    for (const { b, bbox } of buurtBboxes) {
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (turf.booleanPointInPolygon(f, b.geometry)) {
        poiCount.set(b.properties.buurtcode, (poiCount.get(b.properties.buurtcode) || 0) + 1);
        break;
      }
    }
  }

  const weighted = (p) =>
    (p.crime_violent ?? 0) * CRIME_CLASS_WEIGHTS.violent +
    (p.crime_property ?? 0) * CRIME_CLASS_WEIGHTS.property +
    (p.crime_disorder ?? 0) * CRIME_CLASS_WEIGHTS.disorder;
  const ambientOf = (f) =>
    Math.max(f.properties.aantalInwoners, 0) + (poiCount.get(f.properties.buurtcode) || 0) * POI_AMBIENT_WEIGHT;

  const totalCrimes = usableCrime.reduce((s, f) => s + weighted(f.properties), 0);
  const totalPop = usableCrime.reduce((s, f) => s + ambientOf(f), 0);
  const regionRate = totalPop > 0 ? totalCrimes / totalPop : 0;

  const crimeRateByBuurt = new Map();
  for (const f of usableCrime) {
    const c = weighted(f.properties);
    const pop = ambientOf(f);
    const rate = (c + SHRINKAGE_K * regionRate) / (pop + SHRINKAGE_K);
    crimeRateByBuurt.set(f.properties.buurtnaam, rate * 1000); // /1000 kişi, okunabilir ölçek
  }

  // Segmentleri mahalleye göre grupla, bileşen ortalamalarını çıkar
  const byBuurt = new Map();
  for (const f of roads.features) {
    const buurt = f.properties.buurt;
    if (!buurt || !crimeRateByBuurt.has(buurt)) continue;
    const b = f.properties.safety_breakdown_midday;
    if (!b) continue;
    if (!byBuurt.has(buurt)) byBuurt.set(buurt, { lighting: [], pedInfra: [], frontage: [], roadType: [] });
    const g = byBuurt.get(buurt);
    g.lighting.push(b.lighting);
    g.pedInfra.push(b.pedInfra);
    g.frontage.push(b.frontage);
    g.roadType.push(b.roadType);
  }

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const rows = [];
  for (const [buurt, g] of byBuurt) {
    if (g.lighting.length < 5) continue; // çok az segmentli mahalleyi at (gürültü)
    rows.push({
      buurt,
      lighting: mean(g.lighting),
      pedInfra: mean(g.pedInfra),
      frontage: mean(g.frontage),
      roadType: mean(g.roadType),
      crimeRate: crimeRateByBuurt.get(buurt),
      n: g.lighting.length,
    });
  }

  console.log(`Regresyon örneklemi: ${rows.length} mahalle (min. 5 segmentli)\n`);

  // Özellikleri standartlaştır (z-score) — katsayılar karşılaştırılabilir olsun
  const features = ["lighting", "pedInfra", "frontage", "roadType"];
  const stats = {};
  for (const feat of features) {
    const vals = rows.map((r) => r[feat]);
    const m = mean(vals);
    const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2))) || 1;
    stats[feat] = { m, sd };
  }

  const X = rows.map((r) => [1, ...features.map((f) => (r[f] - stats[f].m) / stats[f].sd)]);
  const y = rows.map((r) => r.crimeRate);

  const { beta, r2 } = olsRegression(X, y);

  console.log("=".repeat(64));
  console.log("REGRESYON SONUCU: bileşen ortalaması -> suç oranı (/1000 kişi)");
  console.log("=".repeat(64));
  console.log(`R² = ${r2.toFixed(3)}  (modelin açıkladığı varyans oranı)\n`);
  console.log("Bileşen         | Katsayı  | Yön (beklenen: negatif = koruyucu)");
  console.log("-".repeat(64));
  features.forEach((feat, i) => {
    const coef = beta[i + 1];
    const yon = coef < 0 ? "✓ koruyucu (teoriyle uyumlu)" : "✗ BEKLENMEDİK (artırıcı çıktı)";
    console.log(`${feat.padEnd(16)} | ${coef.toFixed(2).padStart(7)}  | ${yon}`);
  });

  // Negatif (koruyucu) katsayıların mutlak değerinden normalize edilmiş ağırlık öner
  console.log("\n" + "=".repeat(64));
  console.log("ÖNERİLEN AĞIRLIKLAR (yalnızca koruyucu çıkan bileşenlerden)");
  console.log("=".repeat(64));
  const protective = features
    .map((f, i) => ({ f, coef: beta[i + 1] }))
    .filter((x) => x.coef < 0);
  const totalAbs = protective.reduce((s, x) => s + Math.abs(x.coef), 0);
  const CURRENT_WEIGHTS = { lighting: 0.35, pedInfra: 0.2, frontage: 0.2, roadType: 0.25 };
  for (const { f, coef } of protective) {
    const suggested = Math.abs(coef) / totalAbs;
    console.log(
      `  ${f.padEnd(16)} mevcut: ${CURRENT_WEIGHTS[f].toFixed(2)}  |  veri-önerisi: ${suggested.toFixed(2)}`
    );
  }
  const nonProtective = features.filter((f) => !protective.find((p) => p.f === f));
  if (nonProtective.length) {
    console.log(
      `\n  UYARI: ${nonProtective.join(", ")} veride suçla beklenen (negatif) ilişkiyi göstermedi.`
    );
    console.log("  Bu, o bileşenin gerçek suçla değil sezgiyle ağırlıklandırıldığını gösterir;");
    console.log("  tez metodoloji bölümünde dürüstçe tartışılmalı.");
  }

  console.log("\nNOT: R² düşükse (örn. <0.3) örneklem küçüktür (~onlarca mahalle) ve tek");
  console.log("bir ayın suç verisi gürültülüdür — bu bir ön-kalibrasyon denemesidir, ağırlıkları");
  console.log("doğrudan değiştirmeden önce çok-aylık veriyle ve daha büyük örneklemle");
  console.log("(ör. tüm Hollanda mahalleleri) doğrulanması önerilir.");
}

main();
