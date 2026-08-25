import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./lib/api";
import "./App.css";

const meIcon = L.divIcon({
  className: "",
  html: '<div class="pin pin-me"><div class="pin-me-pulse"></div></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const POLL_MS = 6000;

// Leaflet, kabı henüz tam boyuta ulaşmadan başlatılırsa harita küçük bir alana
// sıkışır; düzen tam otursun diye boyutu bir kez yeniden hesaplatıyoruz.
function FixSize() {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 150);
    return () => clearTimeout(id);
  }, [map]);
  return null;
}

export default function TrackViewer({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .emergencyGet(id)
        .then((d) => alive && setData(d))
        .catch((err) => alive && setError(err.message));
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (error) {
    return (
      <div className="track-viewer track-error">
        <h1>SafeRoute — Canlı Konum</h1>
        <p>{error}</p>
        <p className="track-hint">Bağlantının süresi dolmuş ya da paylaşım durdurulmuş olabilir.</p>
      </div>
    );
  }

  if (!data || data.lat == null) {
    return (
      <div className="track-viewer track-loading">
        <span className="spinner" aria-hidden="true" />
        Konum bekleniyor…
      </div>
    );
  }

  return (
    <div className="track-viewer">
      <header className="track-banner">
        <div>
          <b>{data.label || "Canlı konum"}</b>
          <span className={`track-status ${data.active ? "live" : "stopped"}`}>
            {data.active ? "● Canlı" : "○ Paylaşım durduruldu"}
          </span>
        </div>
        <div className="track-age">
          Son güncelleme: {data.ageSeconds < 60 ? `${data.ageSeconds} sn önce` : `${Math.round(data.ageSeconds / 60)} dk önce`}
        </div>
      </header>
      <MapContainer key={`${data.lat},${data.lng}`} center={[data.lat, data.lng]} zoom={16} className="map">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[data.lat, data.lng]} icon={meIcon} />
        <FixSize />
      </MapContainer>
    </div>
  );
}
