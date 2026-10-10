// What's kept on this device: saving changes, loading it all at start, and clearing or erasing it. A change goes to
// memory, then to IndexedDB together with its outbox item, which sync.ts uploads. The network is never in the way
// of a tap.
import { nowIso, prefs, uuid } from './util';
import { db } from './db';
import { clearMemory, putInMemory } from './data';
import { outbox } from './outbox';
import {
  STARTER_TRACKERS, entryRow, normalizeEntry, normalizeTracker, trackerRow,
  type Entry, type TableName, type Tables, type Tracker, type UploadRow,
} from './model';
import { sync, syncState } from './sync';

/** Saves trackers. Pass new objects for changed ones. */
export const saveTrackers = (changed: Tracker[]) => save('trackers', changed, trackerRow);

/** Saves entries. Entries are never changed in place: pass a new object for an edit. */
export const saveEntries = (changed: Entry[]) => save('entries', changed, entryRow);

async function save<T extends TableName>(table: T, changed: Tables[T][], toRow: (item: Tables[T]) => UploadRow): Promise<void> {
  if (!changed.length) return;
  const updatedAt = nowIso();
  const saved = changed.map(item => ({ ...item, updated_at: updatedAt }));
  putInMemory(table, saved);
  // In one transaction, so nothing is saved here without being queued to upload.
  await db.putTogether({ [table]: saved, outbox: outbox.queue(table, saved.map(toRow), updatedAt) });
  sync.syncSoon();
}

/** Loads everything from IndexedDB into memory. A brand-new device gets the starter trackers. */
export async function loadFromDevice(): Promise<void> {
  const [savedTrackers, savedEntries] = await Promise.all([
    db.all<Record<string, unknown>>('trackers'),
    db.all<Record<string, unknown>>('entries'),
    outbox.load(),
  ]);
  putInMemory('trackers', savedTrackers.map(normalizeTracker));
  putInMemory('entries', savedEntries.map(normalizeEntry));

  // Skip the starter set if this device is about to link to an account, which has its own trackers.
  if (!savedTrackers.length && !(await db.getMeta<boolean>('seeded'))) {
    if (!syncState.get().projectUrl) await addStarterTrackers();
    await db.setMeta('seeded', true);
  }
}

export function addStarterTrackers(): Promise<void> {
  return saveTrackers(STARTER_TRACKERS.map((starter, i) => (
    { id: uuid(), ...starter, sort_order: i * 10, archived: false, deleted: false }
  )));
}

/** Forgets every tracker and entry on this device, and the changes still waiting to upload. Settings are kept. */
export async function clearData(): Promise<void> {
  for (const store of ['trackers', 'entries'] as const) await db.clear(store);
  await outbox.clear();
  clearMemory();
}

/** Erases everything Log Lightly keeps on this device: trackers, entries, the outbox and all settings. */
export async function eraseDevice(): Promise<void> {
  for (const store of ['trackers', 'entries', 'meta'] as const) await db.clear(store);
  await outbox.clear();
  prefs.clearAll();
}
