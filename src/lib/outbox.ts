// The outbox: changes made on this device that haven't uploaded yet, kept in IndexedDB so they outlast the app
// being closed. store.ts queues each change in the same transaction that saves it, so nothing is saved without
// being queued; sync.ts uploads them and then takes them out.
import { db } from './db';
import type { Table, UploadRow } from './model';

/** A local change waiting to upload. updatedAt is the row's updated_at when queued, to tell if it changed since. */
export interface OutboxItem { key: string; table: Table; updatedAt: string; row: UploadRow }

/** What's waiting: each item's key ("table:id") and the updatedAt of its latest change. Mirrors the outbox store. */
const waiting = new Map<string, string>();

const keyOf = (table: Table, id: string) => `${table}:${id}`;

export const outbox = {
  /** How many changes are waiting. */
  size: () => waiting.size,

  /** Whether a row has a change on this device that hasn't uploaded yet. */
  has: (table: Table, id: string) => waiting.has(keyOf(table, id)),

  /** Notes what was still waiting when the app last closed. */
  async load(): Promise<void> {
    for (const item of await db.all<OutboxItem>('outbox')) waiting.set(item.key, item.updatedAt);
  },

  /** Items for rows just saved, counted as waiting from now on. Put them in the same transaction as the rows. */
  queue(table: Table, rows: UploadRow[], updatedAt: string): OutboxItem[] {
    return rows.map(row => {
      const key = keyOf(table, row.id);
      waiting.set(key, updatedAt);
      return { key, table, updatedAt, row };
    });
  },

  /** Everything waiting. */
  all: () => db.all<OutboxItem>('outbox'),

  /** Takes uploaded items out, except any changed again while being sent: the newer change still has to go up. */
  async remove(sent: OutboxItem[]): Promise<void> {
    const sentAt = new Map(sent.map(item => [item.key, item.updatedAt]));
    const removed = await db.removeIf<OutboxItem>('outbox', [...sentAt.keys()], (current, key) => current?.updatedAt === sentAt.get(key));
    // A change queued since, but not saved yet, keeps its key waiting.
    for (const key of removed) if (waiting.get(key) === sentAt.get(key)) waiting.delete(key);
  },

  /** Empties it, for a device taking on an account's data or being erased. */
  async clear(): Promise<void> {
    await db.clear('outbox');
    waiting.clear();
  },
};
