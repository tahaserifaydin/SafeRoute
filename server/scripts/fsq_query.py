#!/usr/bin/env python3
# Foursquare Open Source Places (Apache 2.0, açık lisans) - bkz.
# https://opensource.foursquare.com/os-places/ - bölgenin bbox'ı için sorgular,
# kategori bazlı gürültüyü (rezidans, tarla, fabrika vb.) eler, OSM etiket
# şemamıza çevirir ve GeoJSON olarak yazar. fetch-foursquare-places.js bunu
# çağırıp OSM+Overture ile birleştirir.
#
# Kullanım: HF_TOKEN=hf_... python3 fsq_query.py <minLng> <minLat> <maxLng> <maxLat> <output.geojson>
import sys
import os
import json
import duckdb

RELEASE = "2026-08-11"

# Bu kategorilerden HERHANGİ biri geçiyorsa kayıt tamamen atlanır (POI değil,
# arazi/bina/idari birim vb. - pedestrian arama/güvenlik için anlamsız).
EXCLUDE_SUBSTR = [
    "residential building", "housing development", "> road", "neighborhood",
    "moving target", "cemetery", "factory", "warehouse", "industrial estate",
    "business center", "coworking space", "> field", "> structure",
    "other great outdoors", "mountain", "> forest", "> farm", "postal code",
    "state", "county", "city", "island", "continent", "timezone",
]

EXACT_CONTAINS = [
    # (aranan alt-dize, {tag}) - liste sırası önemli, ilk eşleşen kazanır
    ("fast food", {"amenity": "fast_food"}),
    ("restaurant", {"amenity": "restaurant"}),
    ("turkish coffeehouse", {"amenity": "restaurant"}),
    ("food court", {"amenity": "fast_food"}),
    ("cafe", {"amenity": "cafe"}),
    ("coffee", {"amenity": "cafe"}),
    ("tea room", {"amenity": "cafe"}),
    ("bakery", {"shop": "bakery"}),
    ("dessert", {"shop": "pastry"}),
    ("ice cream", {"amenity": "ice_cream"}),
    # "bar"/"night club"/"brewery" KASITLI OLARAK eşlenmiyor: Foursquare'in bu
    # kategorisi bu veri setinde güvenilmez çıktı (Mustafakemalpaşa'da "Dining
    # and Drinking > Bar" diye etiketlenmiş 811 kayıttan çoğu yol adı/çiftlik/
    # tepe/boş metin gibi tamamen alakasızdı — ör. "Bandırma Eskişehir Yolu",
    # "kfkdkd"). Yanlış "bar" sayımı, skorlama sistemindeki gece hayatı
    # cezasını (NIGHTLIFE_PENALTY_WEIGHT) haksız yere şişiriyordu. Foursquare'de
    # bu kategori için güven skoru da yok, filtrelenemiyor — bu yüzden en
    # güvenli çözüm hiç eşlememek (yine de shop:"yes" ile ada göre aranabilir).
    # OSM'in kendi (topluluk tarafından doğrulanmış) bar/pub etiketleri etkilenmiyor.
    ("buffet", {"amenity": "restaurant"}),
    ("grocery store", {"shop": "grocery"}),
    ("convenience store", {"shop": "convenience"}),
    ("supermarket", {"shop": "supermarket"}),
    ("butcher", {"shop": "butcher"}),
    ("hair salon", {"shop": "hairdresser"}),
    ("barber", {"shop": "hairdresser"}),
    ("automotive repair", {"shop": "car_repair"}),
    ("tire", {"shop": "tyres"}),
    ("hardware store", {"shop": "hardware"}),
    ("furniture", {"shop": "furniture"}),
    ("electronics store", {"shop": "electronics"}),
    ("mobile phone", {"shop": "mobile_phone"}),
    ("clothing store", {"shop": "clothes"}),
    ("shoe store", {"shop": "shoes"}),
    ("jewelry", {"shop": "jewelry"}),
    ("bookstore", {"shop": "books"}),
    ("stationery", {"shop": "stationery"}),
    ("florist", {"shop": "florist"}),
    ("pet ", {"shop": "pet"}),
    ("pharmacy", {"amenity": "pharmacy"}),
    ("hospital", {"amenity": "hospital"}),
    ("dentist", {"amenity": "dentist"}),
    ("veterinar", {"amenity": "veterinary"}),
    ("medical center", {"amenity": "clinic"}),
    ("mosque", {"amenity": "place_of_worship"}),
    ("elementary school", {"amenity": "school"}),
    ("high school", {"amenity": "school"}),
    ("middle school", {"amenity": "school"}),
    ("preschool", {"amenity": "kindergarten"}),
    ("kindergarten", {"amenity": "kindergarten"}),
    ("college and university", {"amenity": "university"}),
    ("bank", {"amenity": "bank"}),
    ("atm", {"amenity": "bank"}),
    ("post office", {"amenity": "post_office"}),
    ("town hall", {"amenity": "townhall"}),
    ("government building", {"amenity": "townhall"}),
    ("police", {"amenity": "police"}),
    ("fire station", {"amenity": "fire_station"}),
    ("library", {"amenity": "library"}),
    ("community center", {"amenity": "community_centre"}),
    ("cultural center", {"amenity": "community_centre"}),
    ("bus stop", {"amenity": "bus_station"}),
    ("bus station", {"amenity": "bus_station"}),
    ("fuel station", {"amenity": "fuel"}),
    ("gas station", {"amenity": "fuel"}),
    ("taxi", {"amenity": "taxi"}),
    ("rental car", {"amenity": "car_rental"}),
    ("cinema", {"amenity": "cinema"}),
    ("movie theater", {"amenity": "cinema"}),
    ("theater", {"amenity": "theatre"}),
    ("museum", {"tourism": "museum"}),
    ("art gallery", {"tourism": "gallery"}),
    ("zoo", {"tourism": "zoo"}),
    ("aquarium", {"tourism": "aquarium"}),
    ("scenic lookout", {"tourism": "viewpoint"}),
    ("hotel", {"tourism": "hotel"}),
    ("hostel", {"tourism": "guest_house"}),
    ("bed and breakfast", {"tourism": "guest_house"}),
    ("park", {"leisure": "park"}),
    ("garden", {"leisure": "park"}),
    ("playground", {"leisure": "playground"}),
    ("gym", {"leisure": "fitness_centre"}),
    ("fitness center", {"leisure": "fitness_centre"}),
    ("swimming pool", {"leisure": "swimming_pool"}),
    ("stadium", {"leisure": "stadium"}),
    ("plaza", {"tourism": "attraction"}),
]


def map_category(labels):
    try:
        if labels is None or len(labels) == 0:
            return {"shop": "yes"}
    except TypeError:
        return {"shop": "yes"}
    c = (labels[0] or "").lower()
    for excl in EXCLUDE_SUBSTR:
        if excl in c:
            return None
    for needle, tag in EXACT_CONTAINS:
        if needle in c:
            return tag
    return {"shop": "yes"}


def main():
    min_lng, min_lat, max_lng, max_lat, out_path = sys.argv[1:6]
    token = os.environ["HF_TOKEN"]

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(
        "CREATE SECRET (TYPE http, EXTRA_HTTP_HEADERS MAP {'Authorization': ?});",
        [f"Bearer {token}"],
    )
    urls = [
        f"https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/main/"
        f"release/dt={RELEASE}/places/parquet/places_{i:06d}.parquet"
        for i in range(100)
    ]
    url_list = ", ".join(f"'{u}'" for u in urls)
    # NOT: country='TR' filtresi kasıtlı olarak YOK — bu script Türkiye
    # dışındaki bölgeler (Eindhoven, Nuenen) için de kullanılıyor; bbox zaten
    # doğru ülkeyi kendiliğinden seçiyor.
    q = f"""
        SELECT fsq_place_id, name, latitude, longitude, fsq_category_labels, date_closed
        FROM read_parquet([{url_list}])
        WHERE date_closed IS NULL
          AND longitude BETWEEN {min_lng} AND {max_lng}
          AND latitude BETWEEN {min_lat} AND {max_lat}
    """
    df = con.execute(q).fetchdf()

    features = []
    for _, row in df.iterrows():
        name = row["name"]
        if not name or not isinstance(name, str):
            continue
        tags = map_category(row["fsq_category_labels"])
        if tags is None:
            continue
        props = dict(tags)
        props["name"] = name
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
                "properties": props,
            }
        )

    with open(out_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"{len(df)} ham kayıt -> {len(features)} filtrelenmiş POI -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
