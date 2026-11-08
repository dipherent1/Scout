import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// Camera access on a phone needs HTTPS, so the dev server uses a self-signed
// certificate. Run `npm run dev`, open https://<your-lan-ip>:5173 on the phone
// and accept the certificate warning once. Set SCOUT_HTTP=1 to serve plain HTTP.
const useHttps = process.env.SCOUT_HTTP !== '1'
const apiTarget = process.env.SCOUT_API_URL ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [
    vue(),
    ...(useHttps ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Scout',
        short_name: 'Scout',
        description: 'Point your phone at a booth, get a summary and an icebreaker.',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        orientation: 'portrait',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // Cache the app shell plus the exhibitor bundle and (later) the ONNX model.
        globPatterns: ['**/*.{js,css,html,svg,json,onnx,wasm}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/bundle/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'scout-bundle' },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  worker: { format: 'es' },
})
