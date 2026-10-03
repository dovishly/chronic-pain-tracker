import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative paths, so the build works at any address (e.g. https://name.github.io/logbook/).
  base: './',
  plugins: [
    react(),
    VitePWA({
      // The manifest is a static file in public/; the plugin only builds the offline service worker.
      manifest: false,
      // main.tsx registers the service worker itself (only on https, never in tests).
      injectRegister: false,
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
        // Fonts are cached as they're used. Supabase is never touched: it isn't listed here.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'fonts', cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
});
