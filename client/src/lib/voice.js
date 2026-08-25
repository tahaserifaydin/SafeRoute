// Tarayıcının yerleşik konuşma sentezini kullanır (ekstra servis/anahtar gerekmez).
// Yürürken telefona bakmadan yön tarifini duymak için — gece yalnız yürüyen biri
// için ekrana kilitlenmemek güvenlik açısından da önemli.
const PROXIMITY_WARNING_M = 50;

let currentUtterance = null;

export function isVoiceSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text) {
  if (!isVoiceSupported() || !text) return;
  window.speechSynthesis.cancel(); // önceki cümle bitmediyse kes, üst üste binmesin
  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.lang = "tr-TR";
  currentUtterance.rate = 1.0;
  window.speechSynthesis.speak(currentUtterance);
}

export function stopSpeaking() {
  if (isVoiceSupported()) window.speechSynthesis.cancel();
}

export { PROXIMITY_WARNING_M };
