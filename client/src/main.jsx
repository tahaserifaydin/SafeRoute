import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'
import TrackViewer from './TrackViewer.jsx'
import StudyView from './StudyView.jsx'
import { LanguageProvider } from './lib/i18n.jsx'

// Önceden vite-plugin-pwa'nın otomatik eklediği script'e güveniliyordu — ne
// zaman/nasıl güncellediği belirsizdi, kullanıcılar günler sonra bile eski
// sürümü görmeye devam edebiliyordu (bugün defalarca yaşandı). Artık açıkça
// kayıt yapılıyor: yeni sürüm bulunduğu an (skipWaiting+clientsClaim zaten
// açık, bkz. vite.config.js) otomatik uygulanıp sayfa yenileniyor — kullanıcı
// hiçbir şey yapmasına gerek kalmadan en güncel koda kavuşuyor. 60 saniyede
// bir de kontrol ediliyor ki sekme uzun süre açık kalsa bile güncelleme gecikmesin.
if ('serviceWorker' in navigator) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateSW(true)
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      setInterval(() => registration.update().catch(() => {}), 60 * 1000)
    },
  })
}

const params = new URLSearchParams(window.location.search)
const trackId = params.get('track')
const isStudy = params.has('study')

function Root() {
  if (trackId) return <TrackViewer id={trackId} />
  if (isStudy) return <StudyView />
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LanguageProvider>
      <Root />
    </LanguageProvider>
  </StrictMode>,
)
