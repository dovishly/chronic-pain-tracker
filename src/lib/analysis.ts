// The export's tables, built from the entries. Times are local; *_utc columns are UTC.
// The views in schema.sql must give the same episodes and daily figures.
import { MINUTE_MS, clockTime, dayKey, dayStart, nextDay, pad2, unhandled } from './util';
import {
  allEpisodes, byTime, entryLabel, entryText, entryTime, liveEntries, sortedTrackers,
  type Data, type Entry, type EntryKind, type Episode, type Tracker,
} from './model';

export type Cell = string | number | boolean | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
}

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
/** Which check-in an answer belongs to. Answers without a check-in id are grouped by time. */
const checkinKey = (answer: Entry) => answer.checkin_id || 'at ' + answer.occurred_at;

export function buildAnalysisTables(data: Data, now = Date.now()): Table[] {
  const entries = liveEntries(data).sort(byTime);
  const trackersWithEntries = new Set(entries.map(e => e.tracker_id));
  // Archived trackers are included when they have history.
  const trackers = sortedTrackers(data, null, { includeArchived: true })
    .filter(t => !t.archived || trackersWithEntries.has(t.id));
  const names = columnNames(trackers);
  const episodes = allEpisodes(data).map(e => (e.status === 'ongoing' ? { ...e, end: now } : e));
  const context: Context = { data, entries, trackers, names, episodes, now, ...linkEpisodes(data, entries, episodes) };

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
  timelineByEpisode: Map<string, string>;  // episodeId -> everything logged while it ran, in order
  runningAt: Map<string, Episode[]>;       // entryId -> other trackers' episodes running at that moment
}

/** Caps a timeline, which would be huge for an episode left running for weeks. */
const TIMELINE_LIMIT = 100;

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

/** A level on the boundary between two episodes (a restart) belongs to the earlier one. */
function linkEpisodes(data: Data, entries: Entry[], episodes: Episode[]) {
  const trackerSort = (trackerId: string) => data.trackers.get(trackerId)?.sort_order ?? 0;

  const levelsByTracker = new Map<string, Entry[]>(); // oldest first, since entries are
  for (const e of entries) {
    if (e.kind !== 'level') continue;
    if (!levelsByTracker.has(e.tracker_id)) levelsByTracker.set(e.tracker_id, []);
    levelsByTracker.get(e.tracker_id)!.push(e);
  }

  // Entries at the same moment (a check-in's answers) are listed in tracker order, then by id.
  const inTimelineOrder = [...entries].sort((a, b) =>
    entryTime(a) - entryTime(b) || trackerSort(a.tracker_id) - trackerSort(b.tracker_id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const levelsByEpisode = new Map<string, Entry[]>();
  const episodeIdByEntry = new Map<string, string>();
  const timelineByEpisode = new Map<string, string>();
  for (const episode of episodes) {
    episodeIdByEntry.set(episode.id, episode.id);
    if (episode.endEntryId) episodeIdByEntry.set(episode.endEntryId, episode.id);
    const levels = entriesBetween(levelsByTracker.get(episode.trackerId) ?? [], episode.start, episode.end);
    levelsByEpisode.set(episode.id, levels);
    for (const level of levels) {
      if (!episodeIdByEntry.has(level.id)) episodeIdByEntry.set(level.id, episode.id);
    }
    timelineByEpisode.set(episode.id, timeline(data, episode, entriesBetween(inTimelineOrder, episode.start, episode.end)));
  }

  // Sweep through entries in time order, keeping the episodes running at each one.
  const runningAt = new Map<string, Episode[]>();
  let nextEpisode = 0;
  let active: Episode[] = [];
  for (const e of entries) {
    const time = entryTime(e);
    while (nextEpisode < episodes.length && episodes[nextEpisode].start <= time) active.push(episodes[nextEpisode++]);
    active = active.filter(episode => episode.end >= time);
    const running = active
      .filter(episode => episode.trackerId !== e.tracker_id)
      .sort((a, b) => trackerSort(a.trackerId) - trackerSort(b.trackerId) || a.start - b.start);
    if (running.length) runningAt.set(e.id, running);
  }

  return { levelsByEpisode, episodeIdByEntry, timelineByEpisode, runningAt };
}

/**
 * Everything logged while an episode ran, e.g. "10:00 started · 10:30 Moderate · 11:30 Coffee · 12:00 ended".
 * Times on a later day than the start get the date: "09-02 01:30 ended".
 */
function timeline(data: Data, episode: Episode, during: Entry[]): string {
  const startDay = dayKey(episode.start);
  const items = during.slice(0, TIMELINE_LIMIT).map(e => {
    const time = entryTime(e);
    const when = (dayKey(time) === startDay ? '' : dayKey(time).slice(5) + ' ') + clockTime(time);
    return `${when} ${describeDuring(data, episode, e)}`;
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

/** "Headache; Tired" and their episode ids, for the "during" columns. */
const duringNames = (running: Episode[] | undefined, data: Data) =>
  running?.map(episode => data.trackers.get(episode.trackerId)!.name).join('; ') || null;
const duringIds = (running: Episode[] | undefined) => running?.map(episode => episode.id).join('; ') || null;

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

function checkinGroups(entries: Entry[]): { key: string; time: number; answers: Entry[] }[] {
  const groups = new Map<string, { key: string; time: number; answers: Entry[] }>();
  for (const e of entries) {
    if (e.kind !== 'answer') continue;
    const key = checkinKey(e);
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
      const ongoing = episode.status === 'ongoing';
      const related = [entriesById.get(episode.id), episode.endEntryId ? entriesById.get(episode.endEntryId) : undefined, ...levels];
      return [
        episode.id,
        tracker.name,
        localDateTime(episode.start),
        ongoing ? null : localDateTime(episode.end),
        round1((episode.end - episode.start) / MINUTE_MS), // so far, if ongoing
        episode.status,
        peak?.value ?? null,
        peak?.text ?? null,
        timelineByEpisode.get(episode.id)!,
        joinText(related.map(e => e?.note ?? null)),
        episode.trackerId,
        tracker.group_name || null,
        dayKey(episode.start),
        clockTime(episode.start),
        ongoing ? null : dayKey(episode.end),
        ongoing ? null : clockTime(episode.end),
        new Date(episode.start).toISOString(),
        ongoing ? null : new Date(episode.end).toISOString(),
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

  return {
    name: 'checkins',
    columns,
    rows: checkinGroups(entries).map(({ key, time, answers }) => [
      answers[0].checkin_id ?? key,
      localDateTime(time),
      dayKey(time),
      clockTime(time),
      weekday(time),
      new Date(time).toISOString(),
      ...cellsFor.map(cell => cell(answers)),
      duringNames(runningAt.get(answers[0].id), data),
      joinText(answers.filter(a => a.note).map(a => `${data.trackers.get(a.tracker_id)!.name}: ${a.note}`)),
    ]),
  };
}

/* ---------- daily ---------- */

/** A figure per day per tracker: day -> trackerId -> amount. */
type DayFigures = Map<string, Map<string, number>>;

function addToDay(figures: DayFigures, day: string, trackerId: string, amount: number): void {
  const perTracker = figures.get(day) ?? new Map<string, number>();
  perTracker.set(trackerId, (perTracker.get(trackerId) ?? 0) + amount);
  figures.set(day, perTracker);
}

function dailyTable({ entries, trackers, names, episodes, now }: Context): Table {
  // Every calendar day from the first entry to today, including days with nothing logged.
  const days: string[] = [];
  if (entries.length) {
    const today = dayKey(now);
    for (let day = dayKey(entryTime(entries[0])); day <= today; day = nextDay(day)) days.push(day);
  }

  const entriesByDay = new Map<string, Entry[]>(days.map(day => [day, []]));
  for (const e of entries) entriesByDay.get(dayKey(entryTime(e)))?.push(e);

  const startsByDay: DayFigures = new Map(); // episodes started
  const msByDay: DayFigures = new Map();     // time episodes were running, clipped at midnight
  for (const episode of episodes) {
    addToDay(startsByDay, dayKey(episode.start), episode.trackerId, 1);
    for (let day = dayKey(episode.start); day <= dayKey(episode.end); day = nextDay(day)) {
      const from = Math.max(episode.start, dayStart(day));
      const to = Math.min(episode.end, dayStart(nextDay(day)));
      if (to >= from) addToDay(msByDay, day, episode.trackerId, to - from);
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
        add(`${name} (episodes)`, day => startsByDay.get(day)?.get(tracker.id) ?? 0);
        add(`${name} (minutes)`, day => Math.round((msByDay.get(day)?.get(tracker.id) ?? 0) / MINUTE_MS));
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
      const checkins = new Set(dayEntries.filter(e => e.kind === 'answer').map(checkinKey));
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
