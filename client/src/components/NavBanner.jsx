import { formatDistance, scoreColor } from "../lib/constants";
import { translateInstruction, useLanguage } from "../lib/i18n";

const TURN_ICONS = {
  "Sağa dön": "↱",
  "Sola dön": "↰",
  "Hafif sağa dön": "↗",
  "Hafif sola dön": "↖",
  "Keskin sağa dön": "⤳",
  "Keskin sola dön": "⤲",
  "Yürümeye başla": "↑",
  "Hedefe ulaştın": "🏁",
};

export default function NavBanner({
  currentStep,
  nextStep,
  liveDistance,
  onStop,
  currentScore,
  isSim,
  voiceEnabled,
  onToggleVoice,
  voiceSupported,
}) {
  const { lang, t } = useLanguage();
  if (!currentStep) return null;
  // TURN_ICONS anahtarları rota motorunun (worker.js) her zaman ÜRETTİĞİ
  // Türkçe talimatlar — görüntülemeden önce translateInstruction ile çevriliyor,
  // ama eşleşme için ham (Türkçe) metin kullanılıyor.
  const icon = TURN_ICONS[currentStep.instruction] || "↑";

  return (
    <div className="nav-banner">
      <div className="nav-top-row">
        {isSim && <div className="nav-sim-tag">{t("nav.simTag")}</div>}
        {voiceSupported && (
          <button
            className="nav-voice-toggle"
            onClick={onToggleVoice}
            aria-pressed={voiceEnabled}
            aria-label={voiceEnabled ? t("voice.mute") : t("voice.unmute")}
            title={voiceEnabled ? t("voice.mute") : t("voice.unmute")}
          >
            {voiceEnabled ? "🔊" : "🔇"}
          </button>
        )}
      </div>
      <div className="nav-main">
        <span className="nav-icon" aria-hidden="true">
          {icon}
        </span>
        <div>
          <div className="nav-instruction">{translateInstruction(currentStep.instruction, lang)}</div>
          <div className="nav-distance">
            {nextStep
              ? t("nav.inDistance", { dist: formatDistance(liveDistance ?? currentStep.distanceM) })
              : translateInstruction("Hedefe ulaştın", lang)}
          </div>
        </div>
      </div>

      {nextStep && (
        <div className="nav-next">
          {t("nav.then")}
          {TURN_ICONS[nextStep.instruction] || "↑"} {translateInstruction(nextStep.instruction, lang)}
        </div>
      )}

      {currentScore != null && (
        <div className="nav-score">
          {t("nav.currentSegment")}
          <b style={{ color: scoreColor(currentScore) }}>{currentScore}/100</b>
        </div>
      )}

      <button className="nav-stop" onClick={onStop}>
        {t("nav.stop")}
      </button>
    </div>
  );
}
