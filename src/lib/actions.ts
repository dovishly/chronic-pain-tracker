// What the person does that changes data. Each action saves through store.ts and says what it did in a
// toast. Wrapped in safely(), so a failure shows a toast too and components call them without try/catch.
import { MINUTE_MS, clockTime, formatTime, formatDuration, uuid, unhandled } from './util';
import { dataStore } from './data';
import {
  CHECKIN_TYPES, activeTrackers, allEpisodes, byTime, deletedEntry, deletedTracker, entryTime, groupName, isStartOrEnd,
  levelLabel, newEntry, runningEpisodes, type Entry, type EntryKind, type Episode, type Tracker,
} from './model';
import { addStarterTrackers, eraseDevice, saveEntries, saveTrackers } from './store';
import { sync } from './sync';
import { toast, safely } from './toast';

const data = () => dataStore.get();
const trackerById = (id: string) => data().trackers.get(id)!;

/* ---------- logging ---------- */

async function addEntry(trackerId: string, kind: EntryKind, fields?: Partial<Entry>): Promise<Entry> {
  const entry = newEntry(trackerId, kind, fields);
  await saveEntries([entry]);
  return entry;
}

export const toggleEpisode = safely(async (trackerId: string) => {
  const tracker = trackerById(trackerId);
  const running = runningEpisodes(data()).get(trackerId);
  if (running) {
    const end = await addEntry(trackerId, 'end');
    toast(`${tracker.name} ended · ${formatDuration(entryTime(end) - running.since)}`, end.id);
  } else {
    const start = await addEntry(trackerId, 'start');
    toast(`${tracker.name} started ${formatTime(entryTime(start))}`, start.id);
  }
});

/** level is 1-based. */
export const logLevel = safely(async (trackerId: string, level: number) => {
  const tracker = trackerById(trackerId);
  const label = levelLabel(tracker, level) ?? String(level);
  const entry = await addEntry(trackerId, 'level', { value: level, text: label });
  toast(`${tracker.name}: ${label}`, entry.id);
});

/** Starts an episode at a level (1-based), in one tap: a start and a level at the same moment. */
export const startAtLevel = safely(async (trackerId: string, level: number) => {
  const tracker = trackerById(trackerId);
  const label = levelLabel(tracker, level) ?? String(level);
  const start = newEntry(trackerId, 'start');
  await saveEntries([start, newEntry(trackerId, 'level', { value: level, text: label, occurred_at: start.occurred_at })]);
  toast(`${tracker.name} started ${formatTime(entryTime(start))} · ${label}`, start.id);
});

/** Levels logged at the very moment a start was (by startAtLevel): they go with it when it's moved or undone. */
function levelsAtStart(start: Entry): Entry[] {
  if (start.kind !== 'start') return [];
  return [...data().entries.values()].filter(e =>
    e.kind === 'level' && !e.deleted && e.tracker_id === start.tracker_id && e.occurred_at === start.occurred_at);
}

export const logMoment = safely(async (trackerId: string) => {
  const tracker = trackerById(trackerId);
  const entry = await addEntry(trackerId, 'moment');
  toast(`${tracker.name} at ${formatTime(entryTime(entry))}`, entry.id);
});

/* ---------- changing what was logged ---------- */

// A tracker's starts and ends pair up in time order, each start with the next start or end (allEpisodes).
// So no change may move one past another of the same tracker: an episode would swallow another, or lose its end.

/** The ids of a tracker's starts and ends, in time order. */
function startsAndEnds(entries: Iterable<Entry>, trackerId: string): string {
  return [...entries]
    .filter(e => e.tracker_id === trackerId && isStartOrEnd(e) && !e.deleted)
    .sort(byTime)
    .map(e => e.id)
    .join();
}

/** Whether saving these changed entries (all of one tracker) would pair its starts and ends up differently. */
function reordersEpisodes(changed: Entry[]): boolean {
  const trackerId = changed[0].tracker_id;
  const after = new Map(data().entries);
  for (const entry of changed) after.set(entry.id, entry);
  return startsAndEnds(after.values(), trackerId) !== startsAndEnds(data().entries.values(), trackerId);
}

const overlapMessage = (trackerId: string) => `That would overlap another ${trackerById(trackerId).name}.`;

/** The entry at "HH:MM" on its own day. "" or the time it already has keeps it to the second. */
function atTime(entry: Entry, time: string): Entry {
  if (!time || time === clockTime(entryTime(entry))) return entry;
  const [hours, minutes] = time.split(':').map(Number);
  const when = new Date(entryTime(entry));
  when.setHours(hours, minutes, 0, 0);
  return { ...entry, occurred_at: when.toISOString() };
}

/** The toast's −5 and −15 min. An episode's end moved back to its start or before takes the whole episode along. */
export const moveEntryEarlier = safely(async (id: string, minutes: number) => {
  const entry = data().entries.get(id);
  if (!entry) return;
  const earlier = (e: Entry) => ({ ...e, occurred_at: new Date(entryTime(e) - minutes * MINUTE_MS).toISOString() });
  let moved = [earlier(entry)];
  const episode = entry.kind === 'end' ? allEpisodes(data()).find(e => e.endEntryId === id) : undefined;
  if (episode && entryTime(moved[0]) <= episode.start) moved = [earlier(data().entries.get(episode.id)!), moved[0]];

  if (reordersEpisodes(moved)) {
    toast(overlapMessage(entry.tracker_id), id);
    return;
  }
  await saveEntries([...moved, ...levelsAtStart(entry).map(earlier)]);
  const [from, to] = moved.map(entryTime);
  const name = trackerById(entry.tracker_id).name;
  toast(moved.length === 1 ? `Moved to ${formatTime(from)}` : `Moved ${name} to ${formatTime(from)}–${formatTime(to)}`, id);
});

/** An entry's time ("HH:MM" on its own day, or "" to keep it) and note. Returns whether it saved. */
export const editEntry = safely(async (id: string, time: string, note: string) => {
  const entry = data().entries.get(id);
  if (!entry) return false;
  const edited = { ...atTime(entry, time), note: note.trim() || null };
  if (reordersEpisodes([edited])) {
    toast(overlapMessage(entry.tracker_id));
    return false;
  }
  await saveEntries([edited]);
  return true;
});

/**
 * An episode's start and end times ("HH:MM", each on its own day) and its note. The note is kept on the start;
 * the editor also shows an end's note (say, from another phone), so saving moves that to the start.
 * Returns whether it saved.
 */
export const editEpisode = safely(async (episode: Episode, startTime: string, endTime: string, note: string) => {
  const start = { ...atTime(data().entries.get(episode.id)!, startTime), note: note.trim() || null };
  const end = episode.endEntryId ? { ...atTime(data().entries.get(episode.endEntryId)!, endTime), note: null } : null;
  if (end && entryTime(end) <= entryTime(start)) {
    toast('The end has to be after the start.');
    return false;
  }
  const changed = end ? [start, end] : [start];
  if (reordersEpisodes(changed)) {
    toast(overlapMessage(episode.trackerId));
    return false;
  }
  await saveEntries(changed);
  return true;
});

export const deleteEntry = safely(async (id: string, message: string) => {
  const entry = data().entries.get(id);
  if (entry) await saveEntries([entry, ...levelsAtStart(entry)].map(deletedEntry));
  toast(message);
});

/** Deletes an episode: its start, its end if it has one, and the levels logged while it lasted. */
export const deleteEpisode = safely(async (episode: Episode) => {
  const ids = episode.endEntryId ? [episode.id, episode.endEntryId] : [episode.id];
  const levels = [...data().entries.values()].filter(e =>
    e.kind === 'level' && !e.deleted && e.tracker_id === episode.trackerId
    && entryTime(e) >= episode.start && entryTime(e) <= episode.end);
  await saveEntries([...ids.map(id => data().entries.get(id)!), ...levels].map(deletedEntry));
  toast('Deleted');
});

/* ---------- check-in ---------- */

/** A check-in answer as the form holds it: a rating level, a number as typed, the picked options, or text. */
export type Answer = number | string | string[] | null;

/**
 * Saves each answer as an entry, all sharing one checkin_id. when is a datetime-local value ("" for now).
 * Returns the check-in's time, or null if nothing was answered.
 */
export const saveCheckin = safely(async (answers: Record<string, Answer>, when: string): Promise<number | null> => {
  const time = when ? new Date(when).getTime() : Date.now();
  const shared = { occurred_at: new Date(time).toISOString(), checkin_id: uuid() };
  const saved: Entry[] = [];
  let answered = 0;
  for (const tracker of activeTrackers(data(), ...CHECKIN_TYPES)) {
    const fields = answerFields(tracker, answers[tracker.id] ?? null);
    if (fields.length) answered++;
    saved.push(...fields.map(f => newEntry(tracker.id, 'answer', { ...shared, ...f })));
  }

  if (!answered) {
    toast('Nothing to save yet. Answer at least one question.');
    return null;
  }
  await saveEntries(saved);
  toast(`Check-in saved · ${answered} ${answered === 1 ? 'answer' : 'answers'}`);
  return time;
});

/** What an answer is saved as: one entry's fields, one per picked option, or none if it was left blank. */
function answerFields(tracker: Tracker, answer: Answer): Partial<Entry>[] {
  if (answer == null || answer === '' || (Array.isArray(answer) && !answer.length)) return [];
  switch (tracker.type) {
    case 'rating': {
      const level = Number(answer);
      return [{ value: level, text: levelLabel(tracker, level) }];
    }
    case 'number': return [{ value: Number(answer) }];
    case 'text': return [{ text: String(answer) }];
    case 'choice': return [answer].flat().map(option => ({ text: String(option) }));
    case 'episode':
    case 'moment': return []; // not check-in questions
    default: return unhandled(tracker.type, []);
  }
}

/* ---------- trackers ---------- */

/** Saves a tracker from the editor. A new one goes to the end of the list. */
export const saveTrackerEdit = safely(async (tracker: Tracker) => {
  const isNew = !data().trackers.has(tracker.id);
  const lastSortOrder = Math.max(0, ...[...data().trackers.values()].map(t => t.sort_order || 0));
  await saveTrackers([isNew ? { ...tracker, sort_order: lastSortOrder + 10 } : tracker]);
  toast(`Saved ${tracker.name}`);
  return true;
});

export const archiveTracker = safely(async (id: string) => {
  const tracker = trackerById(id);
  await saveTrackers([{ ...tracker, archived: true }]);
  toast(`Archived ${tracker.name}. Its entries are kept.`);
  return true;
});

export const restoreTracker = safely(async (id: string) => {
  await saveTrackers([{ ...trackerById(id), archived: false }]);
});

/** Deletes a tracker and all its entries, here and on every device it syncs to. */
export const deleteTracker = safely(async (id: string) => {
  const tracker = trackerById(id);
  await saveTrackers([deletedTracker(tracker)]);
  const itsEntries = [...data().entries.values()].filter(e => e.tracker_id === id && !e.deleted);
  await saveEntries(itsEntries.map(deletedEntry));
  toast(`Deleted ${tracker.name}`);
  return true;
});

/** Swaps a tracker with its neighbor in the same group: direction -1 moves it up, 1 down. */
export const moveTracker = safely(async (id: string, direction: -1 | 1) => {
  const tracker = trackerById(id);
  const sameGroup = activeTrackers(data()).filter(t => groupName(t) === groupName(tracker));
  const neighbor = sameGroup[sameGroup.findIndex(t => t.id === id) + direction];
  if (!neighbor) return;
  // With equal sort orders a plain swap would change nothing, so step past the neighbor instead.
  const newSortOrder = neighbor.sort_order === tracker.sort_order ? neighbor.sort_order + direction : neighbor.sort_order;
  await saveTrackers([{ ...tracker, sort_order: newSortOrder }, { ...neighbor, sort_order: tracker.sort_order }]);
});

/* ---------- starting over ---------- */

/** Erases this phone's data and connection, then reopens with the starter trackers. Supabase is left as it is. */
export const resetDevice = safely(async () => {
  await sync.disconnect();
  await eraseDevice();
  location.reload();
});

/** Deletes everything in the account and on this phone, and starts again with the starter trackers. */
export const resetEverywhere = safely(async () => {
  await sync.deleteAccountData();
  const { trackers, entries } = data();
  await saveTrackers([...trackers.values()].filter(t => !t.deleted).map(deletedTracker));
  await saveEntries([...entries.values()].filter(e => !e.deleted).map(deletedEntry));
  await addStarterTrackers();
  toast('Everything was reset. Your other devices catch up when they next sync.');
  return true;
});
