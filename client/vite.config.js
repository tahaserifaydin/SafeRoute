import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // /data/*.json (bölge yol ağları, en büyüğü Eindhoven ~27MB) service worker
      // kurulumunda önden indirilmez (precache) — kullanıcı hiç açmadığı bölge için
      // gereksiz büyük indirme olur. Bunun yerine motor (worker.js) bu dosyaları
      // ilk rota isteğinde normal fetch ile çeker; burada sadece o isteği runtime'da
      // yakalayıp CacheFirst ile diske yazıyoruz ki ikinci ziyarette/offline'da hazır olsun.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        runtimeCaching: [
          {
            urlPattern: /\/data\/.*\.json$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'saferoute-region-data',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'saferoute-map-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 14 },
            },
          },
        ],
      },
      manifest: {
        name: 'SafeRoute — Güvenli Yaya Navigasyonu',
        short_name: 'SafeRoute',
        description: 'Eindhoven ve Nuenen için karanlık/güvensiz sokaklardan kaçınan yaya rota planlayıcı.',
        theme_color: '#0b0b12',
        background_color: '#0b0b12',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
