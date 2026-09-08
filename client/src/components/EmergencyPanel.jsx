import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useLanguage } from "../lib/i18n";

const PING_INTERVAL_MS = 8000;

export default function EmergencyPanel({ onClose }) {
  const { t } = useLanguage();
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
      setError(t("error.noGeoDevice"));
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
          setError(t("error.sessionStartFailed", { msg: err.message }));
        }
      },
      (err) => setError(t("error.locationFailed", { msg: err.message })),
      { enableHighAccuracy: true }
    );
  };

  const doShare = async () => {
    if (!shareUrl) return;
    const text = t("emergency.shareText");
    if (navigator.share) {
      try {
        await navigator.share({ title: t("emergency.shareTitle"), text, url: shareUrl });
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
        <span>{t("toolbar.emergency")}</span>
        <button onClick={onClose} aria-label={t("action.close")}>
          ×
        </button>
      </div>

      <a className="emergency-call" href="tel:112">
        {t("emergency.call112")}
      </a>

      {!sessionId ? (
        <button className="emergency-share-start" onClick={start}>
          {t("emergency.shareLocation")}
        </button>
      ) : (
        <div className="emergency-live">
          <div className="emergency-live-status">
            <span className="live-dot" aria-hidden="true" /> {t("emergency.liveActive")}
          </div>
          <div className="emergency-link">{shareUrl}</div>
          <div className="emergency-actions">
            <button className="btn-primary" onClick={doShare}>
              {copied ? t("action.copied") : t("action.shareOrCopy")}
            </button>
            <button className="btn-ghost" onClick={stop}>
              {t("action.stop")}
            </button>
          </div>
        </div>
      )}

      {error && <div className="status error">{error}</div>}

      <p className="emergency-disclaimer">{t("emergency.disclaimer")}</p>
    </section>
  );
}
