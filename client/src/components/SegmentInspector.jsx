import { breakdownLabels, SCORE_BANDS, scoreColor, scoreName } from "../lib/constants";
import { useLanguage } from "../lib/i18n";

// Bir yol parçasının skorunun neden o olduğunu bileşen bileşen gösterir.
export default function SegmentInspector({ segment, onClose }) {
  const { lang, t } = useLanguage();
  if (!segment) return null;
  const b = segment.breakdown;
  const BREAKDOWN_LABELS = breakdownLabels(lang);

  return (
    <section className="inspect-box" aria-label="Segment detayı">
      <header className="inspect-head">
        <span>
          {segment.name || t("road.unnamed")}
          {segment.buurt ? <span className="inspect-sub"> · {segment.buurt}</span> : null}
        </span>
        <button onClick={onClose} aria-label={t("action.close")}>
          ×
        </button>
      </header>

      <div className="inspect-score-row">
        <span className="inspect-score" style={{ color: scoreColor(segment.score) }}>
          {segment.score}
        </span>
        <span className="inspect-score-label">/100 · {scoreName(segment.score, lang)}</span>
      </div>

      {segment.reportEffect ? (
        <div className="inspect-report-note">
          {t("report.effectNote", {
            base: segment.baseScore,
            score: segment.score,
            sign: segment.reportEffect > 0 ? "-" : "+",
            delta: Math.abs(segment.reportEffect),
          })}
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

      {b && <div className="inspect-note">{t("breakdown.legendNote")}</div>}
    </section>
  );
}

export function ScoreLegend() {
  const { t } = useLanguage();
  return (
    <div className="legend">
      <span className="legend-title">{t("legend.title")}</span>
      <div className="legend-scale">
        {SCORE_BANDS.map((b) => (
          <span key={b.label} className="legend-item">
            <i style={{ background: b.color }} />
            {b.label}
          </span>
        ))}
      </div>
      <span className="legend-hint">{t("legend.hint")}</span>
    </div>
  );
}
