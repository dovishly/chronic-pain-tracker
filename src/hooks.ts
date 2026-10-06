import { useEffect, useState, useSyncExternalStore } from 'react';
import { dataStore } from './lib/data';
import { sync } from './lib/sync';
import { toastStore } from './lib/toast';

export const useData = () => useSyncExternalStore(dataStore.subscribe, dataStore.get);

export const useSyncState = () => useSyncExternalStore(sync.subscribe, sync.get);

export const useToast = () => useSyncExternalStore(toastStore.subscribe, toastStore.get);

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
