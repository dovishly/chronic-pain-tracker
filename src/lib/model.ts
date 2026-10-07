// Field names on trackers and entries are the Supabase column names.
import { dayKey, nowIso, uuid, unhandled } from './util';

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
}

export interface Tracker {
  id: string;
  name: string;
  type: TrackerType;
  group_name: string | null; // heading the tracker is listed under; null or '' means "Other"
  color: string;          // one of COLORS, or a custom "#rrggbb"
  config: TrackerConfig;
  sort_order: number;
  archived: boolean;
  deleted: boolean;       // soft delete, so deletions sync; its entries are deleted with it
  updated_at?: string;    // set on every local write; replaced by the server's on sync
}

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

/** Trackers and entries as the UI sees them. A new object (same maps) after every change. */
export interface Data {
  trackers: ReadonlyMap<string, Tracker>;
  entries: ReadonlyMap<string, Entry>;
}

/* ---------- constants ---------- */

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
  episode: 'A button you tap when something starts and again when it stops. Shown on Today.',
  moment: 'A one-tap button for something that happens at a moment. Shown on Today.',
  number: 'A number you enter in a check-in, like minutes or glasses.',
  choice: 'Options to pick from in a check-in, like activities.',
  text: 'Free text in a check-in.',
};

/** Tracker types answered in a check-in (the rest are tapped on Today). */
export const CHECKIN_TYPES: TrackerType[] = ['rating', 'number', 'choice', 'text'];

/** Color keys; each maps to a CSS variable --c-<key> in styles.css. */
export const COLORS = ['indigo', 'amber', 'teal', 'rose', 'violet', 'green', 'slate', 'sky'];

/** A color picked with the custom color picker, rather than one of COLORS. */
export const isCustomColor = (color: string) => /^#[0-9a-f]{6}$/i.test(color);

/** CSS value for a tracker's color; unknown keys fall back to slate. */
export const colorVar = (color: string) =>
  isCustomColor(color) ? color : `var(--c-${COLORS.includes(color) ? color : 'slate'})`;

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

/** Generic trackers created on a fresh device that isn't connected to an account. */
export const STARTER_TRACKERS: StarterTracker[] = [
  { name: 'Mood', type: 'rating', group_name: 'Check-in', color: 'indigo', config: { levels: ['Awful', 'Bad', 'Okay', 'Good', 'Great'] } },
  { name: 'Energy', type: 'rating', group_name: 'Check-in', color: 'amber', config: { levels: ['Very low', 'Low', 'Okay', 'Good', 'High'] } },
  { name: 'Stress', type: 'rating', group_name: 'Check-in', color: 'rose', config: { levels: ['None', 'Low', 'Moderate', 'High', 'Overwhelmed'] } },
  { name: 'Sleep quality', type: 'rating', group_name: 'Check-in', color: 'violet', config: { levels: ['Very poor', 'Poor', 'Okay', 'Good', 'Great'] } },
  { name: 'Water', type: 'number', group_name: 'Check-in', color: 'sky', config: { unit: 'glasses', min: 0, max: 30, step: 1 } },
  { name: 'Activities', type: 'choice', group_name: 'Check-in', color: 'green', config: { options: ['Exercise', 'Work', 'Friends', 'Family', 'Outdoors', 'Reading', 'Rest'], multi: true } },
  { name: 'Journal', type: 'text', group_name: 'Check-in', color: 'slate', config: {} },
  { name: 'Tired', type: 'episode', group_name: 'Symptoms', color: 'indigo', config: { levels: [] } },
  { name: 'Headache', type: 'episode', group_name: 'Symptoms', color: 'amber', config: { levels: ['Mild', 'Moderate', 'Severe'] } },
  { name: 'Pain', type: 'episode', group_name: 'Symptoms', color: 'amber', config: { levels: ['Mild', 'Moderate', 'Severe'] } },
  { name: 'Anxious', type: 'episode', group_name: 'Symptoms', color: 'teal', config: { levels: [] } },
  { name: 'Low mood', type: 'episode', group_name: 'Symptoms', color: 'teal', config: { levels: [] } },
  { name: 'Medication', type: 'moment', group_name: 'Moments', color: 'violet', config: {} },
  { name: 'Coffee', type: 'moment', group_name: 'Moments', color: 'amber', config: {} },
  { name: 'Meal', type: 'moment', group_name: 'Moments', color: 'green', config: {} },
];

/* ---------- data from storage or the server ---------- */

/** Fills in defaults for a tracker from IndexedDB or Supabase: older rows may lack newer fields. */
export function normalizeTracker(raw: Record<string, unknown>): Tracker {
  const { user_id: _user, created_at: _created, ...tracker } = raw; // server-only columns
  return { ...tracker, config: tracker.config || {}, deleted: !!tracker.deleted } as Tracker;
}

export function normalizeEntry(raw: Record<string, unknown>): Entry {
  const { user_id: _user, created_at: _created, ...entry } = raw;
  // Postgres numeric can arrive as a string.
  return { ...entry, value: entry.value == null ? null : Number(entry.value) } as Entry;
}

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

// Entries are never changed in place (edits save a new object), so each one's parsed time can be cached.
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

/** Trackers in display order, of the given types (null for all). */
export function sortedTrackers(
  data: Data,
  types: TrackerType | TrackerType[] | null = null,
  { includeArchived = false } = {},
): Tracker[] {
  const wanted = types == null ? null : ([] as TrackerType[]).concat(types);
  return [...data.trackers.values()]
    .filter(t => !t.deleted && (!wanted || wanted.includes(t.type)) && (includeArchived || !t.archived))
    .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
}

export const groupName = (tracker: Tracker) => tracker.group_name || 'Other';

/** The label of a rating or severity level (1-based), or null if the tracker has none for it. */
export const levelLabel = (tracker: Tracker, level: number) => (tracker.config.levels || [])[level - 1] || null;

/** [groupName, trackers] pairs, groups in order of first appearance. */
export function groupTrackers(trackers: Tracker[]): [string, Tracker[]][] {
  const groups = new Map<string, Tracker[]>();
  for (const tracker of trackers) {
    const name = groupName(tracker);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(tracker);
  }
  return [...groups];
}

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

export interface ActiveEpisode {
  since: number;
  level: number | null;   // latest severity logged during the episode
  label: string | null;
}

export interface Episode {
  id: string;             // the start entry's id
  trackerId: string;
  start: number;
  end: number;            // "now" for an episode that's still running
  endEntryId?: string;
  // ended: closed by an end entry; restarted: closed by a later start without an end in between;
  // ongoing: still running.
  status: 'ended' | 'restarted' | 'ongoing';
}

const isEpisodeEvent = (e: Entry) => e.kind === 'start' || e.kind === 'end';

/** Episodes running right now, keyed by tracker id. Archived trackers are left out. */
export function activeEpisodes(data: Data): Record<string, ActiveEpisode> {
  const active: Record<string, ActiveEpisode> = {};
  const events = liveEntries(data).filter(e => isEpisodeEvent(e) || e.kind === 'level').sort(byTime);
  for (const e of events) {
    const id = e.tracker_id;
    if (e.kind === 'start') {
      active[id] = { since: entryTime(e), level: null, label: null };
    } else if (e.kind === 'end') {
      delete active[id];
    } else if (active[id]) {
      active[id].level = e.value;
      active[id].label = e.text;
    }
  }
  for (const id of Object.keys(active)) {
    const tracker = data.trackers.get(id);
    if (!tracker || tracker.archived || tracker.deleted) delete active[id];
  }
  return active;
}

/**
 * Every start/stop episode, oldest first. A second start without an end in between
 * closes the earlier episode at that point.
 */
export function allEpisodes(data: Data): Episode[] {
  const episodes: Episode[] = [];
  const openStarts: Record<string, Entry> = {}; // trackerId -> its unmatched start entry
  const close = (startEntry: Entry, end: number, status: Episode['status'], endEntryId?: string) =>
    episodes.push({ id: startEntry.id, trackerId: startEntry.tracker_id, start: entryTime(startEntry), end, status, endEntryId });

  for (const e of liveEntries(data).filter(isEpisodeEvent).sort(byTime)) {
    const openStart = openStarts[e.tracker_id];
    if (e.kind === 'start') {
      if (openStart) close(openStart, entryTime(e), 'restarted');
      openStarts[e.tracker_id] = e;
    } else if (openStart) {
      close(openStart, entryTime(e), 'ended', e.id);
      delete openStarts[e.tracker_id];
    }
  }
  for (const startEntry of Object.values(openStarts)) close(startEntry, Date.now(), 'ongoing');
  return episodes.sort((a, b) => a.start - b.start);
}
