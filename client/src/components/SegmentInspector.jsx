import { BREAKDOWN_LABELS, SCORE_BANDS, scoreColor, scoreName } from "../lib/constants";

// Bir yol parçasının skorunun neden o olduğunu bileşen bileşen gösterir.
export default function SegmentInspector({ segment, onClose }) {
  if (!segment) return null;
  const b = segment.breakdown;

  return (
    <section className="inspect-box" aria-label="Segment detayı">
      <header className="inspect-head">
        <span>
          {segment.name || "İsimsiz yol"}
          {segment.buurt ? <span className="inspect-sub"> · {segment.buurt}</span> : null}
        </span>
        <button onClick={onClose} aria-label="Kapat">
          ×
        </button>
      </header>

      <div className="inspect-score-row">
        <span className="inspect-score" style={{ color: scoreColor(segment.score) }}>
          {segment.score}
        </span>
        <span className="inspect-score-label">/100 · {scoreName(segment.score)}</span>
      </div>

      {segment.reportEffect ? (
        <div className="inspect-report-note">
          Kullanıcı raporları nedeniyle {segment.baseScore} → {segment.score}
          {" ("}
          {segment.reportEffect > 0 ? "-" : "+"}
          {Math.abs(segment.reportEffect)} puan{")"}
        </div>
      ) : null}

      {b &&
        Object.entries(BREAKDOWN_LABELS).map(([key, label]) => {
          const v = b[key];
          if (v == null) return null;
          const isRisk = key === "nightlifeRisk" || key === "crimeRisk";
          return (
            <div className="inspect-row" key={key}>
              <span>{label}</span>
              <span className="inspect-bar">
                <i style={{ width: `${v}%`, background: isRisk ? "#dc2626" : scoreColor(v) }} />
              </span>
              <b>{v}</b>
            </div>
          );
        })}

      {b && <div className="inspect-note">Kırmızı satırlar puan düşürür, diğerleri katkı sağlar.</div>}
    </section>
  );
}

export function ScoreLegend() {
  return (
    <div className="legend">
      <span className="legend-title">Rota rengi = güvenlik skoru</span>
      <div className="legend-scale">
        {SCORE_BANDS.map((b) => (
          <span key={b.label} className="legend-item">
            <i style={{ background: b.color }} />
            {b.label}
          </span>
        ))}
      </div>
      <span className="legend-hint">Haritada bir parçaya dokun → neden bu puan?</span>
    </div>
  );
}
