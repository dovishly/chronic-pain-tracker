// One day on Today: a timeline of episodes and moments, and the log of entries,
// with arrows to step between days that have entries.
import { useState } from 'react';
import { useData } from '../../hooks';
import { DAY_MS, clockTime, dayKey, dayLabel, dayStart, formatDuration, formatTime } from '../../lib/util';
import {
  allEpisodes, daysWithEntries, entryText, entryTime, episodesByEndEntry, liveEntries, sortedTrackers,
  type Entry,
} from '../../lib/model';
import { deleteEntry, editEntry } from '../../lib/actions';
import { colorStyle } from '../../components/style';

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
}

export function DaySection({ shownDay, onShowDay }: Props) {
  const data = useData();
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  const days = daysWithEntries(data);
  const day = days.includes(shownDay) ? shownDay : dayKey(Date.now());
  const position = days.indexOf(day);
  const step = (direction: -1 | 1) => {
    const next = days[position + direction];
    if (!next) return;
    onShowDay(next);
    setOpenEntryId(null);
  };

  return (
    <section aria-labelledby="day-h">
      <div className="row-between">
        <h2 id="day-h" style={{ margin: 0 }}>Day</h2>
        <div className="dnav">
          <button className="iconbtn" id="prevDay" type="button" aria-label="Previous day"
            disabled={position <= 0} onClick={() => step(-1)}>‹</button>
          <span className="dayname" id="dayName">{dayLabel(day)}</span>
          <button className="iconbtn" id="nextDay" type="button" aria-label="Next day"
            disabled={position >= days.length - 1} onClick={() => step(1)}>›</button>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 10 }}>
        <Timeline dayStartMs={dayStart(day)} />
      </div>
      <div className="panel" style={{ marginTop: 10 }}>
        <Log
          dayStartMs={dayStart(day)}
          openEntryId={openEntryId}
          onToggle={id => setOpenEntryId(openEntryId === id ? null : id)}
          onClose={() => setOpenEntryId(null)}
        />
      </div>
    </section>
  );
}

/* ---------- timeline ---------- */

/** Position or width on a day-long track, as a CSS percentage. */
const percentOfDay = (ms: number) => (ms / DAY_MS * 100).toFixed(2) + '%';

const AXIS_LABELS: [string, string | undefined][] = [
  ['12a', undefined], ['6a', '25%'], ['12p', '50%'], ['6p', '75%'], ['12a', '100%'],
];

/** A day-long track per start/stop tracker, plus one for moments. */
function Timeline({ dayStartMs }: { dayStartMs: number }) {
  const data = useData();
  const dayEndMs = dayStartMs + DAY_MS;
  const now = Date.now();
  const nowLine = now > dayStartMs && now < dayEndMs
    ? <span className="nowline" style={{ left: percentOfDay(now - dayStartMs) }} />
    : null;

  const episodesToday = allEpisodes(data).filter(e => e.end > dayStartMs && e.start < dayEndMs);
  const episodeRows = sortedTrackers(data, 'episode', { includeArchived: true }).flatMap(tracker => {
    // Clip episodes that cross midnight to this day.
    const spans = episodesToday
      .filter(e => e.trackerId === tracker.id)
      .map(e => ({ ...e, from: Math.max(e.start, dayStartMs), to: Math.min(e.end, dayEndMs) }));
    if (!spans.length) return [];
    const total = spans.reduce((sum, span) => sum + (span.to - span.from), 0);
    return [
      <div className="srow" style={colorStyle(tracker.color)} key={tracker.id}>
        <span className="slabel">
          {tracker.name}
          <span className="stotal">{spans.length}× · {formatDuration(total)}</span>
        </span>
        <div className="track">
          {spans.map((span, i) => (
            <span
              key={i}
              className="seg"
              style={{ left: percentOfDay(span.from - dayStartMs), width: percentOfDay(span.to - span.from) }}
              title={`${tracker.name} ${formatTime(span.start)}–${span.live ? 'now' : formatTime(span.end)}`}
            />
          ))}
          {nowLine}
        </div>
      </div>,
    ];
  });

  const moments = liveEntries(data).filter(e => e.kind === 'moment' && entryTime(e) >= dayStartMs && entryTime(e) < dayEndMs);

  if (!episodeRows.length && !moments.length) {
    return (
      <div className="strip" id="strip">
        <p className="empty">Start/stop episodes and moments appear here as a timeline.</p>
      </div>
    );
  }
  return (
    <div className="strip" id="strip">
      {episodeRows}
      {moments.length > 0 && (
        <div className="srow">
          <span className="slabel">
            Moments<span className="stotal">{moments.length}×</span>
          </span>
          <div className="track">
            {moments.map(moment => {
              const tracker = data.trackers.get(moment.tracker_id)!;
              return (
                <span
                  key={moment.id}
                  className="tick"
                  style={colorStyle(tracker.color, { left: percentOfDay(entryTime(moment) - dayStartMs) })}
                  title={`${tracker.name} ${formatTime(entryTime(moment))}`}
                />
              );
            })}
          </div>
        </div>
      )}
      <div className="axis">
        <span />
        <div className="ticks">
          {AXIS_LABELS.map(([label, left], i) => <span key={i} style={left ? { left } : undefined}>{label}</span>)}
        </div>
      </div>
    </div>
  );
}

/* ---------- log ---------- */

interface LogProps {
  dayStartMs: number;
  openEntryId: string | null;
  onToggle: (entryId: string) => void;
  onClose: () => void;
}

/** The day's entries, newest first. Tapping one opens a row to change its time or note, or delete it. */
function Log({ dayStartMs, openEntryId, onToggle, onClose }: LogProps) {
  const data = useData();
  const episodeByEnd = episodesByEndEntry(data);
  const entries = liveEntries(data)
    .filter(e => entryTime(e) >= dayStartMs && entryTime(e) < dayStartMs + DAY_MS)
    .sort((a, b) => entryTime(b) - entryTime(a));

  if (!entries.length) {
    return (
      <ul className="log" id="log">
        <li>
          <p className="empty" style={{ padding: '6px 2px' }}>
            Nothing logged this day. Tap any entry later to change its time, add a note, or delete it.
          </p>
        </li>
      </ul>
    );
  }

  return (
    <ul className="log" id="log">
      {entries.map(entry => {
        const tracker = data.trackers.get(entry.tracker_id)!;
        const episode = entry.kind === 'end' ? episodeByEnd[entry.id] : undefined;
        const description = entryText(entry, tracker) + (episode ? ` · ${formatDuration(episode.end - episode.start)}` : '');
        // Marker shape: dot for start/stop, diamond for moments, rounded square for check-in answers.
        const shape = entry.kind === 'moment' ? ' m' : entry.kind === 'value' ? ' v' : '';
        const isOpen = openEntryId === entry.id;
        return (
          <li key={entry.id}>
            <button type="button" className="lrow" aria-expanded={isOpen} onClick={() => onToggle(entry.id)}>
              <span className="t mono">{formatTime(entryTime(entry))}</span>
              <span className={'d' + shape} style={colorStyle(tracker.color)} />
              <span className="what">
                {description}
                {entry.note && <span className="note">{entry.note}</span>}
              </span>
            </button>
            {isOpen && <EntryEditor entry={entry} onDone={onClose} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Change an entry's time (on the same day) or note, or delete it. */
function EntryEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [time, setTime] = useState(() => clockTime(entryTime(entry)));
  const [note, setNote] = useState(entry.note || '');
  const id = entry.id;

  const save = () => {
    onDone();
    editEntry(id, time, note);
  };
  const remove = () => {
    onDone();
    deleteEntry(id, 'Deleted');
  };

  return (
    <div className="edit">
      <label className="f" htmlFor={`entry-time-${id}`}>
        Time
        <input type="time" id={`entry-time-${id}`} value={time} onChange={e => setTime(e.target.value)} />
      </label>
      <label className="f" htmlFor={`entry-note-${id}`} style={{ flex: '1 1 180px' }}>
        Note
        <input type="text" id={`entry-note-${id}`} value={note} placeholder="Optional" onChange={e => setNote(e.target.value)} />
      </label>
      <button type="button" className="btn primary" data-save-entry={id} onClick={save}>Save</button>
      <button type="button" className="btn danger" onClick={remove}>Delete</button>
    </div>
  );
}
