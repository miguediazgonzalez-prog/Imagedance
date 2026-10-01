import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
  plugins: [vue(), VitePWA({
    registerType: 'autoUpdate',
    manifest: { name: 'Foto Animada', short_name: 'Foto Animada', display: 'standalone', background_color: '#e9edf2', theme_color: '#e9edf2',
      icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }, { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
    // El modelo y el WASM de MediaPipe se cachean tras la primera descarga => funciona offline.
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
      runtimeCaching: [{ urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|storage\.googleapis\.com)\//, handler: 'CacheFirst',
        options: { cacheName: 'ai-models', cacheableResponse: { statuses: [0, 200] } } }] }
  })],
  build: { target: 'es2022' }
})
