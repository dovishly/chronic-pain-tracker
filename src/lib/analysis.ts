// Analysis-ready tables built from the raw entries, for export.
//
//   daily      one row per calendar day, one or more columns per tracker: for correlating across days
//   checkins   one row per check-in, one column per question: for correlating answers given together
//   episodes   one row per start/stop episode, with its duration and peak severity
//   entries    one row per entry: the raw log, with episode_id linking start/end/level rows
//   trackers   one row per tracker: what each one is, with its levels and options
//
// They share tracker_id, entry_id, episode_id and checkin_id, and all dates and times are the
// device's local time. schema.sql builds the same episodes and daily figures as SQL views;
// keep the two in step (tests/fixtures/analysis.json and both tests pin the results).
import { MINUTE_MS, clockTime, dayKey, dayStart, unhandled } from './util';
import {
  allEpisodes, byTime, entryTime, liveEntries, sortedTrackers,
  type Data, type Entry, type EntryKind, type Episode, type Tracker,
} from './model';

export type Cell = string | number | boolean | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
}

/** The kind column, with "value" spelled out as "answer". */
const EVENT_NAMES: Record<EntryKind, string> = {
  start: 'start',
  end: 'end',
  level: 'level',
  moment: 'moment',
  value: 'answer',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (ms: number) => WEEKDAYS[new Date(ms).getDay()];
const round2 = (n: number) => Math.round(n * 100) / 100;
const average = (values: number[]) => (values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null);
const sum = (values: number[]) => (values.length ? round2(values.reduce((a, b) => a + b, 0)) : null);
const joinText = (values: (string | null)[]) => values.filter(Boolean).join(' | ') || null;

/** The day after a "YYYY-MM-DD" day. (30 h past midnight is always the next day, even across DST changes.) */
const nextDay = (key: string) => dayKey(dayStart(key) + 30 * 60 * MINUTE_MS);

export function buildAnalysisTables(data: Data, now = Date.now()): Table[] {
  const entries = liveEntries(data).sort(byTime);
  const trackersWithEntries = new Set(entries.map(e => e.tracker_id));
  // Archived trackers are included when they have history.
  const trackers = sortedTrackers(data, null, { includeArchived: true })
    .filter(t => !t.archived || trackersWithEntries.has(t.id));
  const names = columnNames(trackers);
  const episodes = allEpisodes(data).map(e => (e.status === 'ongoing' ? { ...e, end: now } : e));
  const context: Context = { data, entries, trackers, names, episodes, now, ...linkEpisodes(entries, episodes) };

  return [
    dailyTable(context),
    checkinsTable(context),
    episodesTable(context),
    entriesTable(context),
    trackersTable(context),
  ];
}

interface Context {
  data: Data;
  entries: Entry[];          // live entries, oldest first
  trackers: Tracker[];       // in display order, archived ones only if they have entries
  names: Map<string, string>; // trackerId -> column name (unique)
  episodes: Episode[];         // oldest first
  now: number;
  levelsByEpisode: Map<string, Entry[]>;   // episodeId -> level entries logged while it ran
  episodeIdByEntry: Map<string, string>;   // start, end and level entry id -> episodeId
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
    if (e.tracker_id === tracker.id && e.kind === 'value' && e.txt && !options.includes(e.txt)) options.push(e.txt);
  }
  return options;
}

/**
 * Links episodes to their entries: the start, the end, and the levels logged while each ran.
 * A level on the boundary between two episodes (a restart) belongs to the earlier one.
 */
function linkEpisodes(entries: Entry[], episodes: Episode[]) {
  const levelsByTracker = new Map<string, Entry[]>(); // oldest first, since entries are
  for (const e of entries) {
    if (e.kind !== 'level') continue;
    if (!levelsByTracker.has(e.tracker_id)) levelsByTracker.set(e.tracker_id, []);
    levelsByTracker.get(e.tracker_id)!.push(e);
  }

  const levelsByEpisode = new Map<string, Entry[]>();
  const episodeIdByEntry = new Map<string, string>();
  for (const episode of episodes) {
    episodeIdByEntry.set(episode.id, episode.id);
    if (episode.endEntryId) episodeIdByEntry.set(episode.endEntryId, episode.id);
    const levels = entriesBetween(levelsByTracker.get(episode.trackerId) ?? [], episode.start, episode.end);
    levelsByEpisode.set(episode.id, levels);
    for (const level of levels) {
      if (!episodeIdByEntry.has(level.id)) episodeIdByEntry.set(level.id, episode.id);
    }
  }
  return { levelsByEpisode, episodeIdByEntry };
}

/** The entries from a time-sorted list with from <= time <= to, found by binary search. */
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

/** Check-in answers grouped by check-in, oldest first. */
function checkinGroups(entries: Entry[]): { key: string; time: number; answers: Entry[] }[] {
  const groups = new Map<string, { key: string; time: number; answers: Entry[] }>();
  for (const e of entries) {
    if (e.kind !== 'value') continue;
    const key = e.checkin_id || 'at ' + e.ts; // answers without a check-in id are grouped by time
    if (!groups.has(key)) groups.set(key, { key, time: entryTime(e), answers: [] });
    groups.get(key)!.answers.push(e);
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

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
      t.grp || null,
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

function entriesTable({ data, entries, episodeIdByEntry }: Context): Table {
  return {
    name: 'entries',
    columns: [
      'entry_id', 'date', 'time', 'weekday', 'timestamp_utc', 'tracker_id', 'tracker', 'type', 'group',
      'event', 'value', 'label', 'text', 'note', 'checkin_id', 'episode_id',
    ],
    rows: entries.map(e => {
      const tracker = data.trackers.get(e.tracker_id)!;
      const time = entryTime(e);
      const isTextAnswer = e.kind === 'value' && tracker.type === 'text';
      return [
        e.id,
        dayKey(time),
        clockTime(time),
        weekday(time),
        e.ts,
        e.tracker_id,
        tracker.name,
        tracker.type,
        tracker.grp || null,
        EVENT_NAMES[e.kind],
        e.num,                        // rating level, number, or severity level
        isTextAnswer ? null : e.txt,  // the level's label, or the chosen option
        isTextAnswer ? e.txt : null,  // free text
        e.note,
        e.checkin_id,
        episodeIdByEntry.get(e.id) ?? null,
      ];
    }),
  };
}

/* ---------- episodes ---------- */

function episodesTable({ data, entries, episodes, levelsByEpisode }: Context): Table {
  const entriesById = new Map(entries.map(e => [e.id, e]));
  return {
    name: 'episodes',
    columns: [
      'episode_id', 'tracker_id', 'tracker', 'group', 'start_date', 'start_time', 'start_utc',
      'end_date', 'end_time', 'end_utc', 'duration_min', 'status', 'max_level', 'max_level_label',
      'levels_logged', 'notes', 'end_entry_id',
    ],
    rows: episodes.map(episode => {
      const tracker = data.trackers.get(episode.trackerId)!;
      const levels = levelsByEpisode.get(episode.id)!;
      const peak = levels.reduce<Entry | null>((best, e) => (!best || (e.num ?? 0) > (best.num ?? 0) ? e : best), null);
      const ongoing = episode.status === 'ongoing';
      const related = [entriesById.get(episode.id), episode.endEntryId ? entriesById.get(episode.endEntryId) : undefined, ...levels];
      return [
        episode.id,
        episode.trackerId,
        tracker.name,
        tracker.grp || null,
        dayKey(episode.start),
        clockTime(episode.start),
        new Date(episode.start).toISOString(),
        ongoing ? null : dayKey(episode.end),
        ongoing ? null : clockTime(episode.end),
        ongoing ? null : new Date(episode.end).toISOString(),
        Math.round((episode.end - episode.start) / MINUTE_MS), // so far, if ongoing
        episode.status,
        peak?.num ?? null,
        peak?.txt ?? null,
        levels.length,
        joinText(related.map(e => e?.note ?? null)),
        episode.endEntryId ?? null,
      ];
    }),
  };
}

/* ---------- check-ins ---------- */

function checkinsTable({ data, entries, trackers, names }: Context): Table {
  const columns = ['checkin_id', 'date', 'time', 'weekday', 'timestamp_utc'];
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
        add(name, answers => mine(answers)[0]?.num ?? null);
        break;
      case 'choice':
        // One 1/0 column per option. All blank when the question was skipped in that check-in.
        for (const option of choiceOptions(tracker, entries)) {
          add(`${name}: ${option}`, answers => {
            const picked = mine(answers);
            return picked.length ? (picked.some(a => a.txt === option) ? 1 : 0) : null;
          });
        }
        break;
      case 'text':
        add(name, answers => joinText(mine(answers).map(a => a.txt)));
        break;
      case 'episode':
      case 'moment':
        break; // not check-in questions
      default:
        unhandled(tracker.type, null);
    }
  }
  columns.push('notes');

  return {
    name: 'checkins',
    columns,
    rows: checkinGroups(entries).map(({ key, time, answers }) => [
      answers[0].checkin_id ?? key,
      dayKey(time),
      clockTime(time),
      weekday(time),
      new Date(time).toISOString(),
      ...cellsFor.map(cell => cell(answers)),
      joinText(answers.filter(a => a.note).map(a => `${data.trackers.get(a.tracker_id)!.name}: ${a.note}`)),
    ]),
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

  const entriesByDay = new Map<string, Entry[]>(days.map(day => [day, []]));
  for (const e of entries) entriesByDay.get(dayKey(entryTime(e)))?.push(e);

  const startsByDay = new Map<string, Map<string, number>>(); // day -> trackerId -> episodes started
  for (const episode of episodes) {
    const day = dayKey(episode.start);
    const perTracker = startsByDay.get(day) ?? new Map<string, number>();
    perTracker.set(episode.trackerId, (perTracker.get(episode.trackerId) ?? 0) + 1);
    startsByDay.set(day, perTracker);
  }

  // Minutes each episode was running within each day, clipped at midnight.
  const minutesByDay = new Map<string, Map<string, number>>(); // day -> trackerId -> ms
  for (const episode of episodes) {
    for (let day = dayKey(episode.start); day <= dayKey(episode.end); day = nextDay(day)) {
      const from = Math.max(episode.start, dayStart(day));
      const to = Math.min(episode.end, dayStart(nextDay(day)));
      if (to < from) continue;
      const perTracker = minutesByDay.get(day) ?? new Map<string, number>();
      perTracker.set(episode.trackerId, (perTracker.get(episode.trackerId) ?? 0) + (to - from));
      minutesByDay.set(day, perTracker);
    }
  }

  const columns = ['date', 'weekday', 'checkins'];
  const cellsFor: ((day: string, dayEntries: Entry[]) => Cell)[] = [];
  const add = (column: string, cell: (day: string, dayEntries: Entry[]) => Cell) => {
    columns.push(column);
    cellsFor.push(cell);
  };

  for (const tracker of trackers) {
    const name = names.get(tracker.id)!;
    const mine = (dayEntries: Entry[], kind: EntryKind) => dayEntries.filter(e => e.tracker_id === tracker.id && e.kind === kind);
    const answerNumbers = (dayEntries: Entry[]) =>
      mine(dayEntries, 'value').map(e => e.num).filter((n): n is number => n != null);

    switch (tracker.type) {
      case 'rating':
        add(`${name} (avg)`, (_, d) => average(answerNumbers(d)));
        break;
      case 'number':
        add(`${name} (total)`, (_, d) => sum(answerNumbers(d)));
        add(`${name} (avg)`, (_, d) => average(answerNumbers(d)));
        break;
      case 'choice':
        // How many times each option was picked. All blank on days the question wasn't answered.
        for (const option of choiceOptions(tracker, entries)) {
          add(`${name}: ${option}`, (_, d) => {
            const picked = mine(d, 'value');
            return picked.length ? picked.filter(e => e.txt === option).length : null;
          });
        }
        break;
      case 'text':
        add(`${name} (text)`, (_, d) => joinText(mine(d, 'value').map(e => e.txt)));
        break;
      case 'episode': {
        add(`${name} (episodes)`, day => startsByDay.get(day)?.get(tracker.id) ?? 0);
        add(`${name} (minutes)`, day => Math.round((minutesByDay.get(day)?.get(tracker.id) ?? 0) / MINUTE_MS));
        const hasLevels = (tracker.config.levels || []).length > 0
          || entries.some(e => e.tracker_id === tracker.id && e.kind === 'level');
        if (hasLevels) {
          add(`${name} (max level)`, (_, d) => {
            const levels = mine(d, 'level').map(e => e.num).filter((n): n is number => n != null);
            return levels.length ? Math.max(...levels) : null;
          });
        }
        break;
      }
      case 'moment':
        add(`${name} (count)`, (_, d) => mine(d, 'moment').length);
        break;
      default:
        unhandled(tracker.type, null);
    }
  }

  return {
    name: 'daily',
    columns,
    rows: days.map(day => {
      const dayEntries = entriesByDay.get(day)!;
      const checkins = new Set(dayEntries.filter(e => e.kind === 'value').map(e => e.checkin_id || 'at ' + e.ts));
      return [day, weekday(dayStart(day)), checkins.size, ...cellsFor.map(cell => cell(day, dayEntries))];
    }),
  };
}

/* ---------- CSV ---------- */

function csvCell(value: Cell): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(table: Table): string {
  return [table.columns, ...table.rows].map(row => row.map(csvCell).join(',')).join('\n');
}
