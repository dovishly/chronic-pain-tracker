import { MINUTE_MS, formatTime, formatDuration, uuid, unhandled } from './util';
import { dataStore } from './data';
import {
  CHECKIN_TYPES, newEntry, entryTime, sortedTrackers, groupName, levelLabel, activeEpisodes, allEpisodes, liveEntries,
  type Entry, type EntryKind, type Tracker,
} from './model';
import { addStarterTrackers, eraseDevice, saveEntries, saveEntry, saveTracker } from './store';
import { sync } from './sync';
import { toast, safely } from './toast';

const data = () => dataStore.get();
const trackerById = (id: string) => data().trackers.get(id)!;

/* ---------- entries ---------- */

async function addEntry(trackerId: string, kind: EntryKind, fields?: Partial<Entry>): Promise<Entry> {
  const entry = newEntry(trackerId, kind, fields);
  await saveEntry(entry);
  return entry;
}

/** Saves a changed copy of an entry. */
async function changeEntry(id: string, changes: Partial<Entry>): Promise<void> {
  const entry = data().entries.get(id);
  if (entry) await saveEntry({ ...entry, ...changes });
}

export const toggleEpisode = safely(async (trackerId: string) => {
  const tracker = trackerById(trackerId);
  const running = activeEpisodes(data())[trackerId];
  if (running) {
    const entry = await addEntry(trackerId, 'end');
    toast(`${tracker.name} ended · ${formatDuration(entryTime(entry) - running.since)}`, entry.id);
  } else {
    const entry = await addEntry(trackerId, 'start');
    toast(`${tracker.name} started ${formatTime(entryTime(entry))}`, entry.id);
  }
});

/** level is 1-based. */
export const logLevel = safely(async (trackerId: string, level: number) => {
  const tracker = trackerById(trackerId);
  const label = levelLabel(tracker, level) ?? String(level);
  const entry = await addEntry(trackerId, 'level', { value: level, text: label });
  toast(`${tracker.name}: ${label}`, entry.id);
});

export const logMoment = safely(async (trackerId: string) => {
  const tracker = trackerById(trackerId);
  const entry = await addEntry(trackerId, 'moment');
  toast(`${tracker.name} at ${formatTime(entryTime(entry))}`, entry.id);
});

const movedBy = (entry: Entry, ms: number): Entry => ({ ...entry, occurred_at: new Date(entryTime(entry) - ms).toISOString() });

/**
 * True if an episode spanning start to end (null: still going) would take in another start or end of the
 * same tracker, which would pair them up differently. ids are the episode's own start and end.
 */
function overlapsAnother(trackerId: string, ids: (string | undefined)[], start: number, end: number | null): boolean {
  return liveEntries(data()).some(e => e.tracker_id === trackerId && (e.kind === 'start' || e.kind === 'end')
    && !ids.includes(e.id) && entryTime(e) >= start && (end === null || entryTime(e) < end));
}

/**
 * The toast's −5 and −15 min. An episode's end that would land before its start moves the whole episode
 * instead; a move that would overlap another episode of the same tracker is refused.
 */
export const moveEntryEarlier = safely(async (id: string, minutes: number) => {
  const entry = data().entries.get(id);
  if (!entry) return;
  const ms = minutes * MINUTE_MS;
  let moved = [movedBy(entry, ms)];
  let message = `Moved to ${formatTime(entryTime(moved[0]))}`;

  const episode = allEpisodes(data()).find(e => e.id === id || e.endEntryId === id);
  if (episode) {
    const name = trackerById(entry.tracker_id).name;
    const start = data().entries.get(episode.id)!;
    let from = entry.kind === 'start' ? entryTime(moved[0]) : episode.start;
    let to: number | null = entry.kind === 'end' ? entryTime(moved[0]) : episode.status === 'ongoing' ? null : episode.end;
    if (entry.kind === 'end' && to! <= episode.start) {
      moved = [movedBy(start, ms), moved[0]];
      from = entryTime(moved[0]);
      to = entryTime(moved[1]);
      message = `Moved ${name} to ${formatTime(from)}–${formatTime(to)}`;
    }
    if (overlapsAnother(entry.tracker_id, [episode.id, episode.endEntryId], from, to)) {
      toast(`That would overlap another ${name}.`, id);
      return;
    }
  }
  await saveEntries(moved);
  toast(message, id);
});

export const deleteEntry = safely(async (id: string, message: string) => {
  await changeEntry(id, { deleted: true });
  toast(message);
});

/** The entry at "HH:MM" on its own day ("" keeps its time). */
function atTime(entry: Entry, time: string): Entry {
  if (!time) return entry;
  const [hours, minutes] = time.split(':').map(Number);
  const when = new Date(entryTime(entry));
  when.setHours(hours, minutes, 0, 0);
  return { ...entry, occurred_at: when.toISOString() };
}

/** time is "HH:MM" on the entry's day, or "" to keep it. */
export const editEntry = safely(async (id: string, time: string, note: string) => {
  const entry = data().entries.get(id);
  if (entry) await saveEntry({ ...atTime(entry, time), note: note.trim() || null });
});

/** An episode's start and end times ("HH:MM", each on its own day) and its note, which is the start's. */
export const editEpisode = safely(async (startId: string, startTime: string, note: string, endId?: string, endTime: string = '') => {
  const start = data().entries.get(startId);
  if (!start) return false;
  const end = endId ? data().entries.get(endId) : undefined;
  const changed = [{ ...atTime(start, startTime), note: note.trim() || null }];
  if (end) changed.push(atTime(end, endTime));
  if (end && entryTime(changed[1]) <= entryTime(changed[0])) {
    toast('The end has to be after the start.');
    return false;
  }
  const episode = allEpisodes(data()).find(e => e.id === startId);
  const until = end ? entryTime(changed[1]) : episode?.status === 'ongoing' ? null : episode?.end ?? null;
  if (overlapsAnother(start.tracker_id, [startId, endId], entryTime(changed[0]), until)) {
    toast(`That would overlap another ${trackerById(start.tracker_id).name}.`);
    return false;
  }
  await saveEntries(changed);
  return true;
});

/** Deletes an episode: its start and, if it has one, its end. */
export const deleteEpisode = safely(async (startId: string, endId?: string) => {
  const both = [startId, endId].map(id => (id ? data().entries.get(id) : undefined)).filter((e): e is Entry => !!e);
  await saveEntries(both.map(e => ({ ...e, deleted: true })));
  toast('Deleted');
});

/* ---------- check-in ---------- */

/** A check-in answer: a rating level, a number as typed, the picked options, or text. */
export type Answer = number | string | string[] | null;

/**
 * Saves each answer as an entry, sharing one checkin_id. when is a datetime-local value ("" for now).
 * Returns the check-in's time, or null if nothing was answered.
 */
export const saveCheckin = safely(async (answers: Record<string, Answer>, when: string): Promise<number | null> => {
  const time = when ? new Date(when).getTime() : Date.now();
  const fields = { occurred_at: new Date(time).toISOString(), checkin_id: uuid() };

  let answered = 0;
  for (const tracker of sortedTrackers(data(), CHECKIN_TYPES)) {
    const answer = answers[tracker.id];
    if (answer == null || answer === '' || (Array.isArray(answer) && !answer.length)) continue;
    const save = (values: Partial<Entry>) => saveEntry(newEntry(tracker.id, 'answer', { ...fields, ...values }));
    switch (tracker.type) {
      case 'rating': {
        const level = Number(answer);
        await save({ value: level, text: levelLabel(tracker, level) });
        break;
      }
      case 'number':
        await save({ value: Number(answer) });
        break;
      case 'text':
        await save({ text: String(answer) });
        break;
      case 'choice':
        for (const option of [answer].flat()) await save({ text: String(option) }); // one entry per selected option
        break;
      case 'episode':
      case 'moment':
        continue; // not check-in questions
      default:
        unhandled(tracker.type, null);
        continue;
    }
    answered++;
  }

  if (!answered) {
    toast('Nothing to save yet. Answer at least one question.');
    return null;
  }
  toast(`Check-in saved · ${answered} ${answered === 1 ? 'answer' : 'answers'}`);
  return time;
});

/* ---------- trackers ---------- */

/** New trackers go to the end of the list. */
export const saveTrackerEdit = safely(async (tracker: Tracker) => {
  const isNew = !data().trackers.has(tracker.id);
  const lastSortOrder = Math.max(0, ...[...data().trackers.values()].map(t => t.sort_order || 0));
  await saveTracker(isNew ? { ...tracker, sort_order: lastSortOrder + 10 } : tracker);
  toast(`Saved ${tracker.name}`);
  return true;
});

export const archiveTracker = safely(async (id: string) => {
  const tracker = trackerById(id);
  await saveTracker({ ...tracker, archived: true });
  toast(`Archived ${tracker.name}. Its entries are kept.`);
  return true;
});

/** Deletes a tracker and all its entries, here and on every device it syncs to. */
export const deleteTracker = safely(async (id: string) => {
  const tracker = trackerById(id);
  await saveTracker({ ...tracker, deleted: true });
  const itsEntries = [...data().entries.values()].filter(e => e.tracker_id === id && !e.deleted);
  await saveEntries(itsEntries.map(e => ({ ...e, deleted: true })));
  toast(`Deleted ${tracker.name}`);
  return true;
});

export const restoreTracker = safely(async (id: string) => {
  await saveTracker({ ...trackerById(id), archived: false });
});

/** Swaps a tracker with its neighbor in the same group: direction -1 moves it up, 1 down. */
export const moveTracker = safely(async (id: string, direction: -1 | 1) => {
  const tracker = trackerById(id);
  const sameGroup = sortedTrackers(data()).filter(t => groupName(t) === groupName(tracker));
  const neighbor = sameGroup[sameGroup.findIndex(t => t.id === id) + direction];
  if (!neighbor) return;
  const mine = tracker.sort_order;
  const theirs = neighbor.sort_order;
  // With equal sort orders a plain swap would change nothing, so step past the neighbor instead.
  await saveTracker({ ...tracker, sort_order: theirs === mine ? theirs + direction : theirs });
  await saveTracker({ ...neighbor, sort_order: mine });
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
  for (const tracker of [...data().trackers.values()].filter(t => !t.deleted)) {
    await saveTracker({ ...tracker, deleted: true });
  }
  await saveEntries([...data().entries.values()].filter(e => !e.deleted).map(e => ({ ...e, deleted: true })));
  await addStarterTrackers();
  toast('Everything was reset. Your other phones catch up when they next sync.');
  return true;
});
