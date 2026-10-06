// Writes go to memory and IndexedDB, then the outbox for the next sync. Never to the network directly.
import { nowIso, uuid } from './util';
import { db } from './db';
import { trackers, entries, pendingKeys, dataChanged } from './data';
import { STARTER_TRACKERS, normalizeEntry, normalizeTracker, type Entry, type Tracker } from './model';
import { sync, type OutboxItem } from './sync';

/** The row sent to Supabase: exactly the table's columns, with defaults filled in. */
function trackerRow(t: Tracker) {
  return {
    id: t.id, name: t.name, type: t.type, group_name: t.group_name ?? null, color: t.color,
    config: t.config || {}, sort_order: t.sort_order || 0, archived: !!t.archived,
  };
}

function entryRow(e: Entry) {
  return {
    id: e.id, tracker_id: e.tracker_id, occurred_at: e.occurred_at, kind: e.kind, value: e.value ?? null,
    text: e.text ?? null, note: e.note ?? null, checkin_id: e.checkin_id ?? null, deleted: !!e.deleted,
  };
}

async function queueForSync(item: OutboxItem): Promise<void> {
  pendingKeys.add(item.key);
  await db.put('outbox', item);
  sync.syncSoon();
}

/** Saves an entry. Entries are never changed in place: pass a new object for an edit. */
export async function saveEntry(entry: Entry): Promise<void> {
  const saved = { ...entry, updated_at: nowIso() };
  entries.set(saved.id, saved);
  dataChanged();
  await db.put('entries', saved);
  await queueForSync({ key: 'entries:' + saved.id, table: 'entries', updatedAt: saved.updated_at, row: entryRow(saved) });
}

export async function saveTracker(tracker: Tracker): Promise<void> {
  const saved = { ...tracker, updated_at: nowIso() };
  trackers.set(saved.id, saved);
  dataChanged();
  await db.put('trackers', saved);
  await queueForSync({ key: 'trackers:' + saved.id, table: 'trackers', updatedAt: saved.updated_at, row: trackerRow(saved) });
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
    if (!sync.get().projectUrl) {
      for (const [i, starter] of STARTER_TRACKERS.entries()) {
        await saveTracker({ id: uuid(), ...starter, sort_order: i * 10, archived: false });
      }
    }
    await db.setMeta('seeded', true);
  }
}
