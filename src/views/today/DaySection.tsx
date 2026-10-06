import { useState, type CSSProperties } from 'react';
import { useData } from '../../hooks';
import { MINUTE_MS, clockTime, dayKey, dayLabel, dayStart, formatDuration, formatTime, nextDay, startedAt } from '../../lib/util';
import {
  allEpisodes, daysWithEntries, entryLabel, entryText, entryTime, liveEntries, sortedTrackers,
  type Data, type Entry, type Episode,
} from '../../lib/model';
import { deleteEntry, editEntry } from '../../lib/actions';
import { colorStyle } from '../../components/style';

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
}

/** A day's bounds in ms. Not always 24 hours apart: 23 or 25 on the days the clocks change. */
interface DayBounds {
  from: number;
  to: number;
}

/** Rows further apart than this get a divider showing the gap. */
const GAP_MS = 60 * MINUTE_MS;

export function DaySection({ shownDay, onShowDay }: Props) {
  const data = useData();
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [openCheckin, setOpenCheckin] = useState<string | null>(null);

  const days = daysWithEntries(data);
  const day = days.includes(shownDay) ? shownDay : dayKey(Date.now());
  const position = days.indexOf(day);
  const step = (direction: -1 | 1) => {
    const next = days[position + direction];
    if (!next) return;
    onShowDay(next);
    setOpenEntryId(null);
    setOpenCheckin(null);
  };

  const bounds = { from: dayStart(day), to: dayStart(nextDay(day)) };
  const dayEntries = liveEntries(data).filter(e => entryTime(e) >= bounds.from && entryTime(e) < bounds.to);
  const episodes = allEpisodes(data).filter(e => e.end > bounds.from && e.start < bounds.to);

  return (
    <section className="day-section" aria-labelledby="day-heading">
      <div className="row-between">
        <h2 id="day-heading">Day</h2>
        <div className="day-nav">
          <button className="icon-button" id="previous-day" type="button" aria-label="Previous day"
            disabled={position <= 0} onClick={() => step(-1)}>‹</button>
          <span className="day-name">{dayLabel(day)}</span>
          <button className="icon-button" id="next-day" type="button" aria-label="Next day"
            disabled={position >= days.length - 1} onClick={() => step(1)}>›</button>
        </div>
      </div>
      <div className="panel stack">
        <DayTotals bounds={bounds} entries={dayEntries} episodes={episodes} />
        <DayTimeline
          bounds={bounds}
          entries={dayEntries}
          episodes={episodes}
          openEntryId={openEntryId}
          openCheckin={openCheckin}
          onToggleEntry={id => setOpenEntryId(openEntryId === id ? null : id)}
          onToggleCheckin={key => setOpenCheckin(openCheckin === key ? null : key)}
          onCloseEntry={() => setOpenEntryId(null)}
        />
      </div>
    </section>
  );
}

/* ---------- totals ---------- */

/** "Headache 2× · 3 h 05 min", "Coffee 3×", "2 check-ins": what the day adds up to. */
function DayTotals({ bounds, entries, episodes }: { bounds: DayBounds; entries: Entry[]; episodes: Episode[] }) {
  const data = useData();
  const totals: { key: string; color: string; text: string }[] = [];
  for (const tracker of sortedTrackers(data, 'episode', { includeArchived: true })) {
    const mine = episodes.filter(e => e.trackerId === tracker.id);
    if (!mine.length) continue;
    // Clipped to this day, for episodes that cross midnight.
    const ms = mine.reduce((sum, e) => sum + Math.min(e.end, bounds.to) - Math.max(e.start, bounds.from), 0);
    totals.push({ key: tracker.id, color: tracker.color, text: `${tracker.name} ${mine.length}× · ${formatDuration(ms)}` });
  }
  for (const tracker of sortedTrackers(data, 'moment', { includeArchived: true })) {
    const count = entries.filter(e => e.tracker_id === tracker.id && e.kind === 'moment').length;
    if (count) totals.push({ key: tracker.id, color: tracker.color, text: `${tracker.name} ${count}×` });
  }
  const checkins = new Set(entries.filter(e => e.kind === 'answer').map(checkinKey)).size;
  if (checkins) totals.push({ key: 'checkins', color: 'slate', text: `${checkins} ${checkins === 1 ? 'check-in' : 'check-ins'}` });

  if (!totals.length) return null;
  return (
    <p className="day-totals">
      {totals.map(total => (
        <span key={total.key} className="day-total" style={colorStyle(total.color)}>{total.text}</span>
      ))}
    </p>
  );
}

/* ---------- rows ---------- */

const checkinKey = (answer: Entry) => answer.checkin_id || 'at ' + answer.occurred_at;

/** One row of the timeline. Newest first; episodes that cross the day's edges get an edge row. */
type Row =
  | { type: 'entry'; key: string; time: number; entry: Entry; nested?: boolean }
  | { type: 'checkin'; key: string; time: number; answers: Entry[] }
  | { type: 'gap'; key: string; ms: number }
  | { type: 'edge'; key: string; episode: Episode; at: 'top' | 'bottom' };

const edgeKey = (at: 'top' | 'bottom', episode: Episode) => `${at}:${episode.id}`;

/** Among entries at the same moment, the ones that close something come above the ones that open it. */
const KIND_ORDER: Record<string, number> = { end: 0, level: 1, moment: 2, answer: 2, start: 3 };

function buildRows(data: Data, entries: Entry[], episodes: Episode[], bounds: DayBounds, openCheckin: string | null): Row[] {
  const sortOrder = (trackerId: string) => data.trackers.get(trackerId)?.sort_order ?? 0;
  const timed: (Row & { time: number })[] = [];
  const checkins = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.kind !== 'answer') timed.push({ type: 'entry', key: e.id, time: entryTime(e), entry: e });
    else checkins.set(checkinKey(e), [...(checkins.get(checkinKey(e)) ?? []), e]);
  }
  for (const [key, answers] of checkins) {
    answers.sort((a, b) => sortOrder(a.tracker_id) - sortOrder(b.tracker_id));
    timed.push({ type: 'checkin', key, time: entryTime(answers[0]), answers });
  }
  const kindOf = (row: Row) => (row.type === 'entry' ? row.entry.kind : 'answer');
  timed.sort((a, b) => b.time - a.time || KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] || (a.key < b.key ? -1 : 1));

  const rows: Row[] = episodes
    .filter(e => e.status === 'ongoing' || e.end >= bounds.to)
    .sort((a, b) => b.end - a.end)
    .map(episode => ({ type: 'edge', key: edgeKey('top', episode), episode, at: 'top' }));
  timed.forEach((row, i) => {
    const newer = timed[i - 1];
    if (newer && newer.time - row.time >= GAP_MS) rows.push({ type: 'gap', key: 'gap:' + row.key, ms: newer.time - row.time });
    rows.push(row);
    if (row.type === 'checkin' && row.key === openCheckin) {
      for (const answer of row.answers) rows.push({ type: 'entry', key: answer.id, time: row.time, entry: answer, nested: true });
    }
  });
  for (const episode of episodes.filter(e => e.start < bounds.from).sort((a, b) => b.start - a.start)) {
    rows.push({ type: 'edge', key: edgeKey('bottom', episode), episode, at: 'bottom' });
  }
  return rows;
}

/* ---------- episode bars ---------- */

/** How a bar crosses one row: through it, starting at its marker (going up), ending at it, or both. */
type Segment = 'through' | 'start' | 'end' | 'dot';

interface Bar {
  episode: Episode;
  top: number;    // row index where it ends (rows are newest first)
  bottom: number; // row index where it starts
  lane: number;
}

/** Each episode's rows, and a lane for it: side by side when they overlap, sharing a lane when they don't. */
function layOutBars(rows: Row[], entries: Entry[], episodes: Episode[]): { bars: Bar[]; lanes: number } {
  const index = new Map(rows.map((row, i) => [row.type === 'entry' ? row.entry.id : row.key, i]));
  const spans: Omit<Bar, 'lane'>[] = [];
  for (const episode of episodes) {
    const bottom = index.get(episode.id) ?? index.get(edgeKey('bottom', episode));
    // Ended by an end entry, by a restart (the tracker's next start), or past the day's end.
    const restart = entries.find(e => e.tracker_id === episode.trackerId && e.kind === 'start' && entryTime(e) === episode.end);
    const top = index.get(edgeKey('top', episode))
      ?? (episode.endEntryId ? index.get(episode.endEntryId) : restart && index.get(restart.id));
    if (top !== undefined && bottom !== undefined) spans.push({ episode, top, bottom });
  }

  const laneTops: number[] = []; // the top row of each lane's latest bar
  const bars = spans
    .sort((a, b) => b.bottom - a.bottom)
    .map(span => {
      // A lane is free once its last bar has ended at or below this one's start.
      let lane = laneTops.findIndex(top => top >= span.bottom);
      if (lane < 0) lane = laneTops.length;
      laneTops[lane] = span.top;
      return { ...span, lane };
    });
  return { bars, lanes: laneTops.length };
}

/** The bar segments drawn in one row, per lane. Edge rows run the bar off the end of the list. */
function segmentsAt(i: number, row: Row, bars: Bar[], lanes: number): [Bar, Segment][][] {
  const cells: [Bar, Segment][][] = Array.from({ length: lanes }, () => []);
  for (const bar of bars) {
    if (i < bar.top || i > bar.bottom) continue;
    const segment: Segment = row.type === 'edge' || (i !== bar.top && i !== bar.bottom) ? 'through'
      : bar.top === bar.bottom ? 'dot'
      : i === bar.bottom ? 'start' : 'end';
    cells[bar.lane].push([bar, segment]);
  }
  return cells;
}

function Lanes({ cells, below = false }: { cells: [Bar, Segment][][]; below?: boolean }) {
  const data = useData();
  return (
    <span className={below ? 'lanes is-below' : 'lanes'} aria-hidden="true">
      {cells.map((segments, lane) => (
        <span key={lane} className="lane">
          {segments
            // Beside an open editor, only the bars that carry on downwards continue.
            .filter(([, segment]) => !below || segment === 'through' || segment === 'end')
            .map(([bar, segment]) => (
              <span key={bar.episode.id} className={`lane-bar is-${below ? 'through' : segment}`}
                style={colorStyle(data.trackers.get(bar.episode.trackerId)!.color)} />
            ))}
        </span>
      ))}
    </span>
  );
}

/* ---------- the timeline ---------- */

interface TimelineProps {
  bounds: DayBounds;
  entries: Entry[];
  episodes: Episode[];
  openEntryId: string | null;
  openCheckin: string | null;
  onToggleEntry: (entryId: string) => void;
  onToggleCheckin: (key: string) => void;
  onCloseEntry: () => void;
}

/**
 * The day's entries, newest first, with each start/stop episode drawn as a bar beside the rows it spans.
 * Tapping an entry opens a row to change its time or note, or delete it; tapping a check-in shows its answers.
 */
function DayTimeline(props: TimelineProps) {
  const { bounds, entries, episodes, openEntryId, openCheckin, onToggleEntry, onToggleCheckin, onCloseEntry } = props;
  const data = useData();
  const rows = buildRows(data, entries, episodes, bounds, openCheckin);
  const { bars, lanes } = layOutBars(rows, entries, episodes);

  if (!rows.length) {
    return (
      <ul className="day-log" id="day-log" data-lanes={0}>
        <li>
          <p className="empty-note">
            Nothing logged this day. Tap any entry later to change its time, add a note, or delete it.
          </p>
        </li>
      </ul>
    );
  }

  return (
    <ul className="day-log" id="day-log" data-lanes={lanes} style={{ '--lanes': lanes } as CSSProperties}>
      {rows.map((row, i) => {
        const cells = segmentsAt(i, row, bars, lanes);
        switch (row.type) {
          case 'gap':
            return (
              <li key={row.key} className="day-row day-gap">
                <span className="row-body">{formatDuration(row.ms)}</span>
                <Lanes cells={cells} />
              </li>
            );
          case 'edge':
            return (
              <li key={row.key} className="day-row day-edge">
                <EdgeRow row={row} bounds={bounds} />
                <Lanes cells={cells} />
              </li>
            );
          case 'checkin': {
            const isOpen = openCheckin === row.key;
            return (
              <li key={row.key} className="day-row">
                <button type="button" className="entry-row is-checkin" aria-expanded={isOpen} onClick={() => onToggleCheckin(row.key)}>
                  <span className="entry-time mono">{formatTime(row.time)}</span>
                  <span className="row-body">
                    <span className="entry-marker is-answer" style={colorStyle('slate')} />
                    <span className="entry-text">{checkinSummary(data, row.answers)}</span>
                  </span>
                </button>
                <Lanes cells={cells} />
              </li>
            );
          }
          case 'entry': {
            const { entry } = row;
            const tracker = data.trackers.get(entry.tracker_id)!;
            const episode = entry.kind === 'end' ? episodes.find(e => e.endEntryId === entry.id) : undefined;
            const description = entryText(entry, tracker) + (episode ? ` · ${formatDuration(episode.end - episode.start)}` : '');
            // Marker shape: dot for start/stop, diamond for moments, rounded square for check-in answers.
            const marker = entry.kind === 'moment' ? ' is-moment' : entry.kind === 'answer' ? ' is-answer' : '';
            const isOpen = openEntryId === entry.id;
            return (
              <li key={row.key} className={row.nested ? 'day-row is-nested' : 'day-row'}>
                <button type="button" className="entry-row" aria-expanded={isOpen} onClick={() => onToggleEntry(entry.id)}>
                  <span className="entry-time mono">{row.nested ? '' : formatTime(row.time)}</span>
                  <span className="row-body">
                    <span className={'entry-marker' + marker} style={colorStyle(tracker.color)} />
                    <span className="entry-text">
                      {description}
                      {entry.note && <span className="entry-note">{entry.note}</span>}
                    </span>
                  </span>
                </button>
                <Lanes cells={cells} />
                {isOpen && <EntryEditor entry={entry} onDone={onCloseEntry} />}
                {isOpen && <Lanes cells={cells} below />}
              </li>
            );
          }
        }
      })}
    </ul>
  );
}

/** "Check-in · Mood: Good, Water: 3 glasses +2 more": the first few answers, one per question. */
function checkinSummary(data: Data, answers: Entry[]): string {
  const byTracker = new Map<string, Entry[]>();
  for (const answer of answers) byTracker.set(answer.tracker_id, [...(byTracker.get(answer.tracker_id) ?? []), answer]);
  const parts = [...byTracker].map(([trackerId, theirs]) => {
    const tracker = data.trackers.get(trackerId)!;
    return tracker.type === 'number' ? entryText(theirs[0], tracker) : `${tracker.name}: ${theirs.map(entryLabel).join(', ')}`;
  });
  const shown = parts.slice(0, 2).join(', ');
  return `Check-in · ${shown}${parts.length > 2 ? ` +${parts.length - 2} more` : ''}`;
}

/** An episode running past the top of the day (still going, or ended later) or in from the bottom (began earlier). */
function EdgeRow({ row, bounds }: { row: Extract<Row, { type: 'edge' }>; bounds: DayBounds }) {
  const data = useData();
  const { episode } = row;
  const tracker = data.trackers.get(episode.trackerId)!;
  const now = Date.now();
  const runningToday = episode.status === 'ongoing' && now >= bounds.from && now < bounds.to;
  const text = row.at === 'bottom' ? `${tracker.name}, since ${startedAt(episode.start)}`
    : runningToday ? `${tracker.name} · ${formatDuration(now - episode.start)} so far`
    : episode.status === 'ongoing' ? `${tracker.name}, still going`
    : `${tracker.name}, until ${startedAt(episode.end)}`;
  return (
    <>
      <span className="entry-time mono">{runningToday ? 'Now' : ''}</span>
      <span className="row-body">
        <span className="entry-marker" style={colorStyle(tracker.color)} />
        <span className="entry-text">{text}</span>
      </span>
    </>
  );
}

/** Change an entry's time (on the same day) or note, or delete it. */
function EntryEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [time, setTime] = useState(() => clockTime(entryTime(entry)));
  const [note, setNote] = useState(entry.note || '');

  const save = () => {
    onDone();
    editEntry(entry.id, time, note);
  };
  const remove = () => {
    onDone();
    deleteEntry(entry.id, 'Deleted');
  };

  return (
    <div className="entry-editor">
      <label className="field">
        Time
        <input type="time" value={time} onChange={e => setTime(e.target.value)} />
      </label>
      <label className="field note-field">
        Note
        <input type="text" value={note} placeholder="Optional" onChange={e => setNote(e.target.value)} />
      </label>
      <button type="button" className="button primary" data-save-entry={entry.id} onClick={save}>Save</button>
      <button type="button" className="button danger" onClick={remove}>Delete</button>
    </div>
  );
}
