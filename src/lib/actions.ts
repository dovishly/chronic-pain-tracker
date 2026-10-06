import { MINUTE_MS, formatTime, formatDuration, uuid, unhandled } from './util';
import { dataStore } from './data';
import {
  CHECKIN_TYPES, newEntry, entryTime, sortedTrackers, groupName, levelLabel, activeEpisodes,
  type Entry, type EntryKind, type Tracker,
} from './model';
import { saveEntry, saveTracker } from './store';
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

export const moveEntryEarlier = safely(async (id: string, minutes: number) => {
  const entry = data().entries.get(id);
  if (!entry) return;
  const newTime = entryTime(entry) - minutes * MINUTE_MS;
  await changeEntry(id, { occurred_at: new Date(newTime).toISOString() });
  toast(`Moved to ${formatTime(newTime)}`, id);
});

export const deleteEntry = safely(async (id: string, message: string) => {
  await changeEntry(id, { deleted: true });
  toast(message);
});

/** time is "HH:MM" on the entry's day, or "" to keep it. */
export const editEntry = safely(async (id: string, time: string, note: string) => {
  const entry = data().entries.get(id);
  if (!entry) return;
  const changes: Partial<Entry> = { note: note.trim() || null };
  if (time) {
    const [hours, minutes] = time.split(':').map(Number);
    const when = new Date(entryTime(entry));
    when.setHours(hours, minutes, 0, 0);
    changes.occurred_at = when.toISOString();
  }
  await changeEntry(id, changes);
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
