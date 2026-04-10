import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),

    // ── PWA plugin ─────────────────────────────────────────
    // Generates web app manifest + service worker (Workbox).
    // Spec requirements:
    //   - Web app manifest
    //   - Service worker for offline support
    //   - Full screen, no browser bar (display: standalone)
    //   - Install prompt for Android Chrome
    VitePWA({
      // Generate a new service worker on every build.
      strategies: 'generateSW',

      // Register the service worker automatically so the install
      // prompt fires on Android Chrome without extra client code.
      registerType: 'autoUpdate',

      // Precache everything in the dist output for offline support.
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // Return app shell for all navigation requests so React
        // Router works offline.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//]
      },

      // ── Web app manifest ──────────────────────────────────
      // display: 'standalone' hides the browser bar and makes the
      // app look and feel native — required for TWA wrapping via
      // PWABuilder and for the Android Chrome install prompt.
      // 'fullscreen' would also satisfy the spec but 'standalone'
      // is the TWA-compatible choice and still gives full-screen
      // feel with no browser chrome visible.
      manifest: {
        name: 'RandAnonChat',
        short_name: 'RandAnon',
        description: 'Anonymous encrypted random chat',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },

      // Emit the manifest and SW assets into the build output.
      includeAssets: ['icons/*.png', 'favicon.ico']
    })
  ],

  // ── Dev server ────────────────────────────────────────────
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api requests to the Express backend on :5000.
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
