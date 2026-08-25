import { formatDistance, scoreColor } from "../lib/constants";

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
  if (!currentStep) return null;
  const icon = TURN_ICONS[currentStep.instruction] || "↑";

  return (
    <div className="nav-banner">
      <div className="nav-top-row">
        {isSim && <div className="nav-sim-tag">Simülasyon</div>}
        {voiceSupported && (
          <button
            className="nav-voice-toggle"
            onClick={onToggleVoice}
            aria-pressed={voiceEnabled}
            aria-label={voiceEnabled ? "Sesi kapat" : "Sesi aç"}
            title={voiceEnabled ? "Sesi kapat" : "Sesi aç"}
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
          <div className="nav-instruction">{currentStep.instruction}</div>
          <div className="nav-distance">
            {nextStep
              ? `${formatDistance(liveDistance ?? currentStep.distanceM)} sonra`
              : "Hedefe ulaştın"}
          </div>
        </div>
      </div>

      {nextStep && (
        <div className="nav-next">
          Sonra: {TURN_ICONS[nextStep.instruction] || "↑"} {nextStep.instruction}
        </div>
      )}

      {currentScore != null && (
        <div className="nav-score">
          Bulunduğun bölüm:{" "}
          <b style={{ color: scoreColor(currentScore) }}>{currentScore}/100</b>
        </div>
      )}

      <button className="nav-stop" onClick={onStop}>
        Navigasyonu durdur
      </button>
    </div>
  );
}
