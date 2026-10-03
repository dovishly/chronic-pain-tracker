// The tracker/entry model: types, constants, and data derived from entries.
// Field names on trackers and entries match the Supabase columns (see schema.sql and CLAUDE.md).
import { dayKey, nowIso, uuid } from './util';

/* ---------- types ---------- */

export type TrackerType = 'rating' | 'episode' | 'moment' | 'number' | 'choice' | 'text';

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
  grp: string | null;     // group heading; null or '' means "Other"
  color: string;          // one of COLORS
  config: TrackerConfig;
  sort: number;
  archived: boolean;
  updated_at?: string;    // set on every local write; replaced by the server's on sync
}

/**
 * start/end: an episode began or stopped. level: severity during an episode (num + label in txt).
 * moment: a one-tap moment. value: a check-in answer.
 */
export type EntryKind = 'start' | 'end' | 'level' | 'moment' | 'value';

export interface Entry {
  id: string;
  tracker_id: string;
  ts: string;             // ISO timestamp of when it happened
  kind: EntryKind;
  num: number | null;
  txt: string | null;
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

/** CSS value for a tracker's color; unknown keys fall back to slate. */
export const colorVar = (color: string) => `var(--c-${COLORS.includes(color) ? color : 'slate'})`;

/** Starting config when a tracker is created with, or switched to, each type. */
export function defaultConfig(type: TrackerType): TrackerConfig {
  switch (type) {
    case 'rating': return { levels: ['Very low', 'Low', 'Medium', 'High', 'Very high'] };
    case 'episode': return { levels: [] };
    case 'number': return { unit: '', step: 1, min: null, max: null };
    case 'choice': return { options: [], multi: true };
    default: return {};
  }
}

type StarterTracker = Pick<Tracker, 'name' | 'type' | 'grp' | 'color' | 'config'>;

/** Generic trackers created on a fresh device that isn't connected to an account. */
export const STARTER_TRACKERS: StarterTracker[] = [
  { name: 'Mood', type: 'rating', grp: 'Check-in', color: 'indigo', config: { levels: ['Awful', 'Bad', 'Okay', 'Good', 'Great'] } },
  { name: 'Energy', type: 'rating', grp: 'Check-in', color: 'amber', config: { levels: ['Very low', 'Low', 'Okay', 'Good', 'High'] } },
  { name: 'Stress', type: 'rating', grp: 'Check-in', color: 'rose', config: { levels: ['None', 'Low', 'Moderate', 'High', 'Overwhelmed'] } },
  { name: 'Sleep quality', type: 'rating', grp: 'Check-in', color: 'violet', config: { levels: ['Very poor', 'Poor', 'Okay', 'Good', 'Great'] } },
  { name: 'Water', type: 'number', grp: 'Check-in', color: 'sky', config: { unit: 'glasses', min: 0, max: 30, step: 1 } },
  { name: 'Activities', type: 'choice', grp: 'Check-in', color: 'green', config: { options: ['Exercise', 'Work', 'Friends', 'Family', 'Outdoors', 'Reading', 'Rest'], multi: true } },
  { name: 'Journal', type: 'text', grp: 'Check-in', color: 'slate', config: {} },
  { name: 'Tired', type: 'episode', grp: 'Symptoms', color: 'indigo', config: { levels: [] } },
  { name: 'Headache', type: 'episode', grp: 'Symptoms', color: 'amber', config: { levels: ['Mild', 'Moderate', 'Severe'] } },
  { name: 'Pain', type: 'episode', grp: 'Symptoms', color: 'amber', config: { levels: ['Mild', 'Moderate', 'Severe'] } },
  { name: 'Anxious', type: 'episode', grp: 'Symptoms', color: 'teal', config: { levels: [] } },
  { name: 'Low mood', type: 'episode', grp: 'Symptoms', color: 'teal', config: { levels: [] } },
  { name: 'Medication', type: 'moment', grp: 'Moments', color: 'violet', config: {} },
  { name: 'Coffee', type: 'moment', grp: 'Moments', color: 'amber', config: {} },
  { name: 'Meal', type: 'moment', grp: 'Moments', color: 'green', config: {} },
];

/* ---------- entries ---------- */

/** A new entry for a tracker, timestamped now unless fields says otherwise. */
export function newEntry(trackerId: string, kind: EntryKind, fields: Partial<Entry> = {}): Entry {
  return {
    id: uuid(),
    tracker_id: trackerId,
    ts: nowIso(),
    kind,
    num: null,
    txt: null,
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
    time = Date.parse(entry.ts);
    timeCache.set(entry, time);
  }
  return time;
}

export const byTime = (a: Entry, b: Entry) => entryTime(a) - entryTime(b);

/** Entries that aren't deleted and whose tracker still exists. */
export const liveEntries = (data: Data) =>
  [...data.entries.values()].filter(e => !e.deleted && data.trackers.has(e.tracker_id));

/** Every day that has entries, plus today, oldest first. */
export function daysWithEntries(data: Data): string[] {
  const keys = new Set([dayKey(Date.now())]);
  for (const entry of liveEntries(data)) keys.add(dayKey(entryTime(entry)));
  return [...keys].sort();
}

/** One line describing an entry, e.g. "Headache: Moderate" or "Water: 3 glasses". */
export function entryText(entry: Entry, tracker: Tracker): string {
  const name = tracker.name;
  switch (entry.kind) {
    case 'start': return `${name} started`;
    case 'end': return `${name} ended`;
    case 'moment': return name;
  }
  // A severity level or a check-in answer.
  if (entry.kind === 'value' && tracker.type === 'number') {
    const unit = tracker.config.unit ? ' ' + tracker.config.unit : '';
    return `${name}: ${entry.num ?? ''}${unit}`;
  }
  return `${name}: ${(entry.txt || entry.num) ?? ''}`;
}

/* ---------- trackers ---------- */

/**
 * Trackers in display order, limited to the given type or list of types (null for all).
 * Archived trackers are left out unless includeArchived is set.
 */
export function sortedTrackers(
  data: Data,
  types: TrackerType | TrackerType[] | null = null,
  { includeArchived = false } = {},
): Tracker[] {
  const wanted = types == null ? null : ([] as TrackerType[]).concat(types);
  return [...data.trackers.values()]
    .filter(t => (!wanted || wanted.includes(t.type)) && (includeArchived || !t.archived))
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

export const groupName = (tracker: Tracker) => tracker.grp || 'Other';

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
  trackerId: string;
  start: number;
  end: number;            // "now" for an episode that's still running
  endEntryId?: string;
  live?: boolean;         // still running
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
      active[id].level = e.num;
      active[id].label = e.txt;
    }
  }
  for (const id of Object.keys(active)) {
    const tracker = data.trackers.get(id);
    if (!tracker || tracker.archived) delete active[id];
  }
  return active;
}

/**
 * Every start/stop episode. A second start without an end in between
 * closes the earlier episode at that point.
 */
export function allEpisodes(data: Data): Episode[] {
  const episodes: Episode[] = [];
  const openStarts: Record<string, Entry> = {}; // trackerId -> its unmatched start entry
  for (const e of liveEntries(data).filter(isEpisodeEvent).sort(byTime)) {
    const id = e.tracker_id;
    const openStart = openStarts[id];
    if (e.kind === 'start') {
      if (openStart) episodes.push({ trackerId: id, start: entryTime(openStart), end: entryTime(e) });
      openStarts[id] = e;
    } else if (openStart) {
      episodes.push({ trackerId: id, start: entryTime(openStart), end: entryTime(e), endEntryId: e.id });
      delete openStarts[id];
    }
  }
  for (const [id, startEntry] of Object.entries(openStarts)) {
    episodes.push({ trackerId: id, start: entryTime(startEntry), end: Date.now(), live: true });
  }
  return episodes;
}

/** Episodes keyed by the id of their end entry, for showing durations next to "ended" entries. */
export function episodesByEndEntry(data: Data): Record<string, Episode> {
  const byEnd: Record<string, Episode> = {};
  for (const episode of allEpisodes(data)) {
    if (episode.endEntryId) byEnd[episode.endEntryId] = episode;
  }
  return byEnd;
}
