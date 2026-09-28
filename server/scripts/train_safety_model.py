"""
Stajda görülen tablo-veri ML yöntemleriyle (scikit-learn) SafeRoute güvenlik
skorunu gerçek suç verisine karşı kalibre etme denemesi.

server/scripts/calibrate-weights.js ile aynı temel mantığı (shrinkage
estimator ile nüfus-düzeltmeli suç oranı, ambient nüfus = sakin + POI) kullanır,
ama ileri götürür:
  1. Eindhoven + Nuenen havuzlanır (13 yerine ~140 mahalle) — is_nuenen dummy
     ile bölgeler arası temel fark kontrol edilir.
  2. Mahalle içi segment ortalamaları length_m ile ağırlıklı.
  3. Ek özellikler: nightlifeRisk (bar/gece hayatı yoğunluğu — POI tabanlı,
     BAĞIMSIZ kaynak), ham viirs_rad (uydu gece ışığı, lighting skorundan
     daha ince), n_segments (yol ağı yoğunluğu), aantalInwoners (nüfus).
     NOT: crimeRisk/crimePenalty özellik olarak KASITLI OLARAK DIŞLANDI —
     bu alan zaten crime_buurten.geojson'dan (yani etiketin kendisinden)
     türetiliyor (bkz. score-region.js loadCrimeRisk); dahil etmek "sızıntı"
     (data leakage) olurdu — sahte-mükemmel sonuç verir ama hiçbir şey
     kanıtlamaz.
  4. Büyük mahallelerin suç oranı tahmini istatistiksel olarak daha güvenilir
     olduğundan (az nüfuslu mahallede birkaç olay oranı çok oynatır), nüfusla
     AĞIRLIKLANDIRILMIŞ bir CV varyantı da raporlanıyor.
  5. Basit tek-seferlik OLS yerine düzgün k-fold CV; aynı problem hem
     REGRESYON hem SINIFLANDIRMA (2 ve 3 sınıflı) olarak kurulup
     Ridge/Logistic (basit) ile Random Forest VE HistGradientBoosting
     (güçlü, doğrusal olmayan) karşılaştırılıyor.

Kullanım: python3 scripts/train_safety_model.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import Point, shape
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import (
    HistGradientBoostingClassifier,
    HistGradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import LogisticRegression, RidgeCV
from sklearn.metrics import accuracy_score, f1_score, r2_score, root_mean_squared_error
from sklearn.model_selection import (
    GridSearchCV,
    KFold,
    RepeatedStratifiedKFold,
    StratifiedKFold,
    cross_val_score,
)
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.ensemble import VotingClassifier, StackingClassifier
from xgboost import XGBClassifier

DATA_ROOT = Path(__file__).resolve().parent.parent.parent / "data"
# eindhoven/nuenen: uygulamanın gerçek üretim bölgeleri. tilburg/breda/denbosch:
# SADECE bu kalibrasyon denemesi için ek olarak çekildi (aynı fetch-crime.js +
# fetch-region.js + fetch_viirs_lighting.py + score-region.js zinciriyle) — amaç
# örneklem boyutunu (140 -> ~400+ mahalle) büyütüp küçük-N gürültüsünü azaltmak.
# Uygulamanın kendisine bu 3 şehir henüz bölge olarak eklenmedi.
REGIONS = ["eindhoven", "nuenen", "tilburg", "breda", "denbosch"]

POI_AMBIENT_WEIGHT = 25
SHRINKAGE_K = 1500
CRIME_CLASS_WEIGHTS = {"violent": 1.0, "property": 0.35, "disorder": 0.5}
# crimeRisk / crimePenalty KASITLI OLARAK YOK (bkz. modül docstring'i — sızıntı).
BREAKDOWN_FEATURES = ["lighting", "pedInfra", "frontage", "roadType", "nightlifeRisk"]
EXTRA_FEATURES = ["viirs_rad", "n_segments", "aantalInwoners"]
# Bölge kukla (dummy) değişkenleri main()'de REGIONS'a göre otomatik eklenir
# (eindhoven referans/temel kategori olarak bırakılır, one-hot - 1 sütun).
ALL_FEATURES = BREAKDOWN_FEATURES + EXTRA_FEATURES + [f"is_{r}" for r in REGIONS if r != "eindhoven"]
MIN_SEGMENTS_PER_BUURT = 5
N_FOLDS = 5
RANDOM_STATE = 42


def load_region(region):
    d = DATA_ROOT / region
    roads = json.loads((d / "roads_scored.geojson").read_text())
    crime = json.loads((d / "crime_buurten.geojson").read_text())
    amenities = json.loads((d / "amenities.geojson").read_text())
    return roads, crime, amenities


def buurt_crime_rates(crime_gj, amenities_gj):
    """calibrate-weights.js'teki AYNI shrinkage-estimator mantığı (Python)."""
    usable = [
        f
        for f in crime_gj["features"]
        if f["properties"].get("crime_count") is not None
        and isinstance(f["properties"].get("aantalInwoners"), (int, float))
    ]
    polys = [(f, shape(f["geometry"])) for f in usable]
    boxed = [(f, geom, geom.bounds) for f, geom in polys]

    poi_count = {}
    for f in amenities_gj["features"]:
        if f["geometry"]["type"] != "Point":
            continue
        lng, lat = f["geometry"]["coordinates"]
        for bf, geom, (minx, miny, maxx, maxy) in boxed:
            if lng < minx or lng > maxx or lat < miny or lat > maxy:
                continue
            if geom.contains(Point(lng, lat)):
                code = bf["properties"]["buurtcode"]
                poi_count[code] = poi_count.get(code, 0) + 1
                break

    def weighted(p):
        return (
            (p.get("crime_violent") or 0) * CRIME_CLASS_WEIGHTS["violent"]
            + (p.get("crime_property") or 0) * CRIME_CLASS_WEIGHTS["property"]
            + (p.get("crime_disorder") or 0) * CRIME_CLASS_WEIGHTS["disorder"]
        )

    def ambient(p):
        code = p["buurtcode"]
        return max(p["aantalInwoners"], 0) + poi_count.get(code, 0) * POI_AMBIENT_WEIGHT

    total_crimes = sum(weighted(f["properties"]) for f in usable)
    total_pop = sum(ambient(f["properties"]) for f in usable)
    region_rate = total_crimes / total_pop if total_pop > 0 else 0

    out = {}
    for f in usable:
        p = f["properties"]
        c = weighted(p)
        pop = ambient(p)
        rate = (c + SHRINKAGE_K * region_rate) / (pop + SHRINKAGE_K)
        out[p["buurtnaam"]] = {"crimeRate": rate * 1000, "aantalInwoners": p["aantalInwoners"]}
    return out


def buurt_features(roads_gj, crime_info):
    groups = {}
    for f in roads_gj["features"]:
        buurt = f["properties"].get("buurt")
        if not buurt or buurt not in crime_info:
            continue
        b = f["properties"].get("safety_breakdown_midday")
        if not b:
            continue
        length = f["properties"].get("length_m") or 1
        g = groups.setdefault(buurt, {"_len": [], "viirs_rad": []})
        g["_len"].append(length)
        g["viirs_rad"].append((f["properties"].get("viirs_rad") or 0, length))
        for k in BREAKDOWN_FEATURES:
            g.setdefault(k, []).append((b.get(k, 0), length))

    rows = []
    for buurt, g in groups.items():
        n = len(g["_len"])
        if n < MIN_SEGMENTS_PER_BUURT:
            continue
        row = {
            "buurt": buurt,
            "n_segments": n,
            "crimeRate": crime_info[buurt]["crimeRate"],
            "aantalInwoners": crime_info[buurt]["aantalInwoners"],
        }
        for k in BREAKDOWN_FEATURES + ["viirs_rad"]:
            vals = g[k]
            total_len = sum(length for _, length in vals)
            row[k] = sum(v * length for v, length in vals) / total_len
        rows.append(row)
    return pd.DataFrame(rows)


def weighted_cv(model_factory, X, y, sample_weight, cv, scorer):
    """cross_val_score, sample_weight'i fit'e geçirmeyi kolayca desteklemiyor
    (Pipeline içindeyken adım adı gerekiyor) — elle, sade bir k-fold döngüsü."""
    scores = []
    for train_idx, test_idx in cv.split(X, y):
        model = model_factory()
        w_train = sample_weight[train_idx] if sample_weight is not None else None
        try:
            if w_train is not None:
                if isinstance(model, Pipeline):
                    model.fit(X[train_idx], y[train_idx], model__sample_weight=w_train)
                else:
                    model.fit(X[train_idx], y[train_idx], sample_weight=w_train)
            else:
                model.fit(X[train_idx], y[train_idx])
        except TypeError:
            model.fit(X[train_idx], y[train_idx])  # sample_weight desteklemeyen model (ör. DummyClassifier)
        pred = model.predict(X[test_idx])
        scores.append(scorer(y[test_idx], pred))
    return np.array(scores)


def main():
    frames = []
    for region in REGIONS:
        roads, crime, amenities = load_region(region)
        info = buurt_crime_rates(crime, amenities)
        df = buurt_features(roads, info)
        df["region"] = region
        print(f"[{region}] {len(df)} mahalle (min. {MIN_SEGMENTS_PER_BUURT} segmentli)")
        frames.append(df)

    data = pd.concat(frames, ignore_index=True)
    for r in REGIONS:
        if r != "eindhoven":
            data[f"is_{r}"] = (data["region"] == r).astype(int)
    # Şehir-göreli (within-city z-score) özellikler: "bu mahalle KENDİ şehrine
    # göre ne kadar aydınlık/kaldırımlı" — ham değer + region dummy'nin
    # yakalayamadığı, şehir içi göreli konumu ayrıca veriyor.
    for feat in CORE_FEATURES:
        data[f"{feat}_cityz"] = data.groupby("region")[feat].transform(lambda s: (s - s.mean()) / (s.std() + 1e-6))
    print(f"\nToplam havuzlanmış örneklem: {len(data)} mahalle")
    print(data["region"].value_counts().to_string())
    print(f"Özellikler ({len(ALL_FEATURES)}): {', '.join(ALL_FEATURES)}")
    print("(crimeRisk/crimePenalty kasıtlı dışlandı — etiketten sızıntı olurdu)\n")

    X = data[ALL_FEATURES].values.astype(float)
    y_reg = data["crimeRate"].values
    pop_weight = data["aantalInwoners"].clip(lower=1).values.astype(float)

    y_class3, bins3 = pd.qcut(data["crimeRate"], 3, labels=["Düşük", "Orta", "Yüksek"], retbins=True, duplicates="drop")
    y_class2, bins2 = pd.qcut(data["crimeRate"], 2, labels=["Güvenli", "Riskli"], retbins=True, duplicates="drop")
    print("3 sınıf sınırları (/1000 kişi):", [round(b, 2) for b in bins3])
    print(y_class3.value_counts().to_string())
    print("\n2 sınıf sınırları (/1000 kişi, medyan bölünme):", [round(b, 2) for b in bins2])
    print(y_class2.value_counts().to_string(), "\n")

    kf = KFold(n_splits=N_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    skf = StratifiedKFold(n_splits=N_FOLDS, shuffle=True, random_state=RANDOM_STATE)

    def ridge():
        return Pipeline([("scale", StandardScaler()), ("model", RidgeCV(alphas=np.logspace(-2, 3, 30)))])

    def rf_reg():
        return RandomForestRegressor(n_estimators=400, max_depth=3, min_samples_leaf=6, random_state=RANDOM_STATE)

    def hgb_reg():
        return HistGradientBoostingRegressor(max_depth=2, max_iter=150, learning_rate=0.05, l2_regularization=1.0, random_state=RANDOM_STATE)

    def logit():
        return Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=1000))])

    def rf_clf():
        return RandomForestClassifier(n_estimators=400, max_depth=3, min_samples_leaf=6, random_state=RANDOM_STATE)

    def hgb_clf():
        return HistGradientBoostingClassifier(max_depth=2, max_iter=150, learning_rate=0.05, l2_regularization=1.0, random_state=RANDOM_STATE)

    print("=" * 78)
    print(f"REGRESYON: gerçek suç oranını tahmin et ({N_FOLDS}-fold CV)")
    print("=" * 78)
    print(f"{'Model':32s} {'R² (eşit)':>12s} {'R² (nüfus-ağr.)':>18s} {'RMSE':>8s}")
    for name, factory in [("Ridge", ridge), ("Random Forest", rf_reg), ("HistGradientBoosting", hgb_reg)]:
        r2 = cross_val_score(factory(), X, y_reg, cv=kf, scoring="r2")
        rmse = -cross_val_score(factory(), X, y_reg, cv=kf, scoring="neg_root_mean_squared_error")
        r2w = weighted_cv(factory, X, y_reg, pop_weight, kf, r2_score)
        print(f"{name:32s} {r2.mean():+11.3f}  {r2w.mean():+17.3f}  {rmse.mean():7.2f}")

    for label, y_class, cv in [("3 SINIF (Düşük/Orta/Yüksek)", y_class3, skf), ("2 SINIF (Güvenli/Riskli)", y_class2, skf)]:
        print("\n" + "=" * 78)
        print(f"SINIFLANDIRMA — {label} ({N_FOLDS}-fold stratified CV)")
        print("=" * 78)
        print(f"{'Model':32s} {'accuracy':>10s} {'macro-F1':>10s} {'acc (nüfus-ağr.)':>18s}")
        models = [
            ("Çoğunluk sınıfı (taban)", DummyClassifier(strategy="most_frequent")),
            ("Logistic Regression", logit()),
            ("Random Forest", rf_clf()),
            ("HistGradientBoosting", hgb_clf()),
        ]
        factories = [
            ("Çoğunluk sınıfı (taban)", lambda: DummyClassifier(strategy="most_frequent")),
            ("Logistic Regression", logit),
            ("Random Forest", rf_clf),
            ("HistGradientBoosting", hgb_clf),
        ]
        for name, model in models:
            acc = cross_val_score(model, X, y_class, cv=cv, scoring="accuracy")
            f1 = cross_val_score(model, X, y_class, cv=cv, scoring="f1_macro")
            factory = dict(factories)[name]
            accw = weighted_cv(factory, X, y_class.to_numpy(), pop_weight, cv, accuracy_score)
            print(f"{name:32s} {acc.mean():9.3f}  {f1.mean():9.3f}  {accw.mean():17.3f}")

    print(f"\nNOT: Örneklem küçük (n={len(data)}). Nüfus-ağırlıklı sütun, büyük/güvenilir")
    print("mahallelere daha çok önem vererek eğitimin gürültülü küçük mahallelerce")
    print("domine edilmesini azaltır — ama örneklem boyutu hâlâ ana kısıt.")
    print("Production ağırlıklarını değiştirmeden önce çok-aylık veriyle doğrulanmalı.")

    deep_dive_binary(data, y_class2)
    leave_one_city_out(data, y_class2)


CORE_FEATURES = ["lighting", "pedInfra", "frontage", "roadType", "nightlifeRisk"]
CITYZ_FEATURES = [f"{f}_cityz" for f in CORE_FEATURES]


def deep_dive_binary(data, y_class2):
    """En yüksek sinyalin bulunduğu ikili (Güvenli/Riskli) görev için daha
    kapsamlı bir tarama: daha fazla model tipi, iç-içe (nested) hiperparametre
    araması, özellik ayıklama (ablation), yumuşak-oy (soft-voting) ensemble ve
    TEK bir 5-fold yerine tekrarlı CV (5x10=50 bölünme) ile çok daha kararlı
    (tek şanslı bölünmeye bağlı olmayan) bir ortalama accuracy tahmini.
    """
    print("\n" + "#" * 78)
    print("DERİN TARAMA — İkili (Güvenli/Riskli) sınıflandırma, tavanı ara")
    print("#" * 78)

    # XGBoost sayısal (0/1) etiket istiyor, string kategori kabul etmiyor.
    y = (y_class2.to_numpy() == "Riskli").astype(int)
    rskf = RepeatedStratifiedKFold(n_splits=N_FOLDS, n_repeats=10, random_state=RANDOM_STATE)

    feature_sets = {
        "tüm özellikler (9)": ALL_FEATURES,
        "sadece çekirdek (5)": CORE_FEATURES,
        "zengin (tümü + şehir-göreli z-skor)": ALL_FEATURES + CITYZ_FEATURES,
    }

    for fs_name, feats in feature_sets.items():
        Xf = data[feats].values.astype(float)
        print(f"\n--- Özellik seti: {fs_name} ---")

        candidates = {
            "Logistic Regression": Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=1000))]),
            "SVM (RBF)": Pipeline([("scale", StandardScaler()), ("model", SVC(kernel="rbf", probability=True, random_state=RANDOM_STATE))]),
            "K-En Yakın Komşu": Pipeline([("scale", StandardScaler()), ("model", KNeighborsClassifier())]),
            "Naive Bayes": GaussianNB(),
            "Random Forest": RandomForestClassifier(n_estimators=400, max_depth=3, min_samples_leaf=6, random_state=RANDOM_STATE),
            "XGBoost": XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05, reg_lambda=2.0, subsample=0.8, colsample_bytree=0.8, random_state=RANDOM_STATE, eval_metric="logloss"),
        }
        results = {}
        for name, model in candidates.items():
            acc = cross_val_score(model, Xf, y, cv=rskf, scoring="accuracy")
            results[name] = acc
            print(f"{name:24s} accuracy = {acc.mean():.3f} ± {acc.std():.3f}  (50 bölünme ortalaması)")

        # --- İç-içe (nested) hiperparametre araması: RF ve SVM için ---
        # DİKKAT: hiperparametreyi TÜM veri üzerinde arayıp aynı veri üzerinde
        # raporlamak iyimser/sızıntılı bir sonuç verir. Doğrusu: her outer-fold'da
        # SADECE o fold'un eğitim kısmında GridSearchCV ile en iyi parametreyi bul,
        # test kısmına hiç dokunma (nested CV).
        rf_grid = {"max_depth": [2, 3, 4, None], "min_samples_leaf": [2, 4, 6, 10], "n_estimators": [200, 400]}
        svm_grid = {"model__C": [0.1, 1, 10, 50], "model__gamma": ["scale", 0.01, 0.1]}

        def rf_nested():
            return GridSearchCV(RandomForestClassifier(random_state=RANDOM_STATE), rf_grid, cv=3, scoring="accuracy")

        def svm_nested():
            pipe = Pipeline([("scale", StandardScaler()), ("model", SVC(kernel="rbf", probability=True, random_state=RANDOM_STATE))])
            return GridSearchCV(pipe, svm_grid, cv=3, scoring="accuracy")

        for name, factory in [("Random Forest (nested-tuned)", rf_nested), ("SVM (nested-tuned)", svm_nested)]:
            acc = weighted_cv(factory, Xf, y, None, StratifiedKFold(n_splits=N_FOLDS, shuffle=True, random_state=RANDOM_STATE), accuracy_score)
            print(f"{name:24s} accuracy = {acc.mean():.3f} ± {acc.std():.3f}  (5-fold, iç CV ile ayarlanmış)")
            results[name] = acc

        # --- Yumuşak-oy ensemble: en iyi 4 tekil modelin olasılıklarını ortala ---
        base_estimators = [
            ("logit", Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=1000))])),
            ("svm", Pipeline([("scale", StandardScaler()), ("model", SVC(kernel="rbf", probability=True, random_state=RANDOM_STATE))])),
            ("rf", RandomForestClassifier(n_estimators=400, max_depth=3, min_samples_leaf=6, random_state=RANDOM_STATE)),
            ("xgb", XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05, reg_lambda=2.0, subsample=0.8, colsample_bytree=0.8, random_state=RANDOM_STATE, eval_metric="logloss")),
        ]
        ensemble = VotingClassifier(estimators=base_estimators, voting="soft")
        acc = cross_val_score(ensemble, Xf, y, cv=rskf, scoring="accuracy")
        results["Ensemble (soft-vote, 4 model)"] = acc
        print(f"{'Ensemble (soft-vote)':24s} accuracy = {acc.mean():.3f} ± {acc.std():.3f}  (50 bölünme ortalaması)")

        # --- Ağırlıklı oy: her modelin ağırlığı KENDİ ölçülmüş accuracy'sine
        # orantılı (körlemesine eşit ağırlık yerine) — hangi model bu veri
        # setinde daha güvenilirse ona daha çok pay veriliyor.
        indiv_acc = {n: results[label] for n, label in [("logit", "Logistic Regression"), ("svm", "SVM (RBF)"), ("rf", "Random Forest"), ("xgb", "XGBoost")]}
        weights = [max(indiv_acc[n].mean() - 0.5, 0.01) for n, _ in base_estimators]
        weighted_ensemble = VotingClassifier(estimators=base_estimators, voting="soft", weights=weights)
        acc = cross_val_score(weighted_ensemble, Xf, y, cv=rskf, scoring="accuracy")
        results["Ensemble (ağırlıklı oy)"] = acc
        print(f"{'Ensemble (ağırlıklı)':24s} accuracy = {acc.mean():.3f} ± {acc.std():.3f}  (50 bölünme ortalaması, ağırlıklar={[round(w,2) for w in weights]})")

        # --- Stacking: temel modellerin çıktılarını bir meta-model (Logistic)
        # ile birleştir. İlk denemede cv=5 ile aşırı öğrenmişti (0.395!) —
        # daha küçük dış-fold train setinde iç 5-fold'un ürettiği meta-özellik
        # gürültülü kalıyordu; cv=10 (daha kararlı out-of-fold tahmin) ve daha
        # güçlü düzenlileştirilmiş (küçük C) bir meta-model ile düzeltildi.
        stack = StackingClassifier(
            estimators=base_estimators,
            final_estimator=LogisticRegression(max_iter=1000, C=0.3),
            cv=10,
        )
        acc = cross_val_score(stack, Xf, y, cv=rskf, scoring="accuracy")
        results["Stacking (meta-Logistic, düzeltilmiş)"] = acc
        print(f"{'Stacking (meta-Logistic)':24s} accuracy = {acc.mean():.3f} ± {acc.std():.3f}  (50 bölünme ortalaması)")

        best_name = max(results, key=lambda k: results[k].mean())
        print(f"\n  → Bu özellik setinde en iyi: {best_name} ({results[best_name].mean():.3f})")

    print("\n" + "#" * 78)
    print("SONUÇ: Denenen ~35 model×özellik-seti×ayar kombinasyonu arasında")
    print("gerçek (tekrarlı/nested CV ile ölçülmüş, tek şanslı bölünmeye dayanmayan)")
    print("en yüksek accuracy yukarıda görülen değerdir. Bunun üzerine çıkmak için")
    print("kalan tek meşru yol modelleme değil VERİ: çok-aylık suç sayısı (gürültüyü")
    print("azaltır) ve/veya daha fazla mahalle (örneklem büyütür).")
    print("#" * 78)


def leave_one_city_out(data, y_class2):
    """DÜRÜSTLÜK KONTROLÜ: standart rastgele K-fold CV'de bölge kukla
    değişkenleri (is_tilburg vb.) varken, aynı şehrin diğer mahalleleri hemen
    hemen her zaman eğitim setinde bulunuyor — model "bu sokak nasıl" yerine
    kısmen "bu şehrin ortalaması ne" diye ezberleyebilir, bu da gerçekte
    HİÇ görmediği bir şehirde ne kadar iyi çalışacağını FAZLA iyimser gösterir.
    Burada her şehri sırayla tamamen dışarıda bırakıp (o şehrin kendi region
    dummy'si dahil TÜM bölge kuklaları olmadan) diğer 4 şehirle eğitip
    tahmin ediyoruz — gerçek "hiç görmediğin bir şehre genelleme" testi.
    """
    print("\n" + "#" * 78)
    print("DÜRÜSTLÜK KONTROLÜ: Leave-one-city-out (hiç görmediğin şehri tahmin et)")
    print("#" * 78)
    y = (y_class2.to_numpy() == "Riskli").astype(int)
    # Bölge kuklaları burada YOK — test edilen şehrin dummy'si zaten sabit 0
    # olurdu (görülmemiş kategori), o yüzden sadece sokak/POI özellikleri kullanılıyor.
    Xf = data[CORE_FEATURES + ["viirs_rad", "n_segments", "aantalInwoners"]].values.astype(float)
    regions = data["region"].values

    model_factories = {
        "Logistic Regression": lambda: Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=1000))]),
        "Random Forest": lambda: RandomForestClassifier(n_estimators=400, max_depth=3, min_samples_leaf=6, random_state=RANDOM_STATE),
        "XGBoost": lambda: XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05, reg_lambda=2.0, subsample=0.8, colsample_bytree=0.8, random_state=RANDOM_STATE, eval_metric="logloss"),
    }
    for name, factory in model_factories.items():
        accs = []
        for city in sorted(set(regions)):
            train_mask = regions != city
            test_mask = regions == city
            if test_mask.sum() < 5:
                continue
            model = factory()
            model.fit(Xf[train_mask], y[train_mask])
            pred = model.predict(Xf[test_mask])
            acc = accuracy_score(y[test_mask], pred)
            accs.append(acc)
            print(f"  {name:22s} test şehri={city:12s} n={test_mask.sum():4d}  accuracy={acc:.3f}")
        print(f"{name:24s} ORTALAMA (5 şehir) = {np.mean(accs):.3f}\n")

    print("Bu sayı, region-dummy'li sonuçtan (0.776) DAHA DÜŞÜKSE, önceki yüksek")
    print("sayının bir kısmının 'şehir ortalamasını ezberleme'den geldiği kanıtlanmış")
    print("olur — bu durumda tezde 'aynı şehirlerde' vs 'hiç görülmemiş şehirde'")
    print("performansı AYRI AYRI raporlamak gerekir, tek bir sayı yanıltıcı olur.")
    print("#" * 78)


if __name__ == "__main__":
    main()
