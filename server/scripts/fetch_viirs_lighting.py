#!/usr/bin/env python3
# NASA/NOAA VIIRS Gece Işığı (Nighttime Lights) uydu verisiyle yol segmentlerinin
# gerçek aydınlatma seviyesini ölçer. OSM'in `lit` etiketi (Türkiye'de çoğu yolda
# hiç yok) eksik olduğunda score-region.js şu ana kadar sadece "bu yol TİPİNİN
# ortalama aydınlatma oranı" gibi genel bir tahmine (litPrior) düşüyordu — aynı
# tahmin, o tipteki HER yola uygulanıyordu, konuma özgü değildi. VIIRS her segment
# için GERÇEK, o noktaya özgü bir ölçüm sağlıyor (~460m çözünürlük — sokak
# seviyesinde kesin değil ama "bu mahalle genel olarak aydınlık mı karanlık mı"
# sorusuna type-average'dan çok daha iyi bir cevap).
#
# Kullanım: python3 fetch_viirs_lighting.py <bölge-klasör-adı>
# Çıktı: data/<bölge>/roads.geojson'daki her feature'a properties.viirs_rad
# (nanoWatt/cm²/sr) eklenir; score-region.js bunu okuyup lightingScore'a katar.
import sys
import os
import json
import math
import ee

BATCH_SIZE = 3000  # tek reduceRegions çağrısında güvenli üst sınır


def main():
    region_dir = sys.argv[1]
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "..", "..", "data", region_dir)
    roads_path = os.path.join(data_dir, "roads.geojson")

    project = os.environ.get("EE_PROJECT", "saferoute-506618")
    ee.Initialize(project=project)

    with open(roads_path) as f:
        roads = json.load(f)

    # Son 6 ay medyanı: tek aylık kompozitler bulut/parazit içerebiliyor,
    # medyan bunu büyük ölçüde temizliyor (standart bir denoising yaklaşımı).
    coll = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG")
    recent = coll.sort("system:time_start", False).limit(6)
    composite = recent.select("avg_rad").median()

    def clean_pt(c):
        # Bazı koordinatlar 3 boyutlu (yükseklik dahil) ya da NaN/None içerebiliyor
        # — bu, tek bir bozuk nokta FeatureCollection'ın TAMAMINI "Invalid
        # geometry" hatasıyla çökertiyordu (Bornova/Buca/Eindhoven/Nuenen'de
        # oldu, küçük bölgelerde şans eseri olmadı). Sadece temiz [lng,lat]
        # çiftleri kabul ediliyor.
        try:
            lng, lat = float(c[0]), float(c[1])
        except (TypeError, ValueError, IndexError):
            return None
        if not (math.isfinite(lng) and math.isfinite(lat)):
            return None
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            return None
        return [lng, lat]

    def midpoint(coords):
        n = len(coords)
        if n == 2:
            a, b = clean_pt(coords[0]), clean_pt(coords[1])
            if a is None or b is None:
                return a or b
            return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        return clean_pt(coords[n // 2])

    features = roads["features"]
    midpoints = [midpoint(f["geometry"]["coordinates"]) for f in features]

    print(f"{len(features)} segment, VIIRS'ten örnekleniyor ({BATCH_SIZE}'lık gruplar halinde)...", file=sys.stderr)

    rad_values = [None] * len(features)
    for start in range(0, len(midpoints), BATCH_SIZE):
        batch = midpoints[start : start + BATCH_SIZE]
        fc = ee.FeatureCollection(
            [ee.Feature(ee.Geometry.Point(pt), {"idx": i}) for i, pt in enumerate(batch) if pt is not None]
        )
        sampled = composite.reduceRegions(collection=fc, reducer=ee.Reducer.first(), scale=463.83)
        result = sampled.getInfo()
        for feat in result["features"]:
            idx = feat["properties"]["idx"]
            rad = feat["properties"].get("first")
            rad_values[start + idx] = rad
        print(f"  {min(start + BATCH_SIZE, len(midpoints))}/{len(midpoints)}", file=sys.stderr)

    matched = sum(1 for r in rad_values if r is not None)
    print(f"  {matched}/{len(features)} segmente radyans değeri eklendi.", file=sys.stderr)

    for f, rad in zip(features, rad_values):
        if rad is not None:
            f["properties"]["viirs_rad"] = round(rad, 3)

    with open(roads_path, "w") as f:
        json.dump(roads, f)
    print(f"{roads_path} güncellendi.", file=sys.stderr)


if __name__ == "__main__":
    main()
