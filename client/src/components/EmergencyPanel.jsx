import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

const PING_INTERVAL_MS = 8000;

export default function EmergencyPanel({ onClose }) {
  const [sessionId, setSessionId] = useState(null);
  const [shareUrl, setShareUrl] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const watchIdRef = useRef(null);
  const pingIntervalRef = useRef(null);

  const stop = async () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    if (pingIntervalRef.current != null) clearInterval(pingIntervalRef.current);
    watchIdRef.current = null;
    pingIntervalRef.current = null;
    if (sessionId) {
      try {
        await api.emergencyStop(sessionId);
      } catch {
        /* oturum zaten süresi dolmuş olabilir, önemli değil */
      }
    }
    setSessionId(null);
    setShareUrl(null);
  };

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!navigator.geolocation) {
      setError("Bu cihazda konum servisi yok.");
      return;
    }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        try {
          const { id } = await api.emergencyStart({ lat, lng, label: "SafeRoute canlı konum" });
          setSessionId(id);
          const url = `${window.location.origin}${window.location.pathname}?track=${id}`;
          setShareUrl(url);

          watchIdRef.current = navigator.geolocation.watchPosition(
            () => {},
            () => {},
            { enableHighAccuracy: true, maximumAge: 5000 }
          );
          pingIntervalRef.current = setInterval(() => {
            navigator.geolocation.getCurrentPosition(
              (p) => api.emergencyPing(id, p.coords.latitude, p.coords.longitude).catch(() => {}),
              () => {},
              { enableHighAccuracy: true, maximumAge: 5000 }
            );
          }, PING_INTERVAL_MS);
        } catch (err) {
          setError("Oturum başlatılamadı: " + err.message);
        }
      },
      (err) => setError("Konum alınamadı: " + err.message),
      { enableHighAccuracy: true }
    );
  };

  const doShare = async () => {
    if (!shareUrl) return;
    const text = "Canlı konumumu görüntüle (SafeRoute):";
    if (navigator.share) {
      try {
        await navigator.share({ title: "Canlı konum", text, url: shareUrl });
        return;
      } catch {
        /* kullanıcı paylaşımı iptal etti, kopyalamaya düş */
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard API yoksa sessizce geç, link zaten ekranda görünür */
    }
  };

  return (
    <section className="emergency-panel" aria-label="Acil durum">
      <div className="emergency-head">
        <span>🆘 Acil Durum</span>
        <button onClick={onClose} aria-label="Kapat">
          ×
        </button>
      </div>

      <a className="emergency-call" href="tel:112">
        📞 112&apos;yi Ara
      </a>

      {!sessionId ? (
        <button className="emergency-share-start" onClick={start}>
          📍 Canlı Konumumu Paylaş
        </button>
      ) : (
        <div className="emergency-live">
          <div className="emergency-live-status">
            <span className="live-dot" aria-hidden="true" /> Canlı konum paylaşımı aktif
          </div>
          <div className="emergency-link">{shareUrl}</div>
          <div className="emergency-actions">
            <button className="btn-primary" onClick={doShare}>
              {copied ? "Kopyalandı ✓" : "Paylaş / Kopyala"}
            </button>
            <button className="btn-ghost" onClick={stop}>
              Durdur
            </button>
          </div>
        </div>
      )}

      {error && <div className="status error">{error}</div>}

      <p className="emergency-disclaimer">
        Paylaştığın bağlantıyı açan herkes konumunu 6 saat boyunca (ya da sen durdurana kadar) canlı
        görebilir. Sadece güvendiğin kişilerle paylaş.
      </p>
    </section>
  );
}
