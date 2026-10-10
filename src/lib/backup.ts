// The backup file: every tracker and entry, as JSON. "Export backup" writes one (export.ts), and "Restore backup"
// reads it back (restoreBackup() in actions.ts).
import { nowIso } from './util';
import {
  ENTRY_KINDS, TRACKER_TYPES, allTrackers, liveEntries, normalizeEntry, normalizeTracker,
  type Data, type Entry, type Tracker,
} from './model';

/** The format's name in every backup: Log Lightly's former name, kept so old and new backups name the same one. */
const FORMAT = 'logbook';
const VERSION = 1;

/** What a backup holds. */
export interface Backup {
  exported: number | null; // when it was made, in ms
  trackers: Tracker[];
  entries: Entry[];
}

/** A backup of everything on this device. Deleted trackers and entries are left out: they hold nothing to keep. */
export const backupOf = (data: Data) =>
  ({ app: FORMAT, version: VERSION, exported: nowIso(), trackers: allTrackers(data), entries: liveEntries(data) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NOT_A_BACKUP = "That file isn't a Log Lightly backup.";

/** The backup in a file's text. Throws a message for the person if it isn't one this app can read. */
export function readBackup(text: string): Backup {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  if (!isRecord(file) || file.app !== FORMAT) throw new Error(NOT_A_BACKUP);
  if (typeof file.version === 'number' && file.version > VERSION) {
    throw new Error('That backup is from a newer version of Log Lightly. Update the app, then try again.');
  }
  if (file.version !== VERSION || !Array.isArray(file.trackers) || !Array.isArray(file.entries)) throw new Error(NOT_A_BACKUP);
  if (!file.trackers.every(isRecord) || !file.entries.every(isRecord)) throw new Error("Part of that backup can't be read.");

  const trackers = file.trackers.map(normalizeTracker);
  const trackerIds = new Set(trackers.map(t => t.id));
  const entries = file.entries.map(normalizeEntry);
  // Each tracker of a type this app knows, and each entry of a kind it knows, for one of those trackers.
  const readable = trackers.every(t => typeof t.id === 'string' && typeof t.name === 'string'
    && TRACKER_TYPES.includes(t.type) && typeof t.sort_order === 'number')
    && entries.every(e => typeof e.id === 'string' && trackerIds.has(e.tracker_id)
      && ENTRY_KINDS.includes(e.kind) && !Number.isNaN(Date.parse(e.occurred_at)));
  if (!readable) throw new Error("Part of that backup can't be read.");

  const exported = typeof file.exported === 'string' ? Date.parse(file.exported) : NaN;
  return { exported: Number.isNaN(exported) ? null : exported, trackers, entries };
}

/** "9 trackers and 312 entries". */
export function backupContents(backup: Backup): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${count(backup.trackers.length, 'tracker', 'trackers')} and ${count(backup.entries.length, 'entry', 'entries')}`;
}

/** How many entries on this device restoring the backup would lose: the ones that aren't in it. */
export function entriesNotInBackup(data: Data, backup: Backup): number {
  const inBackup = new Set(backup.entries.map(e => e.id));
  return liveEntries(data).filter(e => !inBackup.has(e.id)).length;
}
