import { useState } from 'react';
import { useData } from '../../hooks';
import { clockTime, dayKey, dayLabel, dayStart, formatDuration, formatTime, nextDay } from '../../lib/util';
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

/** A day's bounds in ms. Not always 24 hours apart: 23 or 25 on the days the clocks change. */
interface DayBounds {
  from: number;
  to: number;
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

  const bounds = { from: dayStart(day), to: dayStart(nextDay(day)) };
  const dayEntries = liveEntries(data).filter(e => entryTime(e) >= bounds.from && entryTime(e) < bounds.to);

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
      <div className="panel">
        <Timeline bounds={bounds} entries={dayEntries} />
      </div>
      <div className="panel">
        <Log
          entries={dayEntries}
          openEntryId={openEntryId}
          onToggle={id => setOpenEntryId(openEntryId === id ? null : id)}
          onClose={() => setOpenEntryId(null)}
        />
      </div>
    </section>
  );
}

/* ---------- timeline ---------- */

const AXIS_LABELS: [hour: number, label: string][] = [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p'], [24, '12a']];

/** A day-long track per start/stop tracker, plus one for the day's moments. */
function Timeline({ bounds: { from, to }, entries }: { bounds: DayBounds; entries: Entry[] }) {
  const data = useData();
  /** Position or width on the day-long track, as a CSS percentage. */
  const percent = (ms: number) => (ms / (to - from) * 100).toFixed(2) + '%';
  const now = Date.now();
  const nowLine = now > from && now < to ? <span className="timeline-now" style={{ left: percent(now - from) }} /> : null;

  const episodesThisDay = allEpisodes(data).filter(e => e.end > from && e.start < to);
  const episodeRows = sortedTrackers(data, 'episode', { includeArchived: true }).flatMap(tracker => {
    // Clip episodes that cross midnight to this day.
    const spans = episodesThisDay
      .filter(e => e.trackerId === tracker.id)
      .map(e => ({ ...e, from: Math.max(e.start, from), to: Math.min(e.end, to) }));
    if (!spans.length) return [];
    const total = spans.reduce((sum, span) => sum + (span.to - span.from), 0);
    return [
      <div className="timeline-row" style={colorStyle(tracker.color)} key={tracker.id}>
        <span className="timeline-label">
          {tracker.name}
          <span className="timeline-total">{spans.length}× · {formatDuration(total)}</span>
        </span>
        <div className="timeline-track">
          {spans.map((span, i) => (
            <span
              key={i}
              className="timeline-span"
              style={{ left: percent(span.from - from), width: percent(span.to - span.from) }}
              title={`${tracker.name} ${formatTime(span.start)}–${span.status === 'ongoing' ? 'now' : formatTime(span.end)}`}
            />
          ))}
          {nowLine}
        </div>
      </div>,
    ];
  });

  const moments = entries.filter(e => e.kind === 'moment');

  if (!episodeRows.length && !moments.length) {
    return (
      <div className="timeline">
        <p className="empty-note">Start/stop episodes and moments appear here as a timeline.</p>
      </div>
    );
  }
  return (
    <div className="timeline">
      {episodeRows}
      {moments.length > 0 && (
        <div className="timeline-row">
          <span className="timeline-label">
            Moments<span className="timeline-total">{moments.length}×</span>
          </span>
          <div className="timeline-track">
            {moments.map(moment => {
              const tracker = data.trackers.get(moment.tracker_id)!;
              return (
                <span
                  key={moment.id}
                  className="timeline-moment"
                  style={colorStyle(tracker.color, { left: percent(entryTime(moment) - from) })}
                  title={`${tracker.name} ${formatTime(entryTime(moment))}`}
                />
              );
            })}
          </div>
        </div>
      )}
      <div className="timeline-axis">
        <span />
        <div className="timeline-hours">
          {AXIS_LABELS.map(([hour, label]) => (
            <span key={hour} style={{ left: percent(new Date(from).setHours(hour) - from) }}>{label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- log ---------- */

interface LogProps {
  entries: Entry[];
  openEntryId: string | null;
  onToggle: (entryId: string) => void;
  onClose: () => void;
}

/** The day's entries, newest first. Tapping one opens a row to change its time or note, or delete it. */
function Log({ entries, openEntryId, onToggle, onClose }: LogProps) {
  const data = useData();
  const episodeByEnd = episodesByEndEntry(data);

  if (!entries.length) {
    return (
      <ul className="entry-log" id="day-log">
        <li>
          <p className="empty-note">
            Nothing logged this day. Tap any entry later to change its time, add a note, or delete it.
          </p>
        </li>
      </ul>
    );
  }

  return (
    <ul className="entry-log" id="day-log">
      {[...entries].sort((a, b) => entryTime(b) - entryTime(a)).map(entry => {
        const tracker = data.trackers.get(entry.tracker_id)!;
        const episode = entry.kind === 'end' ? episodeByEnd[entry.id] : undefined;
        const description = entryText(entry, tracker) + (episode ? ` · ${formatDuration(episode.end - episode.start)}` : '');
        // Marker shape: dot for start/stop, diamond for moments, rounded square for check-in answers.
        const marker = entry.kind === 'moment' ? ' is-moment' : entry.kind === 'answer' ? ' is-answer' : '';
        const isOpen = openEntryId === entry.id;
        return (
          <li key={entry.id}>
            <button type="button" className="entry-row" aria-expanded={isOpen} onClick={() => onToggle(entry.id)}>
              <span className="entry-time mono">{formatTime(entryTime(entry))}</span>
              <span className={'entry-marker' + marker} style={colorStyle(tracker.color)} />
              <span className="entry-text">
                {description}
                {entry.note && <span className="entry-note">{entry.note}</span>}
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
