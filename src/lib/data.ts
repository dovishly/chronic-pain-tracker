// The trackers and entries on this device, held in memory (IndexedDB is the durable copy, see store.ts).
// store.ts and sync.ts change the maps in place and then call dataChanged(), which gives components a
// new snapshot so React re-renders. Components read it with useData() in hooks.ts.
import { createStore } from './util';
import type { Data, Entry, Tracker } from './model';

export const trackers = new Map<string, Tracker>();
export const entries = new Map<string, Entry>();

/** Outbox keys ("table:id") of local changes the server hasn't confirmed yet. Mirrors the outbox store. */
export const pendingKeys = new Set<string>();

export const dataStore = createStore<Data>({ trackers, entries });

export const dataChanged = () => dataStore.set({ trackers, entries });
