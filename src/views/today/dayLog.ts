// The layout of a day's log: rows, newest first, and the bars beside them that show start/stop episodes.
//
// An episode is a single row, where it started (or at the bottom, if it began on an earlier day). Its bar
// runs up from there in a lane of its own, beside whatever was logged while it lasted, and stops:
//   - with a ring at the top edge of the last of those rows, once it has ended;
//   - at the Now row at the top of today, while it's still running;
//   - off the top, on an earlier day that it carried on past.
// Episodes that overlap get lanes side by side; ones that don't can share a lane.
import { MINUTE_MS, formatTime, groupBy, type DayBounds } from '../../lib/util';
import { checkinKey, entryTime, type Data, type Entry, type Episode } from '../../lib/model';

/** Rows further apart than this get a divider showing the gap. */
const GAP_MS = 60 * MINUTE_MS;

export type Row =
  | { type: 'entry'; key: string; time: number; entry: Entry; nested?: boolean } // nested: under its open check-in
  | { type: 'checkin'; key: string; time: number; answers: Entry[] }
  | { type: 'episode'; key: string; time: number | null; episode: Episode }   // null: began on an earlier day
  | { type: 'gap'; key: string; ms: number }
  | { type: 'now'; key: string; time: number };

/**
 * How a bar crosses a row: from the row's dot up (start), across it (through), stopping with a ring at the
 * row's top edge (end), both (start-end, when nothing was logged while it lasted), or up to the Now line (now).
 */
export type Segment = 'start' | 'through' | 'end' | 'start-end' | 'now';

export interface BarPiece {
  episode: Episode;
  segment: Segment;
}

/** A row as drawn: its time label (shown once, on the newest of the rows that share it) and a piece per lane. */
export interface Line {
  row: Row;
  timeLabel: string;
  bars: (BarPiece | null)[];
}

export function layOutDay(
  data: Data, entries: Entry[], episodes: Episode[], bounds: DayBounds, now: number, openCheckin: string | null,
): { lines: Line[]; lanes: number } {
  const rows = buildRows(data, entries, episodes, bounds, now, openCheckin);
  const { bars, lanes } = layOutBars(rows, episodes, bounds);
  const labels = timeLabels(rows);
  const pieces = rows.map(() => new Array<BarPiece | null>(lanes).fill(null));
  for (const bar of bars) {
    for (let i = bar.top; i <= bar.bottom; i++) pieces[i][bar.lane] = { episode: bar.episode, segment: segmentAt(bar, i) };
  }
  return { lines: rows.map((row, i) => ({ row, timeLabel: labels[i], bars: pieces[i] })), lanes };
}

/* ---------- rows ---------- */

const episodeKey = (episode: Episode) => 'episode:' + episode.id;

/** Among rows at the same moment, an episode's goes below the rest. */
const rank = (row: Row) => (row.type === 'episode' ? 1 : 0);

function buildRows(
  data: Data, entries: Entry[], episodes: Episode[], bounds: DayBounds, now: number, openCheckin: string | null,
): Row[] {
  const timed: (Row & { time: number })[] = [];

  // Starts and ends show as their episode's row; an end that ends no episode shows on its own.
  const endIds = new Set(episodes.map(e => e.endEntryId));
  for (const e of entries) {
    if (e.kind !== 'answer' && e.kind !== 'start' && !endIds.has(e.id)) {
      timed.push({ type: 'entry', key: e.id, time: entryTime(e), entry: e });
    }
  }
  const sortOrder = (e: Entry) => data.trackers.get(e.tracker_id)?.sort_order ?? 0;
  for (const [key, answers] of groupBy(entries.filter(e => e.kind === 'answer'), checkinKey)) {
    answers.sort((a, b) => sortOrder(a) - sortOrder(b));
    timed.push({ type: 'checkin', key, time: entryTime(answers[0]), answers });
  }
  for (const episode of episodes) {
    if (episode.start >= bounds.from) timed.push({ type: 'episode', key: episodeKey(episode), time: episode.start, episode });
  }
  timed.sort((a, b) => b.time - a.time || rank(a) - rank(b) || (a.key < b.key ? -1 : 1));
  if (now >= bounds.from && now < bounds.to) timed.unshift({ type: 'now', key: 'now', time: now });

  const rows: Row[] = [];
  timed.forEach((row, i) => {
    const newer = timed[i - 1];
    if (newer && newer.time - row.time >= GAP_MS) rows.push({ type: 'gap', key: 'gap:' + row.key, ms: newer.time - row.time });
    rows.push(row);
    if (row.type === 'checkin' && row.key === openCheckin) {
      for (const answer of row.answers) rows.push({ type: 'entry', key: answer.id, time: row.time, entry: answer, nested: true });
    }
  });
  for (const episode of episodes.filter(e => e.start < bounds.from).sort((a, b) => b.start - a.start)) {
    rows.push({ type: 'episode', key: episodeKey(episode), time: null, episode });
  }
  return rows;
}

/** Each row's time, or "" where the row above already shows it. Gaps and Now start afresh. */
function timeLabels(rows: Row[]): string[] {
  let shown = '';
  return rows.map(row => {
    if (row.type === 'gap' || row.type === 'now') {
      shown = '';
      return '';
    }
    if (row.time === null || (row.type === 'entry' && row.nested)) return '';
    const label = formatTime(row.time);
    if (label === shown) return '';
    shown = label;
    return label;
  });
}

/* ---------- bars ---------- */

interface Bar {
  episode: Episode;
  top: number;    // index of the row where it stops (rows are newest first)
  bottom: number; // index of its own row
  stops: 'ended' | 'now' | 'later'; // later: carried on past this day
  beganEarlier: boolean; // runs off the bottom
  lane: number;
}

function layOutBars(rows: Row[], episodes: Episode[], bounds: DayBounds): { bars: Bar[]; lanes: number } {
  const spans: Omit<Bar, 'lane'>[] = [];
  for (const episode of episodes) {
    const bottom = rows.findIndex(row => row.key === episodeKey(episode));
    if (bottom < 0) continue;
    const beganEarlier = episode.start < bounds.from;
    if (episode.status === 'ongoing' || episode.end >= bounds.to) {
      spans.push({ episode, bottom, beganEarlier, top: 0, stops: rows[0].type === 'now' ? 'now' : 'later' });
    } else {
      // Up to the newest row logged while it lasted, or just its own row.
      const lastDuring = rows.findIndex((row, i) =>
        i < bottom && (row.type === 'entry' || row.type === 'checkin' || row.type === 'episode')
        && row.time !== null && row.time >= episode.start && row.time <= episode.end);
      spans.push({ episode, bottom, beganEarlier, top: lastDuring < 0 ? bottom : lastDuring, stops: 'ended' });
    }
  }

  // Oldest first, each in the first lane that's free: one whose last bar stopped below this one's row.
  // (Not in it: a bar that stops fills most of its last row, so this one's dot would land on it.)
  const laneTops: number[] = []; // the top row of each lane's latest bar
  const bars = spans
    .sort((a, b) => b.bottom - a.bottom)
    .map(span => {
      let lane = laneTops.findIndex(top => top > span.bottom);
      if (lane < 0) lane = laneTops.length;
      laneTops[lane] = span.top;
      return { ...span, lane };
    });
  return { bars, lanes: laneTops.length };
}

function segmentAt(bar: Bar, row: number): Segment {
  const isStart = row === bar.bottom && !bar.beganEarlier;
  if (row === bar.top && bar.stops === 'now') return 'now';
  if (row === bar.top && bar.stops === 'ended') return isStart ? 'start-end' : 'end';
  return isStart ? 'start' : 'through';
}
