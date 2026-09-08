import { scoreColor, scoreName } from "../lib/constants";
import { useLanguage } from "../lib/i18n";

// Rota boyunca bir kırılım alanının (aydınlatma, yaya altyapısı...) uzunluk
// ağırlıklı ortalaması — tek bir segmentin skoru değil, tüm rotanın genel
// karakterini gösterir (bkz. worker.js buildSegments: her segment kendi
// breakdown'ını taşıyor).
function avgBreakdownStat(route, key) {
  const scored = (route.segments || []).filter((s) => s.breakdown && s.breakdown[key] != null);
  if (!scored.length) return null;
  const totalLen = scored.reduce((sum, s) => sum + s.lengthKm, 0);
  if (!totalLen) return null;
  return Math.round(scored.reduce((sum, s) => sum + s.breakdown[key] * s.lengthKm, 0) / totalLen);
}

function Card({ id, title, dotClass, route, selected, onSelect, t }) {
  const lighting = avgBreakdownStat(route, "lighting");
  const pedInfra = avgBreakdownStat(route, "pedInfra");
  return (
    <button
      className={`route-card ${id} ${selected ? "selected" : ""}`}
      onClick={() => onSelect(id)}
      aria-pressed={selected}
    >
      <div className="route-card-head">
        <span className="route-card-title">
          <span className={`dot ${dotClass}`} aria-hidden="true" /> {title}
        </span>
        <span className="route-card-time">{t("route.minutes", { n: route.durationMin })}</span>
      </div>
      <div className="route-card-meta">{route.distanceKm} km</div>
      <div className="route-card-scores">
        <span className="score-chip" style={{ borderColor: scoreColor(route.avgSafetyScore) }}>
          <b style={{ color: scoreColor(route.avgSafetyScore) }}>{route.avgSafetyScore ?? "-"}</b> {t("route.average")}
        </span>
        <span className="score-chip" style={{ borderColor: scoreColor(route.minSafetyScore) }}>
          <b style={{ color: scoreColor(route.minSafetyScore) }}>{route.minSafetyScore ?? "-"}</b> {t("route.lowest")}
        </span>
      </div>
      {(lighting != null || pedInfra != null) && (
        <div className="route-card-breakdown">
          {lighting != null && <span>{t("route.lightPercent", { n: lighting })}</span>}
          {pedInfra != null && <span>{t("route.sidewalkPercent", { n: pedInfra })}</span>}
        </div>
      )}
    </button>
  );
}

export default function RouteCards({ result, selectedRoute, onSelect }) {
  const { lang, t } = useLanguage();
  const { fast, safe } = result;
  const detourPct = fast.distanceKm
    ? Math.round(((safe.distanceKm - fast.distanceKm) / fast.distanceKm) * 100)
    : 0;
  const gain = (safe.avgSafetyScore ?? 0) - (fast.avgSafetyScore ?? 0);
  const minGain = (safe.minSafetyScore ?? 0) - (fast.minSafetyScore ?? 0);

  return (
    <>
      <div className="results">
        <Card
          id="fast"
          title={t("route.fastest")}
          dotClass="dot-fast"
          route={fast}
          selected={selectedRoute === "fast"}
          onSelect={onSelect}
          t={t}
        />
        <Card
          id="safe"
          title={t("route.safest")}
          dotClass="dot-safe"
          route={safe}
          selected={selectedRoute === "safe"}
          onSelect={onSelect}
          t={t}
        />
      </div>

      {gain > 0 || minGain > 0 ? (
        <div className="diff-note">
          {t("route.saferBy", {
            detour: detourPct > 0 ? t("route.longerByPercent", { n: detourPct }) : t("route.sameDistance"),
            gain: gain > 0 ? `+${gain}` : gain,
            weakest: minGain > 0 ? t("route.weakestAlsoHigher", { n: minGain }) : "",
          })}
        </div>
      ) : (
        <div className="diff-note neutral">{t("route.noAlternative")}</div>
      )}

      <div className="verdict">
        {t("route.selectedLabel")}
        <b style={{ color: scoreColor(result[selectedRoute].avgSafetyScore) }}>
          {scoreName(result[selectedRoute].avgSafetyScore, lang)}
        </b>
      </div>
    </>
  );
}
