// Hooks that connect components to the stores outside React.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { dataStore } from './lib/data';
import { sync } from './lib/sync';
import { toastStore } from './lib/toast';

/** Trackers and entries. The component re-renders after every change. */
export const useData = () => useSyncExternalStore(dataStore.subscribe, dataStore.get);

/** Sync status, sign-in state and the number of writes waiting to upload. */
export const useSyncState = () => useSyncExternalStore(sync.subscribe, sync.get);

export const useToast = () => useSyncExternalStore(toastStore.subscribe, toastStore.get);

/**
 * The current time. Re-renders every intervalMs and whenever the app comes back to the
 * foreground, so running durations stay current.
 */
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
