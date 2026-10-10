// "Export for analysis": five tables built from the entries, which line up by date and id.
//   daily     one row per calendar day, with a few columns per tracker
//   checkins  one row per check-in, with a column per question (one per option for choices)
//   episodes  one row per start/stop episode: its levels, notes, and a timeline of what happened meanwhile
//   entries   one row per entry, with the episode it belongs to and what else was running
//   trackers  one row per tracker, with its settings
// Times are local; *_utc columns are UTC.
import { MINUTE_MS, clockTime, dayBounds, dayKey, dayStart, groupBy, nextDay, pad2, unhandled } from './util';
import {
  allEpisodes, allTrackers, byTime, checkinKey, dayTotals, entryLabel, entryText, entryTime, liveEntries,
  type Data, type Entry, type EntryKind, type Episode, type Tracker,
} from './model';

export type Cell = string | number | boolean | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
}

/** An episode's timeline lists at most this many items, since one left running for weeks would list everything. */
const TIMELINE_LIMIT = 100;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (ms: number) => WEEKDAYS[new Date(ms).getDay()];
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Local date and time to the second, e.g. "2026-10-03 12:35:26". */
const localDateTime = (ms: number) => `${dayKey(ms)} ${clockTime(ms)}:${pad2(new Date(ms).getSeconds())}`;
const total = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);
const average = (numbers: number[]) => (numbers.length ? round2(total(numbers) / numbers.length) : null);
const sum = (numbers: number[]) => (numbers.length ? round2(total(numbers)) : null);
const joinText = (texts: (string | null)[]) => texts.filter(Boolean).join(' | ') || null;
const valuesOf = (entries: Entry[]) => entries.map(e => e.value).filter((n): n is number => n != null);
const sortOrder = (data: Data, trackerId: string) => data.trackers.get(trackerId)?.sort_order ?? 0;
const byId = (a: Entry, b: Entry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Everything the tables are built from. */
interface Context {
  data: Data;
  entries: Entry[];           // live entries, oldest first
  trackers: Tracker[];        // in display order; archived ones only if they have entries
  names: Map<string, string>; // tracker id -> its column name (unique)
  episodes: Episode[];        // oldest first; a running one ends now
  now: number;
  levelsByEpisode: Map<string, Entry[]>;  // episode id -> its level entries
  episodeIdByEntry: Map<string, string>;  // start, end and level entry id -> its episode's id
  timelineByEpisode: Map<string, string>; // episode id -> everything logged while it ran
  runningAt: Map<string, Episode[]>;      // entry id -> other trackers' episodes running at its time
}

export function buildAnalysisTables(data: Data, now = Date.now()): Table[] {
  const entries = liveEntries(data).sort(byTime);
  const withEntries = new Set(entries.map(e => e.tracker_id));
  const trackers = allTrackers(data).filter(t => !t.archived || withEntries.has(t.id));
  const episodes = allEpisodes(data).map(e => (e.status === 'ongoing' ? { ...e, end: now } : e));
  const context: Context = {
    data, entries, trackers, episodes, now,
    names: columnNames(trackers),
    ...describeEpisodes(data, entries, episodes),
    runningAt: episodesRunningAt(data, entries, episodes),
  };
  return [dailyTable(context), checkinsTable(context), episodesTable(context), entriesTable(context), trackersTable(context)];
}

/** Tracker names for column headers; a repeated name gets " (2)", " (3)"… so every column is unique. */
function columnNames(trackers: Tracker[]): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const tracker of trackers) {
    const count = (seen.get(tracker.name) || 0) + 1;
    seen.set(tracker.name, count);
    names.set(tracker.id, count === 1 ? tracker.name : `${tracker.name} (${count})`);
  }
  return names;
}

/** A choice tracker's options: its current ones, then any that only appear in past answers. */
function choiceOptions(tracker: Tracker, entries: Entry[]): string[] {
  const options = (tracker.config.options || []).filter(Boolean);
  for (const e of entries) {
    if (e.tracker_id === tracker.id && e.kind === 'answer' && e.text && !options.includes(e.text)) options.push(e.text);
  }
  return options;
}

/* ---------- episodes and what happened during them ---------- */

/** Each episode's levels and timeline, and which episode each start, end and level belongs to. */
function describeEpisodes(data: Data, entries: Entry[], episodes: Episode[]) {
  const levelsByTracker = groupBy(entries.filter(e => e.kind === 'level'), e => e.tracker_id);
  // Entries at the same moment (a check-in's answers) are listed in tracker order, then by id.
  const inTimelineOrder = [...entries].sort((a, b) =>
    byTime(a, b) || sortOrder(data, a.tracker_id) - sortOrder(data, b.tracker_id) || byId(a, b));

  const levelsByEpisode = new Map<string, Entry[]>();
  const episodeIdByEntry = new Map<string, string>();
  const timelineByEpisode = new Map<string, string>();
  for (const episode of episodes) {
    const levels = entriesBetween(levelsByTracker.get(episode.trackerId) ?? [], episode.start, episode.end);
    levelsByEpisode.set(episode.id, levels);
    episodeIdByEntry.set(episode.id, episode.id);
    if (episode.endEntryId) episodeIdByEntry.set(episode.endEntryId, episode.id);
    // A level at the moment one episode restarts into the next belongs to the earlier one.
    for (const level of levels) if (!episodeIdByEntry.has(level.id)) episodeIdByEntry.set(level.id, episode.id);
    timelineByEpisode.set(episode.id, timeline(data, episode, entriesBetween(inTimelineOrder, episode.start, episode.end)));
  }
  return { levelsByEpisode, episodeIdByEntry, timelineByEpisode };
}

/** For each entry, the other trackers' episodes running at its time. Sweeps through both in time order. */
function episodesRunningAt(data: Data, entries: Entry[], episodes: Episode[]): Map<string, Episode[]> {
  const runningAt = new Map<string, Episode[]>();
  let next = 0; // the next episode to start
  let running: Episode[] = [];
  for (const e of entries) {
    const time = entryTime(e);
    while (next < episodes.length && episodes[next].start <= time) running.push(episodes[next++]);
    running = running.filter(episode => episode.end >= time);
    const others = running
      .filter(episode => episode.trackerId !== e.tracker_id)
      .sort((a, b) => sortOrder(data, a.trackerId) - sortOrder(data, b.trackerId) || a.start - b.start);
    if (others.length) runningAt.set(e.id, others);
  }
  return runningAt;
}

/**
 * Everything logged while an episode ran, e.g. "10:00 started · 10:30 Moderate · 11:30 Coffee · 12:00 ended".
 * Times on a later day than the start get the date: "09-02 01:30 ended".
 */
function timeline(data: Data, episode: Episode, during: Entry[]): string {
  const startDay = dayKey(episode.start);
  const items = during.slice(0, TIMELINE_LIMIT).map(e => {
    const time = entryTime(e);
    const day = dayKey(time) === startDay ? '' : dayKey(time).slice(5) + ' ';
    return `${day}${clockTime(time)} ${describeDuring(data, episode, e)}`;
  });
  if (during.length > TIMELINE_LIMIT) items.push(`… and ${during.length - TIMELINE_LIMIT} more`);
  return items.join(' · ');
}

/** An entry as a timeline item: the episode's own events briefly, anything else in full. */
function describeDuring(data: Data, episode: Episode, e: Entry): string {
  if (e.tracker_id === episode.trackerId) {
    if (e.id === episode.id) return 'started';
    if (e.id === episode.endEntryId) return 'ended';
    if (e.kind === 'start') return 'restarted';
    if (e.kind === 'level') return entryLabel(e);
  }
  return entryText(e, data.trackers.get(e.tracker_id)!);
}

/** The entries with from <= time <= to, from a list sorted by time (found by binary search). */
function entriesBetween(sorted: Entry[], from: number, to: number): Entry[] {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entryTime(sorted[middle]) < from) low = middle + 1;
    else high = middle;
  }
  const found: Entry[] = [];
  for (let i = low; i < sorted.length && entryTime(sorted[i]) <= to; i++) found.push(sorted[i]);
  return found;
}

/** "Headache; Tired" and their episode ids, for the "during" columns. */
const duringNames = (running: Episode[] | undefined, data: Data) =>
  running?.map(episode => data.trackers.get(episode.trackerId)!.name).join('; ') || null;
const duringIds = (running: Episode[] | undefined) => running?.map(episode => episode.id).join('; ') || null;

/* ---------- trackers ---------- */

function trackersTable({ trackers, names }: Context): Table {
  return {
    name: 'trackers',
    columns: [
      'tracker_id', 'tracker', 'column_name', 'type', 'group', 'archived', 'sort_order',
      'levels', 'unit', 'min', 'max', 'options', 'multiple_choice', 'color',
    ],
    rows: trackers.map((t, i) => [
      t.id,
      t.name,
      names.get(t.id)!,
      t.type,
      t.group_name || null,
      t.archived,
      i + 1,
      t.config.levels?.length ? t.config.levels.map((label, n) => `${n + 1}=${label}`).join('; ') : null,
      t.config.unit || null,
      t.config.min ?? null,
      t.config.max ?? null,
      t.config.options?.length ? t.config.options.join('; ') : null,
      t.type === 'choice' ? !!t.config.multi : null,
      t.color,
    ]),
  };
}

/* ---------- entries ---------- */

function entriesTable({ data, entries, episodeIdByEntry, runningAt }: Context): Table {
  return {
    name: 'entries',
    columns: [
      'entry_id', 'datetime', 'date', 'time', 'weekday', 'timestamp_utc', 'tracker_id', 'tracker', 'type', 'group',
      'event', 'value', 'label', 'text', 'note', 'checkin_id', 'episode_id', 'during', 'during_episode_ids',
    ],
    rows: entries.map(e => {
      const tracker = data.trackers.get(e.tracker_id)!;
      const time = entryTime(e);
      const isTextAnswer = e.kind === 'answer' && tracker.type === 'text';
      return [
        e.id,
        localDateTime(time),
        dayKey(time),
        clockTime(time),
        weekday(time),
        e.occurred_at,
        e.tracker_id,
        tracker.name,
        tracker.type,
        tracker.group_name || null,
        e.kind,
        e.value,                       // rating level, number, or severity level
        isTextAnswer ? null : e.text,  // the level's label, or the chosen option
        isTextAnswer ? e.text : null,  // free text
        e.note,
        e.checkin_id,
        episodeIdByEntry.get(e.id) ?? null,
        duringNames(runningAt.get(e.id), data),
        duringIds(runningAt.get(e.id)),
      ];
    }),
  };
}

/* ---------- episodes ---------- */

function episodesTable({ data, entries, episodes, levelsByEpisode, timelineByEpisode }: Context): Table {
  const entriesById = new Map(entries.map(e => [e.id, e]));
  return {
    name: 'episodes',
    columns: [
      'episode_id', 'tracker', 'start', 'end', 'duration_min', 'status', 'max_level', 'max_level_label',
      'timeline', 'notes', 'tracker_id', 'group', 'start_date', 'start_time', 'end_date', 'end_time',
      'start_utc', 'end_utc', 'levels_logged', 'end_entry_id',
    ],
    rows: episodes.map(episode => {
      const tracker = data.trackers.get(episode.trackerId)!;
      const levels = levelsByEpisode.get(episode.id)!;
      const peak = levels.reduce<Entry | null>((best, e) => (!best || (e.value ?? 0) > (best.value ?? 0) ? e : best), null);
      const ended = episode.status !== 'ongoing';
      const own = [entriesById.get(episode.id), episode.endEntryId ? entriesById.get(episode.endEntryId) : undefined, ...levels];
      return [
        episode.id,
        tracker.name,
        localDateTime(episode.start),
        ended ? localDateTime(episode.end) : null,
        round1((episode.end - episode.start) / MINUTE_MS), // so far, if it's still running
        episode.status,
        peak?.value ?? null,
        peak?.text ?? null,
        timelineByEpisode.get(episode.id)!,
        joinText(own.map(e => e?.note ?? null)),
        episode.trackerId,
        tracker.group_name || null,
        dayKey(episode.start),
        clockTime(episode.start),
        ended ? dayKey(episode.end) : null,
        ended ? clockTime(episode.end) : null,
        new Date(episode.start).toISOString(),
        ended ? new Date(episode.end).toISOString() : null,
        levels.length,
        episode.endEntryId ?? null,
      ];
    }),
  };
}

/* ---------- check-ins ---------- */

function checkinsTable({ data, entries, trackers, names, runningAt }: Context): Table {
  const columns = ['checkin_id', 'datetime', 'date', 'time', 'weekday', 'timestamp_utc'];
  const cellsFor: ((answers: Entry[]) => Cell)[] = [];
  const add = (column: string, cell: (answers: Entry[]) => Cell) => {
    columns.push(column);
    cellsFor.push(cell);
  };

  for (const tracker of trackers) {
    const name = names.get(tracker.id)!;
    const mine = (answers: Entry[]) => answers.filter(a => a.tracker_id === tracker.id);
    switch (tracker.type) {
      case 'rating':
      case 'number':
        add(name, answers => mine(answers)[0]?.value ?? null);
        break;
      case 'choice':
        // One 1/0 column per option. All blank when the question was skipped in that check-in.
        for (const option of choiceOptions(tracker, entries)) {
          add(`${name}: ${option}`, answers => {
            const picked = mine(answers);
            return picked.length ? (picked.some(a => a.text === option) ? 1 : 0) : null;
          });
        }
        break;
      case 'text':
        add(name, answers => joinText(mine(answers).map(a => a.text)));
        break;
      case 'episode':
      case 'moment':
        break; // not check-in questions
      default:
        unhandled(tracker.type, null);
    }
  }
  columns.push('during', 'notes');

  // Entries are oldest first, so the check-ins are too.
  const checkins = groupBy(entries.filter(e => e.kind === 'answer'), checkinKey);
  return {
    name: 'checkins',
    columns,
    rows: [...checkins].map(([key, answers]) => {
      const time = entryTime(answers[0]);
      return [
        answers[0].checkin_id ?? key,
        localDateTime(time),
        dayKey(time),
        clockTime(time),
        weekday(time),
        new Date(time).toISOString(),
        ...cellsFor.map(cell => cell(answers)),
        duringNames(runningAt.get(answers[0].id), data),
        joinText(answers.filter(a => a.note).map(a => `${data.trackers.get(a.tracker_id)!.name}: ${a.note}`)),
      ];
    }),
  };
}

/* ---------- daily ---------- */

function dailyTable({ entries, trackers, names, episodes, now }: Context): Table {
  // Every calendar day from the first entry to today, including days with nothing logged.
  const days: string[] = [];
  if (entries.length) {
    const today = dayKey(now);
    for (let day = dayKey(entryTime(entries[0])); day <= today; day = nextDay(day)) days.push(day);
  }
  const entriesByDay = groupBy(entries, e => dayKey(entryTime(e)));
  const episodesByDay = new Map<string, Episode[]>(); // each episode under every day it ran on
  for (const episode of episodes) {
    for (let day = dayKey(episode.start); day <= dayKey(episode.end); day = nextDay(day)) {
      const onDay = episodesByDay.get(day);
      if (onDay) onDay.push(episode);
      else episodesByDay.set(day, [episode]);
    }
  }
  // The same totals as Today shows for each day.
  const totalsByDay = new Map(days.map(day =>
    [day, dayTotals(dayBounds(day), entriesByDay.get(day) ?? [], episodesByDay.get(day) ?? [])]));
  const totalOf = (day: string, trackerId: string) => totalsByDay.get(day)?.trackers.get(trackerId) ?? { count: 0, ms: 0 };

  const columns = ['date', 'weekday', 'checkins'];
  const cellsFor: ((day: string, dayEntries: Entry[]) => Cell)[] = [];
  const add = (column: string, cell: (day: string, dayEntries: Entry[]) => Cell) => {
    columns.push(column);
    cellsFor.push(cell);
  };

  for (const tracker of trackers) {
    const name = names.get(tracker.id)!;
    const mine = (dayEntries: Entry[], kind: EntryKind) => dayEntries.filter(e => e.tracker_id === tracker.id && e.kind === kind);
    const answerValues = (dayEntries: Entry[]) => valuesOf(mine(dayEntries, 'answer'));

    switch (tracker.type) {
      case 'rating':
        add(`${name} (avg)`, (_, d) => average(answerValues(d)));
        break;
      case 'number':
        add(`${name} (total)`, (_, d) => sum(answerValues(d)));
        add(`${name} (avg)`, (_, d) => average(answerValues(d)));
        break;
      case 'choice':
        // How many times each option was picked. All blank on days the question wasn't answered.
        for (const option of choiceOptions(tracker, entries)) {
          add(`${name}: ${option}`, (_, d) => {
            const picked = mine(d, 'answer');
            return picked.length ? picked.filter(e => e.text === option).length : null;
          });
        }
        break;
      case 'text':
        add(`${name} (text)`, (_, d) => joinText(mine(d, 'answer').map(e => e.text)));
        break;
      case 'episode': {
        add(`${name} (episodes)`, day => totalOf(day, tracker.id).count);
        add(`${name} (minutes)`, day => Math.round(totalOf(day, tracker.id).ms / MINUTE_MS));
        const hasLevels = (tracker.config.levels || []).length > 0
          || entries.some(e => e.tracker_id === tracker.id && e.kind === 'level');
        if (hasLevels) {
          add(`${name} (max level)`, (_, d) => {
            const levels = valuesOf(mine(d, 'level'));
            return levels.length ? Math.max(...levels) : null;
          });
        }
        break;
      }
      case 'moment':
        add(`${name} (count)`, day => totalOf(day, tracker.id).count);
        break;
      default:
        unhandled(tracker.type, null);
    }
  }

  return {
    name: 'daily',
    columns,
    rows: days.map(day => {
      const dayEntries = entriesByDay.get(day) ?? [];
      return [day, weekday(dayStart(day)), totalsByDay.get(day)!.checkins, ...cellsFor.map(cell => cell(day, dayEntries))];
    }),
  };
}
