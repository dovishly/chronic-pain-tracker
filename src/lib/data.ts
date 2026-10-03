// The trackers and entries on this device, held in memory (IndexedDB is the durable copy).
// Writers (store.ts, sync.ts) change the maps in place and then call dataChanged(), which
// gives the UI a new snapshot object so React knows to re-render. See useData() in hooks.ts.
import type { Data, Entry, Tracker } from './model';

export const trackers = new Map<string, Tracker>();
export const entries = new Map<string, Entry>();

/** Outbox keys ("table:id") that the server hasn't confirmed yet. Mirrors the outbox store. */
export const pendingKeys = new Set<string>();

let snapshot: Data = { trackers, entries };
const listeners = new Set<() => void>();

export function dataChanged(): void {
  snapshot = { trackers, entries };
  listeners.forEach(fn => fn());
}

export const dataStore = {
  get: (): Data => snapshot,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
