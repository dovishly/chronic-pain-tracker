// Saving on this device. A change goes to memory, then IndexedDB, then the outbox, which sync.ts uploads.
// The network is never in the way of a tap.
import { nowIso, prefs, uuid } from './util';
import { db } from './db';
import { trackers, entries, pendingKeys, dataChanged } from './data';
import { STARTER_TRACKERS, normalizeEntry, normalizeTracker, type Entry, type Tracker } from './model';
import { sync, syncState, type OutboxItem, type Table } from './sync';

// The rows to upload. Each has every column, even when empty: Supabase refuses a batch whose rows have
// different fields. updated_at is left out because the server sets it.

const trackerRow = (t: Tracker) => ({
  id: t.id, name: t.name, type: t.type, group_name: t.group_name ?? null, color: t.color,
  config: t.config || {}, sort_order: t.sort_order || 0, archived: !!t.archived, deleted: !!t.deleted,
});

const entryRow = (e: Entry) => ({
  id: e.id, tracker_id: e.tracker_id, occurred_at: e.occurred_at, kind: e.kind, value: e.value ?? null,
  text: e.text ?? null, note: e.note ?? null, checkin_id: e.checkin_id ?? null, deleted: !!e.deleted,
});

/** Saves trackers. Pass new objects for changed ones. */
export const saveTrackers = (changed: Tracker[]) => save('trackers', trackers, changed, trackerRow);

/** Saves entries. Entries are never changed in place: pass a new object for an edit. */
export const saveEntries = (changed: Entry[]) => save('entries', entries, changed, entryRow);

async function save<T extends Tracker | Entry>(
  table: Table, inMemory: Map<string, T>, changed: T[], toRow: (item: T) => Record<string, unknown>,
): Promise<void> {
  if (!changed.length) return;
  const updatedAt = nowIso();
  const saved = changed.map(item => ({ ...item, updated_at: updatedAt }));
  for (const item of saved) inMemory.set(item.id, item);
  dataChanged();
  await db.putMany(table, saved);

  const queued: OutboxItem[] = saved.map(item => ({ key: `${table}:${item.id}`, table, updatedAt, row: toRow(item) }));
  for (const item of queued) pendingKeys.add(item.key);
  await db.putMany('outbox', queued);
  sync.syncSoon();
}

/** Loads everything from IndexedDB into memory. A brand-new device gets the starter trackers. */
export async function loadFromDevice(): Promise<void> {
  const [savedTrackers, savedEntries, outbox] = await Promise.all([
    db.all<Record<string, unknown>>('trackers'),
    db.all<Record<string, unknown>>('entries'),
    db.all<OutboxItem>('outbox'),
  ]);
  for (const raw of savedTrackers) {
    const tracker = normalizeTracker(raw);
    trackers.set(tracker.id, tracker);
  }
  for (const raw of savedEntries) {
    const entry = normalizeEntry(raw);
    entries.set(entry.id, entry);
  }
  for (const item of outbox) pendingKeys.add(item.key);
  dataChanged();

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

/** Erases everything Log Lightly keeps on this device: trackers, entries, the outbox and all settings. */
export async function eraseDevice(): Promise<void> {
  for (const store of ['trackers', 'entries', 'outbox', 'meta'] as const) await db.clear(store);
  prefs.clearAll();
}
