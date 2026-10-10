// The trackers and entries on this device, held in memory (IndexedDB is the durable copy, see local.ts). They
// change only through putInMemory() and clearMemory(), which give components a new snapshot so React re-renders.
// Components read it with useData() in hooks.ts.
import { createStore } from './util';
import type { Data, Entry, TableName, Tables, Tracker } from './model';

const trackers = new Map<string, Tracker>();
const entries = new Map<string, Entry>();
const maps: { [T in TableName]: Map<string, Tables[T]> } = { trackers, entries };

export const dataStore = createStore<Data>({ trackers, entries });

const changed = () => dataStore.set({ trackers, entries });

/** Adds trackers or entries, or replaces them by id. */
export function putInMemory<T extends TableName>(table: T, items: Tables[T][]): void {
  for (const item of items) maps[table].set(item.id, item);
  changed();
}

/** Forgets every tracker and entry, for a device taking on an account's data. */
export function clearMemory(): void {
  trackers.clear();
  entries.clear();
  changed();
}
