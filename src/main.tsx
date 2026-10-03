// Logbook: a personal, local-first tracker.
// Data lives in IndexedDB on the device and syncs to your own Supabase project when connected.
// No personal data or settings live in this code.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadFromDevice } from './lib/store';
import { sync } from './lib/sync';
import './styles.css';

const SYNC_INTERVAL_MS = 60_000;

async function start() {
  try {
    navigator.storage?.persist?.(); // ask the browser not to evict our data
  } catch {
    // Not supported; nothing to do.
  }
  await loadFromDevice();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  sync.run();
  setInterval(() => sync.run(), SYNC_INTERVAL_MS);
  window.addEventListener('online', () => sync.run());
  window.addEventListener('offline', () => sync.run());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync.run();
  });

  // The offline service worker is built by vite-plugin-pwa. Only on https: never in local tests.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start();
