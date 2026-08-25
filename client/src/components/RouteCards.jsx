import { scoreColor, scoreName } from "../lib/constants";

function Card({ id, title, dotClass, route, selected, onSelect }) {
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
        <span className="route-card-time">{route.durationMin} dk</span>
      </div>
      <div className="route-card-meta">{route.distanceKm} km</div>
      <div className="route-card-scores">
        <span className="score-chip" style={{ borderColor: scoreColor(route.avgSafetyScore) }}>
          <b style={{ color: scoreColor(route.avgSafetyScore) }}>{route.avgSafetyScore ?? "-"}</b> ortalama
        </span>
        <span className="score-chip" style={{ borderColor: scoreColor(route.minSafetyScore) }}>
          <b style={{ color: scoreColor(route.minSafetyScore) }}>{route.minSafetyScore ?? "-"}</b> en düşük
        </span>
      </div>
    </button>
  );
}

export default function RouteCards({ result, selectedRoute, onSelect }) {
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
          title="En Hızlı"
          dotClass="dot-fast"
          route={fast}
          selected={selectedRoute === "fast"}
          onSelect={onSelect}
        />
        <Card
          id="safe"
          title="En Güvenli"
          dotClass="dot-safe"
          route={safe}
          selected={selectedRoute === "safe"}
          onSelect={onSelect}
        />
      </div>

      {gain > 0 || minGain > 0 ? (
        <div className="diff-note">
          {detourPct > 0 ? `%${detourPct} daha uzun` : "Aynı mesafede"}, ama güvenlik skoru{" "}
          <b>{gain > 0 ? `+${gain}` : gain}</b> puan
          {minGain > 0 ? ` ve en zayıf noktası +${minGain} puan` : ""} daha yüksek.
        </div>
      ) : (
        <div className="diff-note neutral">
          Bu iki nokta arasında daha güvenli bir alternatif bulunamadı — tek makul yol bu.
        </div>
      )}

      <div className="verdict">
        Seçili rota: <b style={{ color: scoreColor(result[selectedRoute].avgSafetyScore) }}>
          {scoreName(result[selectedRoute].avgSafetyScore)}
        </b>
      </div>
    </>
  );
}
