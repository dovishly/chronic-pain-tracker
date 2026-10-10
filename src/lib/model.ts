// The data model: trackers, entries, and what's derived from them (episodes, days, labels).
// Field names on trackers and entries are the Supabase column names, so rows go to and from it as they are.
import { dayKey, groupBy, nowIso, uuid, unhandled, type DayBounds } from './util';

/* ---------- types ---------- */

// Switches over these end in unhandled(), so TypeScript lists every place a new one needs handling.
// The check constraints in schema.sql must match.
export const TRACKER_TYPES = ['rating', 'episode', 'moment', 'number', 'choice', 'text'] as const;
export type TrackerType = (typeof TRACKER_TYPES)[number];

export interface TrackerConfig {
  levels?: string[];      // rating: one label per level, lowest first; episode: optional severity labels
  unit?: string;          // number
  min?: number | null;    // number
  max?: number | null;    // number
  step?: number | null;   // number
  options?: string[];     // choice
  multi?: boolean;        // choice: more than one option may be picked
  new_row?: boolean;      // episode, moment: starts a new row on Today, even if the row before has room
}

export interface Tracker {
  id: string;
  name: string;
  type: TrackerType;
  group_name: string | null; // heading the tracker is listed under; null or '' means "Other"
  color: string;          // a preset color key (COLORS), or a custom "#rrggbb"
  config: TrackerConfig;
  sort_order: number;
  archived: boolean;
  deleted: boolean;       // soft delete, so deletions sync; its entries are deleted with it
  updated_at?: string;    // set on every local write; replaced by the server's on sync
}

/** The preset tracker colors, each drawn with --c-<key> from styles.css (see components/color.ts). */
export const COLORS = ['indigo', 'amber', 'teal', 'rose', 'violet', 'green', 'slate', 'sky'];

/**
 * start/end: an episode began or stopped. level: severity during an episode (value, with its label in text).
 * moment: a one-tap moment. answer: a check-in answer.
 */
export const ENTRY_KINDS = ['start', 'end', 'level', 'moment', 'answer'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface Entry {
  id: string;
  tracker_id: string;
  occurred_at: string;    // ISO timestamp of when it happened
  kind: EntryKind;
  value: number | null;   // a severity level, rating level, or number
  text: string | null;    // the level's label, a chosen option, or free text
  note: string | null;
  checkin_id: string | null; // shared by the answers saved in one check-in
  deleted: boolean;          // soft delete, so deletions sync
  updated_at?: string;
}

/** Trackers and entries as components see them: a new object (same maps) after every change. */
export interface Data {
  trackers: ReadonlyMap<string, Tracker>;
  entries: ReadonlyMap<string, Entry>;
}

/* ---------- tracker types ---------- */

export const TYPE_LABELS: Record<TrackerType, string> = {
  rating: 'Rating',
  episode: 'Start / stop',
  moment: 'One-tap moment',
  number: 'Number',
  choice: 'Choices',
  text: 'Note',
};

export const TYPE_HELP: Record<TrackerType, string> = {
  rating: 'A scale you answer in a check-in, with your own wording for each level.',
  episode: 'A button you tap when something starts and again when it stops. Shown on Today, under its group.',
  moment: 'A one-tap button for something that happens at a moment. Shown on Today, under its group.',
  number: 'A number you enter in a check-in, like minutes or glasses.',
  choice: 'Options to pick from in a check-in, like activities.',
  text: 'Free text in a check-in.',
};

/** Tracker types answered in a check-in (the rest are tapped on Today). */
export const CHECKIN_TYPES: TrackerType[] = ['rating', 'number', 'choice', 'text'];

/** Starting config when a tracker is created with, or switched to, each type. */
export function defaultConfig(type: TrackerType): TrackerConfig {
  switch (type) {
    case 'rating': return { levels: ['Very low', 'Low', 'Medium', 'High', 'Very high'] };
    case 'episode': return { levels: [] };
    case 'number': return { unit: '', step: 1, min: null, max: null };
    case 'choice': return { options: [], multi: true };
    case 'moment':
    case 'text': return {};
    default: return unhandled(type, {});
  }
}

type StarterTracker = Pick<Tracker, 'name' | 'type' | 'group_name' | 'color' | 'config'>;

/**
 * Trackers created on a fresh device that isn't connected to an account: a generic place to start, to rename, change
 * or add to. One of each kind, and each in its own color (there are eight of each).
 */
export const STARTER_TRACKERS: StarterTracker[] = [
  { name: 'Mood', type: 'rating', group_name: 'Check-in', color: 'amber', config: { levels: ['Awful', 'Bad', 'Okay', 'Good', 'Great'] } },
  { name: 'Sleep', type: 'rating', group_name: 'Check-in', color: 'violet', config: { levels: ['Very poor', 'Poor', 'Okay', 'Good', 'Great'] } },
  { name: 'Water', type: 'number', group_name: 'Check-in', color: 'sky', config: { unit: 'glasses', min: 0, max: 30, step: 1 } },
  { name: 'Activities', type: 'choice', group_name: 'Check-in', color: 'green', config: { options: ['Exercise', 'Work', 'Friends', 'Family', 'Outdoors', 'Rest'], multi: true } },
  { name: 'Notes', type: 'text', group_name: 'Check-in', color: 'slate', config: {} },
  { name: 'Pain', type: 'episode', group_name: 'Symptoms', color: 'rose', config: { levels: ['Mild', 'Moderate', 'Severe'] } },
  { name: 'Fatigue', type: 'episode', group_name: 'Symptoms', color: 'indigo', config: { levels: [] } },
  { name: 'Medication', type: 'moment', group_name: 'Moments', color: 'teal', config: {} },
];

/* ---------- rows to and from IndexedDB and Supabase ---------- */

/** The Supabase tables, which are also IndexedDB stores, and what each one holds. */
export interface Tables {
  trackers: Tracker;
  entries: Entry;
}

export type Table = keyof Tables;

/** A tracker as stored, with defaults for fields that older rows lack and without server-only columns. */
export function normalizeTracker(raw: Record<string, unknown>): Tracker {
  const { user_id: _user, created_at: _created, ...tracker } = raw;
  return { ...tracker, config: tracker.config || {}, deleted: !!tracker.deleted } as Tracker;
}

export function normalizeEntry(raw: Record<string, unknown>): Entry {
  const { user_id: _user, created_at: _created, ...entry } = raw;
  // Postgres numeric can arrive as a string.
  return { ...entry, value: entry.value == null ? null : Number(entry.value) } as Entry;
}

// Rows to upload have every column, even when empty: Supabase refuses a batch whose rows have different fields.
// updated_at is left out because the server sets it.

export type UploadRow = Record<string, unknown> & { id: string };

export const trackerRow = (t: Tracker): UploadRow => ({
  id: t.id, name: t.name, type: t.type, group_name: t.group_name ?? null, color: t.color,
  config: t.config || {}, sort_order: t.sort_order || 0, archived: !!t.archived, deleted: !!t.deleted,
});

export const entryRow = (e: Entry): UploadRow => ({
  id: e.id, tracker_id: e.tracker_id, occurred_at: e.occurred_at, kind: e.kind, value: e.value ?? null,
  text: e.text ?? null, note: e.note ?? null, checkin_id: e.checkin_id ?? null, deleted: !!e.deleted,
});

/* ---------- deleting ---------- */

// A deleted tracker or entry stays as a row marked deleted, so the deletion reaches every device, but it keeps
// nothing of what it held. The triggers in schema.sql wipe the same fields on the server.

export const deletedTracker = (tracker: Tracker): Tracker =>
  ({ ...tracker, deleted: true, name: '', group_name: null, config: {} });

export const deletedEntry = (entry: Entry): Entry =>
  ({ ...entry, deleted: true, value: null, text: null, note: null });

/* ---------- entries ---------- */

/** A new entry for a tracker, timestamped now unless fields says otherwise. */
export function newEntry(trackerId: string, kind: EntryKind, fields: Partial<Entry> = {}): Entry {
  return {
    id: uuid(),
    tracker_id: trackerId,
    occurred_at: nowIso(),
    kind,
    value: null,
    text: null,
    note: null,
    checkin_id: null,
    deleted: false,
    ...fields,
  };
}

// Entries are never changed in place (an edit saves a new object), so each one's parsed time can be cached.
const timeCache = new WeakMap<Entry, number>();

/** An entry's time in ms. */
export function entryTime(entry: Entry): number {
  let time = timeCache.get(entry);
  if (time === undefined) {
    time = Date.parse(entry.occurred_at);
    timeCache.set(entry, time);
  }
  return time;
}

export const byTime = (a: Entry, b: Entry) => entryTime(a) - entryTime(b);

export const isStartOrEnd = (entry: Entry) => entry.kind === 'start' || entry.kind === 'end';

/** Entries that aren't deleted and whose tracker exists and isn't deleted. */
export const liveEntries = (data: Data) =>
  [...data.entries.values()].filter(e => !e.deleted && data.trackers.get(e.tracker_id)?.deleted === false);

/** Every day that has entries, plus today, oldest first. */
export function daysWithEntries(data: Data): string[] {
  const keys = new Set([dayKey(Date.now())]);
  for (const entry of liveEntries(data)) keys.add(dayKey(entryTime(entry)));
  return [...keys].sort();
}

/** A level's or answer's label, or its number when it has none. */
export const entryLabel = (entry: Entry) => String((entry.text || entry.value) ?? '');

/** Which check-in an answer belongs to. Answers without a check-in id are grouped by time. */
export const checkinKey = (answer: Entry) => answer.checkin_id || 'at ' + answer.occurred_at;

/** One line describing an entry, e.g. "Headache: Moderate" or "Water: 3 glasses". */
export function entryText(entry: Entry, tracker: Tracker): string {
  const name = tracker.name;
  switch (entry.kind) {
    case 'start': return `${name} started`;
    case 'end': return `${name} ended`;
    case 'moment': return name;
    case 'level': return `${name}: ${entryLabel(entry)}`;
    case 'answer': {
      if (tracker.type !== 'number') return `${name}: ${entryLabel(entry)}`;
      const unit = tracker.config.unit ? ' ' + tracker.config.unit : '';
      return `${name}: ${entry.value ?? ''}${unit}`;
    }
    default: return unhandled(entry.kind, name);
  }
}

/* ---------- trackers ---------- */

const inDisplayOrder = (a: Tracker, b: Tracker) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);

/** Every tracker that isn't deleted, archived ones included, in display order. */
export const allTrackers = (data: Data) =>
  [...data.trackers.values()].filter(t => !t.deleted).sort(inDisplayOrder);

/** Trackers in use (not archived), in display order: those of the given types, or all of them. */
export const activeTrackers = (data: Data, ...types: TrackerType[]) =>
  allTrackers(data).filter(t => !t.archived && (!types.length || types.includes(t.type)));

export const groupName = (tracker: Tracker) => tracker.group_name || 'Other';

/** [heading, trackers] pairs, in order of each heading's first tracker. */
export const groupTrackers = (trackers: Tracker[]) => [...groupBy(trackers, groupName)];

/** A blank tracker, in a color that keeps it easy to tell apart from the others (see freshColor). */
export const newTracker = (data: Data, type: TrackerType = 'episode', group = ''): Tracker => ({
  id: uuid(), name: '', type, group_name: group, color: freshColor(data, group),
  config: defaultConfig(type), sort_order: 0, archived: false, deleted: false,
});

/** The color fewest trackers under this heading have (they sit side by side), then fewest of all trackers. */
function freshColor(data: Data, group: string): string {
  const trackers = activeTrackers(data);
  const uses = (color: string) => [
    trackers.filter(t => t.color === color && (t.group_name || '') === group).length,
    trackers.filter(t => t.color === color).length,
  ];
  const fewer = (a: string, b: string) => {
    const [[groupA, allA], [groupB, allB]] = [uses(a), uses(b)];
    return groupA < groupB || (groupA === groupB && allA < allB);
  };
  return COLORS.reduce((best, color) => (fewer(color, best) ? color : best));
}

/** The label of a rating or severity level (1-based), or null if the tracker has none for it. */
export const levelLabel = (tracker: Tracker, level: number) => (tracker.config.levels || [])[level - 1] || null;

/** Why a tracker can't be saved, or null if it can. */
export function trackerProblem(tracker: Pick<Tracker, 'name' | 'type' | 'config'>): string | null {
  const levels = tracker.config.levels || [];
  if (!tracker.name) return 'Give the tracker a name.';
  if (tracker.type === 'rating' && (levels.length < 2 || levels.length > 10)) return 'A rating needs 2 to 10 levels.';
  if (tracker.type === 'episode' && levels.length > 10) return 'Use at most 10 severity levels.';
  if (tracker.type === 'choice' && !(tracker.config.options || []).length) return 'Add at least one option.';
  return null;
}

/* ---------- episodes ---------- */

/** A stretch of a start/stop tracker: from a start to the tracker's next start or end. */
export interface Episode {
  id: string;             // the start entry's id
  trackerId: string;
  start: number;
  end: number;            // now, for one that's still running
  endEntryId?: string;    // the end entry, if it has one
  // ended: closed by an end entry; restarted: closed by a later start without an end in between;
  // ongoing: still running.
  status: 'ended' | 'restarted' | 'ongoing';
}

/** Every episode, oldest first. */
export function allEpisodes(data: Data): Episode[] {
  const episodes: Episode[] = [];
  const openStarts = new Map<string, Entry>(); // tracker id -> its start without an end yet
  const close = (start: Entry, end: number, status: Episode['status'], endEntryId?: string) =>
    episodes.push({ id: start.id, trackerId: start.tracker_id, start: entryTime(start), end, status, endEntryId });

  for (const e of liveEntries(data).filter(isStartOrEnd).sort(byTime)) {
    const openStart = openStarts.get(e.tracker_id);
    if (e.kind === 'start') {
      if (openStart) close(openStart, entryTime(e), 'restarted');
      openStarts.set(e.tracker_id, e);
    } else if (openStart) {
      close(openStart, entryTime(e), 'ended', e.id);
      openStarts.delete(e.tracker_id);
    } // an end with no start before it ends nothing
  }
  for (const start of openStarts.values()) close(start, Date.now(), 'ongoing');
  return episodes.sort((a, b) => a.start - b.start);
}

/** The notes on an episode's start and end. */
export const episodeNotes = (data: Data, episode: Episode) =>
  [episode.id, episode.endEntryId].map(id => (id ? data.entries.get(id)?.note : null)).filter((note): note is string => !!note);

export interface RunningEpisode {
  since: number;
  level: number | null;   // the latest severity logged since it started
  label: string | null;
}

/** The episodes running now, by tracker id, oldest first. Archived trackers are left out. */
export function runningEpisodes(data: Data): Map<string, RunningEpisode> {
  const running = new Map<string, RunningEpisode>();
  for (const episode of allEpisodes(data)) {
    if (episode.status === 'ongoing' && !data.trackers.get(episode.trackerId)!.archived) {
      running.set(episode.trackerId, { since: episode.start, level: null, label: null });
    }
  }
  for (const level of liveEntries(data).filter(e => e.kind === 'level').sort(byTime)) {
    const episode = running.get(level.tracker_id);
    if (episode && entryTime(level) >= episode.since) {
      episode.level = level.value;
      episode.label = level.text;
    }
  }
  return running;
}

/* ---------- days ---------- */

/** What a tracker adds up to on a day. */
export interface TrackerTotal {
  count: number; // episodes started that day, or moments logged
  ms: number;    // how long its episodes ran within the day
}

/** What a day adds up to: each tracker's total, by tracker id, and how many check-ins. */
export interface DayTotals {
  trackers: Map<string, TrackerTotal>;
  checkins: number;
}

/**
 * What a day adds up to, from the entries logged in it and the episodes that ran during it. An episode counts on
 * the day it started, and its time is split at midnight between the days it ran on. The day's totals on Today and
 * the export's daily table both come from here, so they agree.
 */
export function dayTotals(day: DayBounds, entries: Entry[], episodes: Episode[]): DayTotals {
  const trackers = new Map<string, TrackerTotal>();
  const add = (trackerId: string, count: number, ms: number) => {
    const total = trackers.get(trackerId) ?? { count: 0, ms: 0 };
    trackers.set(trackerId, { count: total.count + count, ms: total.ms + ms });
  };
  for (const episode of episodes) {
    const ms = Math.min(episode.end, day.to) - Math.max(episode.start, day.from);
    if (ms >= 0) add(episode.trackerId, episode.start >= day.from && episode.start < day.to ? 1 : 0, ms);
  }
  for (const entry of entries) if (entry.kind === 'moment') add(entry.tracker_id, 1, 0);
  return { trackers, checkins: new Set(entries.filter(e => e.kind === 'answer').map(checkinKey)).size };
}
