import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  DEFAULT_CENTER,
  REPORT_TYPE_ICONS,
  formatDistance,
  reportTypeLabels,
  scoreColor,
  toLatLngs,
} from "../lib/constants";
import { useLanguage } from "../lib/i18n";

const makeIcon = (html, size = 18) =>
  L.divIcon({ className: "", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

const startIcon = makeIcon('<div class="pin pin-start"></div>');
const endIcon = makeIcon('<div class="pin pin-end"></div>');
const meIcon = makeIcon('<div class="pin pin-me"><div class="pin-me-pulse"></div></div>');

function havenIcon(isOpen) {
  return makeIcon(
    `<div class="marker-emoji ${isOpen ? "" : "marker-dim"}">${isOpen ? "🛟" : "🔒"}</div>`,
    24
  );
}

const nearbyIconCache = new Map();
function nearbyIcon(emoji) {
  if (!nearbyIconCache.has(emoji)) {
    nearbyIconCache.set(emoji, makeIcon(`<div class="marker-emoji">${emoji}</div>`, 22));
  }
  return nearbyIconCache.get(emoji);
}

function reportIcon(type, trust) {
  const emoji = REPORT_TYPE_ICONS[type] || "⚠️";
  const dim = trust != null && trust < 40 ? "marker-dim" : "";
  return makeIcon(`<div class="marker-emoji ${dim}">${emoji}</div>`, 24);
}

// Isı haritası: ~27k segmenti tek tek Polyline yapmak tarayıcıyı kilitler. Backend
// zaten 5 skor bandına gruplayıp gönderiyor; her bant TEK bir çoklu-çizgi Polyline
// olarak (canvas renderer ile) çiziliyor — toplam 5 çizim nesnesi.
const heatmapRenderer = typeof L !== "undefined" ? L.canvas({ padding: 0.5 }) : undefined;

function HeatmapLayer({ bands }) {
  if (!bands) return null;
  return (
    <>
      {bands.map((b) => (
        <Polyline
          key={b.label}
          positions={b.lines.map(toLatLngs)}
          pathOptions={{ color: b.color, weight: 2.5, opacity: 0.75 }}
          renderer={heatmapRenderer}
        />
      ))}
    </>
  );
}

function ClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function FlyTo({ center, trigger }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.flyTo(center, Math.max(map.getZoom(), 14));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  return null;
}

function FitRoute({ coords, trigger }) {
  const map = useMap();
  useEffect(() => {
    if (!coords?.length) return;
    map.fitBounds(toLatLngs(coords), { padding: [40, 40], maxZoom: 17 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  return null;
}

function MapFollower({ position, active }) {
  const map = useMap();
  useEffect(() => {
    if (active && position) map.panTo([position.lat, position.lng], { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, active]);
  return null;
}

// Harita kabı, panel açılıp kapandığında yeniden ölçülmeli (mobil bottom sheet)
function ResizeOnLayoutChange({ trigger }) {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 260);
    return () => clearTimeout(id);
  }, [trigger, map]);
  return null;
}

export default function RouteMap({
  start,
  end,
  result,
  activeRoute,
  selectedRoute,
  onSelectRoute,
  onMapClick,
  onSegmentClick,
  userPos,
  approxPos,
  navActive,
  regionCenter,
  flyTrigger,
  fitTrigger,
  layoutTrigger,
  havens,
  showHavens,
  nearbyPlaces,
  showNearby,
  reports,
  onConfirmReport,
  heatmapBands,
}) {
  const { lang, t } = useLanguage();
  const REPORT_TYPE_LABELS = reportTypeLabels(lang);
  return (
    <MapContainer center={DEFAULT_CENTER} zoom={14} className="map" zoomControl={true}>
      <TileLayer
        attribution={
          lang === "en"
            ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, business data partly &copy; <a href="https://overturemaps.org">Overture Maps Foundation</a> and <a href="https://opensource.foursquare.com/os-places/">Foursquare OS Places</a>'
            : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, işletme verisi kısmen &copy; <a href="https://overturemaps.org">Overture Maps Foundation</a> ve <a href="https://opensource.foursquare.com/os-places/">Foursquare OS Places</a>'
        }
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onPick={onMapClick} />
      <FlyTo center={regionCenter} trigger={flyTrigger} />
      <FitRoute coords={activeRoute?.route?.geometry?.coordinates} trigger={fitTrigger} />
      <MapFollower position={userPos} active={navActive} />
      <ResizeOnLayoutChange trigger={layoutTrigger} />

      <HeatmapLayer bands={heatmapBands} />

      {start && <Marker position={[start.lat, start.lng]} icon={startIcon} />}
      {end && <Marker position={[end.lat, end.lng]} icon={endIcon} />}
      {/* Navigasyon sırasında yüksek hassasiyetli userPos (watchPosition), aksi
          halde genel canlı konum (approxPos) — "ben buradayım" işareti artık
          sadece navigasyon sırasında değil, her zaman gösteriliyor. */}
      {navActive && userPos ? (
        <Marker position={[userPos.lat, userPos.lng]} icon={meIcon} />
      ) : (
        approxPos && <Marker position={[approxPos.lat, approxPos.lng]} icon={meIcon} />
      )}

      {/* Seçilmeyen alternatif rota, soluk gösterilir */}
      {result &&
        !navActive &&
        ["fast", "safe"]
          .filter((key) => key !== selectedRoute)
          .map((key) => (
            <Polyline
              key={key}
              positions={toLatLngs(result[key].route.geometry.coordinates)}
              pathOptions={{ color: "#64748b", weight: 4, opacity: 0.45, dashArray: "4 8" }}
              eventHandlers={{
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  onSelectRoute(key);
                },
              }}
            />
          ))}

      {/* Seçili rota güvenlik skoruna göre parça parça renklendirilir */}
      {activeRoute?.segments?.map((seg, i) => (
        <Polyline
          key={`${selectedRoute}-${i}`}
          positions={toLatLngs(seg.coordinates)}
          pathOptions={{ color: scoreColor(seg.score), weight: 8, opacity: 0.95, lineCap: "round" }}
          eventHandlers={{
            click: (e) => {
              L.DomEvent.stopPropagation(e);
              onSegmentClick(seg);
            },
          }}
        />
      ))}

      {showHavens &&
        havens.map((h, i) => (
          <Marker key={i} position={[h.lat, h.lng]} icon={havenIcon(h.isOpen)}>
            <Popup>
              <b>{h.name}</b>
              <br />
              {h.typeLabel} · {formatDistance(h.distanceM)}
              <br />
              <span style={{ color: h.isOpen ? "#16a34a" : "#dc2626" }}>
                {h.alwaysOpen ? t("havens.open247") : h.isOpen ? t("havens.openNow") : t("havens.closedNow")}
              </span>
            </Popup>
          </Marker>
        ))}

      {showNearby &&
        nearbyPlaces.map((p, i) => (
          <Marker key={i} position={[p.lat, p.lng]} icon={nearbyIcon(p.emoji)}>
            <Popup>
              <b>{p.name}</b>
              <br />
              {p.label} · {formatDistance(p.distanceM)}
            </Popup>
          </Marker>
        ))}

      {reports.map((r) => (
        <Marker key={r.id} position={[r.lat, r.lng]} icon={reportIcon(r.type, r.trust)}>
          <Popup>
            <b>{REPORT_TYPE_LABELS[r.type] || r.type}</b>
            {r.note ? (
              <>
                <br />
                {r.note}
              </>
            ) : null}
            <br />
            <span style={{ color: "#666" }}>
              {new Date(r.createdAt).toLocaleDateString(lang === "en" ? "en-GB" : "tr-TR")} ·{" "}
              {t("report.trustPercent", { trust: r.trust ?? 100 })}
              {r.confirmations ? ` · ${t("report.confirmationsCount", { n: r.confirmations })}` : ""}
            </span>
            <br />
            <button className="popup-btn" onClick={() => onConfirmReport(r.id)}>
              {t("report.confirmToo")}
            </button>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
