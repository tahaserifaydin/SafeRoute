import { REPORT_TYPE_ICONS, REPORT_TYPE_LABELS, formatDistance } from "../lib/constants";

export function ReportForm({ pending, onChange, onSubmit, onCancel }) {
  return (
    <section className="report-form" aria-label="Yeni rapor">
      <div className="report-title">Bu noktayı bildir</div>
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
        placeholder="Kısa not (isteğe bağlı)"
        aria-label="Not"
        value={pending.note}
        onChange={(e) => onChange({ ...pending, note: e.target.value })}
      />
      <div className="report-actions">
        <button className="btn-primary" onClick={onSubmit}>
          Gönder
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          İptal
        </button>
      </div>
      <p className="report-disclaimer">
        Raporlar zamanla ağırlığını yitirir ve başkalarınca teyit edilince güçlenir; tek bir rapor
        rotayı belirlemez.
      </p>
    </section>
  );
}

export function HavensList({ havens, timeLabel }) {
  if (!havens.length) return <div className="status">Yakında sığınılabilecek nokta bulunamadı.</div>;
  return (
    <section className="havens" aria-label="Güvenli noktalar">
      <div className="havens-head">
        Sığınılabilecek noktalar <span className="havens-time">{timeLabel} saatine göre</span>
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
  return (
    <section className="steps-list" aria-label="Yol tarifi">
      {steps.map((s, i) => (
        <div className={`step-row ${i === activeIndex ? "current" : ""}`} key={i}>
          <span className="step-instruction">{s.instruction}</span>
          {s.distanceM > 0 && <span className="step-distance">{formatDistance(s.distanceM)}</span>}
        </div>
      ))}
    </section>
  );
}

export function SavedRoutes({ routes, onLoad, onDelete }) {
  if (!routes.length) return null;
  return (
    <section className="saved" aria-label="Kayıtlı rotalar">
      <div className="saved-head">Kayıtlı rotalar</div>
      {routes.map((r) => (
        <div className="saved-row" key={r.id}>
          <button className="saved-load" onClick={() => onLoad(r)}>
            <b>{r.name}</b>
            <span>{r.startLabel} → {r.endLabel}</span>
          </button>
          <button className="saved-del" onClick={() => onDelete(r.id)} aria-label="Sil">
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
