import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Store } from './lib/util';
import { dataStore } from './lib/data';
import { syncState } from './lib/sync';
import { toastStore } from './lib/toast';
import { themeStore } from './lib/theme';

/** A store's current value, re-rendering when it changes. */
const useStore = <T>(store: Store<T>) => useSyncExternalStore(store.subscribe, store.get);

export const useData = () => useStore(dataStore);
export const useSyncState = () => useStore(syncState);
export const useToast = () => useStore(toastStore);
export const useTheme = () => useStore(themeStore);

/** Date.now(), re-rendering every intervalMs and when the app returns to the foreground. */
export function useNow(intervalMs: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = () => setTick(t => t + 1);
    const onVisible = () => { if (!document.hidden) tick(); };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return Date.now();
}
