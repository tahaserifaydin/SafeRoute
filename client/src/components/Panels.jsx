import { REPORT_TYPE_ICONS, formatDistance, reportTypeLabels } from "../lib/constants";
import { translateInstruction, useLanguage } from "../lib/i18n";

export function ReportForm({ pending, onChange, onSubmit, onCancel }) {
  const { lang, t } = useLanguage();
  const REPORT_TYPE_LABELS = reportTypeLabels(lang);
  return (
    <section className="report-form" aria-label="Yeni rapor">
      <div className="report-title">{t("report.title")}</div>
      <div className="report-types">
        {Object.entries(REPORT_TYPE_LABELS).map(([k, v]) => (
          <button
            key={k}
            className={`report-type ${pending.type === k ? "active" : ""}`}
            onClick={() => onChange({ ...pending, type: k })}
            aria-pressed={pending.type === k}
          >
            <span aria-hidden="true">{REPORT_TYPE_ICONS[k]}</span> {v}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder={t("report.notePlaceholder")}
        aria-label={t("report.notePlaceholder")}
        value={pending.note}
        onChange={(e) => onChange({ ...pending, note: e.target.value })}
      />
      <div className="report-actions">
        <button className="btn-primary" onClick={onSubmit}>
          {t("action.submit")}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          {t("action.cancel")}
        </button>
      </div>
      <p className="report-disclaimer">{t("report.disclaimer")}</p>
    </section>
  );
}

export function HavensList({ havens, timeLabel }) {
  const { t } = useLanguage();
  if (!havens.length) return <div className="status">{t("havens.none")}</div>;
  return (
    <section className="havens" aria-label="Güvenli noktalar">
      <div className="havens-head">
        {t("havens.title")} <span className="havens-time">{t("havens.byTime", { time: timeLabel })}</span>
      </div>
      {havens.slice(0, 6).map((h, i) => (
        <div className={`haven-row ${h.isOpen ? "" : "closed"}`} key={i}>
          <span className="haven-icon" aria-hidden="true">
            {h.isOpen ? "🛟" : "🔒"}
          </span>
          <span className="haven-name">
            {h.name}
            <span className="haven-type">{h.typeLabel}</span>
          </span>
          <span className="haven-dist">{formatDistance(h.distanceM)}</span>
        </div>
      ))}
    </section>
  );
}

export function StepsList({ steps, activeIndex }) {
  const { lang } = useLanguage();
  return (
    <section className="steps-list" aria-label="Yol tarifi">
      {steps.map((s, i) => (
        <div className={`step-row ${i === activeIndex ? "current" : ""}`} key={i}>
          <span className="step-instruction">{translateInstruction(s.instruction, lang)}</span>
          {s.distanceM > 0 && <span className="step-distance">{formatDistance(s.distanceM)}</span>}
        </div>
      ))}
    </section>
  );
}

export function SavedRoutes({ routes, onLoad, onDelete }) {
  const { t } = useLanguage();
  if (!routes.length) return null;
  return (
    <section className="saved" aria-label="Kayıtlı rotalar">
      <div className="saved-head">{t("saved.title")}</div>
      {routes.map((r) => (
        <div className="saved-row" key={r.id}>
          <button className="saved-load" onClick={() => onLoad(r)}>
            <b>{r.name}</b>
            <span>{r.startLabel} → {r.endLabel}</span>
          </button>
          <button className="saved-del" onClick={() => onDelete(r.id)} aria-label={t("saved.delete")}>
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
