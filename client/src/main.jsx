import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import TrackViewer from './TrackViewer.jsx'
import StudyView from './StudyView.jsx'

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
    <Root />
  </StrictMode>,
)
