import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import TrackViewer from './TrackViewer.jsx'

const trackId = new URLSearchParams(window.location.search).get('track')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {trackId ? <TrackViewer id={trackId} /> : <App />}
  </StrictMode>,
)
