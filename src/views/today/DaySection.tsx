import { useState, type CSSProperties } from 'react';
import { useData } from '../../hooks';
import { MINUTE_MS, clockTime, dayKey, dayLabel, dayStart, formatDuration, formatTime, nextDay, startedAt } from '../../lib/util';
import {
  allEpisodes, checkinKey, daysWithEntries, entryLabel, entryText, entryTime, liveEntries, sortedTrackers,
  type Data, type Entry, type Episode,
} from '../../lib/model';
import { deleteEntry, deleteEpisode, editEntry, editEpisode } from '../../lib/actions';
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

/**
 * One row of the timeline, newest first. An episode is one row, where it started (or at the bottom, if it
 * started on an earlier day), and its bar runs up beside whatever was logged while it lasted.
 */
type Row =
  | { type: 'entry'; key: string; time: number; entry: Entry; nested?: boolean }
  | { type: 'checkin'; key: string; time: number; answers: Entry[] }
  | { type: 'episode'; key: string; time: number | null; episode: Episode }
  | { type: 'gap'; key: string; ms: number }
  | { type: 'now'; key: string; time: number }; // at the top of today, where running episodes reach

const episodeKey = (episode: Episode) => 'episode:' + episode.id;
const rowTime = (row: Row) => (row.type === 'gap' ? null : row.time);

/** Among rows at the same moment, the ones that open something go below the rest. */
const rank = (row: Row) => (row.type === 'episode' ? 1 : 0);

function buildRows(
  data: Data, entries: Entry[], episodes: Episode[], bounds: DayBounds, now: number, openCheckin: string | null,
): Row[] {
  const sortOrder = (trackerId: string) => data.trackers.get(trackerId)?.sort_order ?? 0;
  const endIds = new Set(episodes.map(e => e.endEntryId));
  const timed: (Row & { time: number })[] = [];
  const checkins = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.kind === 'answer') checkins.set(checkinKey(e), [...(checkins.get(checkinKey(e)) ?? []), e]);
    // Starts and ends are shown by their episode's row; an end with no start of its own stays visible.
    else if (e.kind !== 'start' && !endIds.has(e.id)) timed.push({ type: 'entry', key: e.id, time: entryTime(e), entry: e });
  }
  for (const [key, answers] of checkins) {
    answers.sort((a, b) => sortOrder(a.tracker_id) - sortOrder(b.tracker_id));
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

/* ---------- episode bars ---------- */

/**
 * How a bar crosses one row: through it; starting at its dot and going up; ending with a ring at the row's
 * top edge (after the last thing logged while it lasted); both, for one with nothing logged during it;
 * or reaching the Now row, still going.
 */
type Segment = 'through' | 'start' | 'end' | 'start-end' | 'now';

interface Bar {
  episode: Episode;
  top: number;    // row index where it stops (rows are newest first)
  bottom: number; // row index of its own row
  // ended: stops at top, with a ring; now: still going, up to the Now row; later: runs off the top, since
  // it carried on past this (earlier) day.
  ending: 'ended' | 'now' | 'later';
  lane: number;
}

/** Each episode's rows, and a lane for it: side by side when they overlap, sharing a lane when they don't. */
function layOutBars(rows: Row[], episodes: Episode[], bounds: DayBounds): { bars: Bar[]; lanes: number } {
  const spans: Omit<Bar, 'lane'>[] = [];
  for (const episode of episodes) {
    const bottom = rows.findIndex(row => row.key === episodeKey(episode));
    if (bottom < 0) continue;
    const openTop = episode.status === 'ongoing' || episode.end >= bounds.to;
    // Up to the newest row logged while it lasted.
    const during = rows.findIndex((row, i) => {
      const time = rowTime(row);
      return i < bottom && row.type !== 'now' && time !== null && time >= episode.start && time <= episode.end;
    });
    const ending = !openTop ? 'ended' : rows[0].type === 'now' ? 'now' : 'later';
    spans.push({ episode, bottom, ending, top: openTop ? 0 : during < 0 ? bottom : during });
  }

  const laneTops: number[] = []; // the top row of each lane's latest bar
  const bars = spans
    .sort((a, b) => b.bottom - a.bottom)
    .map(span => {
      // A lane is free once its last bar has stopped below this one's row. (Not in it: a bar that stops
      // fills most of its last row, so this one's dot would land on it.)
      let lane = laneTops.findIndex(top => top > span.bottom);
      if (lane < 0) lane = laneTops.length;
      laneTops[lane] = span.top;
      return { ...span, lane };
    });
  return { bars, lanes: laneTops.length };
}

/** The bar segments drawn in one row, per lane. */
function segmentsAt(i: number, rows: Row[], bars: Bar[], lanes: number): [Bar, Segment][][] {
  const cells: [Bar, Segment][][] = Array.from({ length: lanes }, () => []);
  for (const bar of bars) {
    if (i < bar.top || i > bar.bottom) continue;
    const row = rows[bar.bottom];
    const startsEarlier = row.type === 'episode' && row.time === null; // runs off the bottom
    const isStart = i === bar.bottom && !startsEarlier;
    let segment: Segment = isStart ? 'start' : 'through';
    if (i === bar.top && bar.ending === 'now') segment = 'now';
    else if (i === bar.top && bar.ending === 'ended') segment = isStart ? 'start-end' : 'end';
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
 * The day's entries, newest first, with each start/stop episode as one row and a bar beside what happened
 * while it lasted. Tapping a row opens it for editing; tapping a check-in shows its answers.
 */
function DayTimeline(props: TimelineProps) {
  const { bounds, entries, episodes, openEntryId, openCheckin, onToggleEntry, onToggleCheckin, onCloseEntry } = props;
  const data = useData();
  const rows = buildRows(data, entries, episodes, bounds, Date.now(), openCheckin);
  const { bars, lanes } = layOutBars(rows, episodes, bounds);

  if (rows.every(row => row.type === 'now')) {
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

  // A time is shown once, on the newest of the rows that share it.
  let lastTime = '';
  const timeLabel = (row: Row) => {
    if (row.type === 'gap' || row.type === 'now') {
      lastTime = '';
      return '';
    }
    const label = row.time === null || (row.type === 'entry' && row.nested) ? '' : formatTime(row.time);
    if (!label || label === lastTime) return '';
    return (lastTime = label);
  };

  return (
    <ul className="day-log" id="day-log" data-lanes={lanes} style={{ '--lanes': lanes } as CSSProperties}>
      {rows.map((row, i) => {
        const cells = segmentsAt(i, rows, bars, lanes);
        const time = timeLabel(row);
        switch (row.type) {
          case 'now':
            return (
              <li key={row.key} className="day-row day-now">
                <span className="entry-time mono">Now</span>
                <span className="row-body"><span className="now-line" /></span>
                <Lanes cells={cells} />
              </li>
            );
          case 'gap':
            return (
              <li key={row.key} className="day-row day-gap">
                <span className="row-body">{formatDuration(row.ms)}</span>
                <Lanes cells={cells} />
              </li>
            );
          case 'checkin': {
            const isOpen = openCheckin === row.key;
            return (
              <li key={row.key} className="day-row">
                <button type="button" className="entry-row is-checkin" aria-expanded={isOpen} onClick={() => onToggleCheckin(row.key)}>
                  <span className="entry-time mono">{time}</span>
                  <span className="row-body">
                    <span className="entry-marker is-answer" style={colorStyle('slate')} />
                    <span className="entry-text">{checkinSummary(data, row.answers)}</span>
                  </span>
                </button>
                <Lanes cells={cells} />
              </li>
            );
          }
          case 'episode': {
            const { episode } = row;
            const tracker = data.trackers.get(episode.trackerId)!;
            const notes = [episode.id, episode.endEntryId].map(id => (id ? data.entries.get(id)?.note : null)).filter(Boolean);
            const isOpen = openEntryId === episode.id;
            return (
              <li key={row.key} className="day-row">
                <button type="button" className="entry-row is-episode" aria-expanded={isOpen} onClick={() => onToggleEntry(episode.id)}>
                  <span className="entry-time mono">{time}</span>
                  <span className="row-body">
                    <span className="entry-marker" style={colorStyle(tracker.color)} />
                    <span className="entry-text">
                      {episodeText(episode, tracker.name, bounds)}
                      {notes.length > 0 && <span className="entry-note">{notes.join(' · ')}</span>}
                    </span>
                  </span>
                </button>
                <Lanes cells={cells} />
                {isOpen && <EpisodeEditor episode={episode} onDone={onCloseEntry} />}
                {isOpen && <Lanes cells={cells} below />}
              </li>
            );
          }
          case 'entry': {
            const { entry } = row;
            const tracker = data.trackers.get(entry.tracker_id)!;
            // Marker shape: dot for start/stop, diamond for moments, rounded square for check-in answers.
            const marker = entry.kind === 'moment' ? ' is-moment' : entry.kind === 'answer' ? ' is-answer' : '';
            const isOpen = openEntryId === entry.id;
            return (
              <li key={row.key} className={row.nested ? 'day-row is-nested' : 'day-row'}>
                <button type="button" className="entry-row" aria-expanded={isOpen} onClick={() => onToggleEntry(entry.id)}>
                  <span className="entry-time mono">{time}</span>
                  <span className="row-body">
                    <span className={'entry-marker' + marker} style={colorStyle(tracker.color)} />
                    <span className="entry-text">
                      {entryText(entry, tracker)}
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

/**
 * "Tired · until 7:20 PM · 45 min", "Headache · 25 min so far", or for one that began on an earlier day,
 * "Tired · since Mon, Nov 10 10:00 PM · until 7:00 AM · 9 h 00 min".
 */
function episodeText(episode: Episode, name: string, bounds: DayBounds): string {
  const now = Date.now();
  const parts = [name];
  if (episode.start < bounds.from) parts.push(`since ${startedAt(episode.start)}`);
  if (episode.status !== 'ongoing') {
    parts.push(`until ${episode.end < bounds.to ? formatTime(episode.end) : startedAt(episode.end)}`);
    parts.push(formatDuration(episode.end - episode.start));
  } else if (now >= bounds.from && now < bounds.to) {
    parts.push(`${formatDuration(now - episode.start)} so far`);
  } else {
    parts.push('still going');
  }
  return parts.join(' · ');
}

/** An episode's start and end times, each on its own day, and its note; or delete the whole episode. */
function EpisodeEditor({ episode, onDone }: { episode: Episode; onDone: () => void }) {
  const data = useData();
  // Shown together, as on the row; saving keeps the note on the start.
  const notes = [episode.id, episode.endEntryId].map(id => (id ? data.entries.get(id)?.note : null)).filter(Boolean);
  const [start, setStart] = useState(() => clockTime(episode.start));
  const [end, setEnd] = useState(() => (episode.endEntryId ? clockTime(episode.end) : ''));
  const [note, setNote] = useState(() => notes.join(' · '));

  const save = async () => {
    if (await editEpisode(episode.id, start, note, episode.endEntryId, end)) onDone();
  };
  const remove = () => {
    onDone();
    deleteEpisode(episode.id, episode.endEntryId);
  };

  return (
    <div className="entry-editor">
      <label className="field">
        Start
        <input type="time" value={start} onChange={e => setStart(e.target.value)} />
      </label>
      {episode.endEntryId && (
        <label className="field">
          End
          <input type="time" value={end} onChange={e => setEnd(e.target.value)} />
        </label>
      )}
      <label className="field note-field">
        Note
        <input type="text" value={note} placeholder="Optional" onChange={e => setNote(e.target.value)} />
      </label>
      <button type="button" className="button primary" data-save-entry={episode.id} onClick={save}>Save</button>
      <button type="button" className="button danger" onClick={remove}>Delete</button>
    </div>
  );
}

/** Change an entry's time (on the same day) or note, or delete it. */
function EntryEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [time, setTime] = useState(() => clockTime(entryTime(entry)));
  const [note, setNote] = useState(entry.note || '');

  const save = async () => {
    if (await editEntry(entry.id, time, note)) onDone();
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
