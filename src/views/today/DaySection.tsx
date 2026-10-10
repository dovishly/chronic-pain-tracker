// The bottom of Today: one day at a time, with its totals and its log (laid out in dayLog.ts).
// Tapping a row opens it for editing; tapping a check-in shows its answers.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useData } from '../../hooks';
import {
  dayBounds, dayKey, dayLabel, formatDayTime, formatDuration, formatTime, groupBy, type DayBounds,
} from '../../lib/util';
import {
  allEpisodes, allTrackers, dayTotals, daysWithEntries, entryLabel, entryText, entryTime, episodeNotes, liveEntries,
  type Data, type Entry, type Episode,
} from '../../lib/model';
import { colorStyle } from '../../components/color';
import { layOutDay, type BarPiece, type Line } from './dayLog';
import { EntryEditor, EpisodeEditor } from './EntryEditors';

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
}

export function DaySection({ shownDay, onShowDay }: Props) {
  const data = useData();
  const [openId, setOpenId] = useState<string | null>(null); // the entry or episode being edited
  const [openCheckin, setOpenCheckin] = useState<string | null>(null);

  const days = daysWithEntries(data);
  const day = days.includes(shownDay) ? shownDay : dayKey(Date.now());
  const position = days.indexOf(day);
  const step = (direction: -1 | 1) => {
    const next = days[position + direction];
    if (!next) return;
    onShowDay(next);
    setOpenId(null);
    setOpenCheckin(null);
  };

  const bounds = dayBounds(day);
  const entries = liveEntries(data).filter(e => entryTime(e) >= bounds.from && entryTime(e) < bounds.to);
  const episodes = allEpisodes(data).filter(e => e.end > bounds.from && e.start < bounds.to);
  const { lines, lanes } = layOutDay(data, entries, episodes, bounds, Date.now(), openCheckin);
  const toggle = (id: string) => setOpenId(openId === id ? null : id);
  const close = () => setOpenId(null);

  return (
    <section className="day-section stack" aria-labelledby="day-heading">
      <div className="row-between">
        <h2 id="day-heading">Your day</h2>
        <div className="day-nav">
          <button className="icon-button" id="previous-day" type="button" aria-label="Previous day"
            disabled={position <= 0} onClick={() => step(-1)}>‹</button>
          <span className="day-name">{dayLabel(day)}</span>
          <button className="icon-button" id="next-day" type="button" aria-label="Next day"
            disabled={position >= days.length - 1} onClick={() => step(1)}>›</button>
        </div>
      </div>
      <DayTotals bounds={bounds} entries={entries} episodes={episodes} />
      <div className="day-log-panel">
        {lines.every(line => line.row.type === 'now') ? (
          <ul className="day-log" id="day-log" data-lanes={0}>
            <li>
              <p className="empty-note">Nothing logged this day. Tap any entry later to change its time, add a note, or delete it.</p>
            </li>
          </ul>
        ) : (
          <ul className="day-log" id="day-log" data-lanes={lanes} style={{ '--lanes': lanes } as CSSProperties}>
            {lines.map(line => (
              <LogRow key={line.row.key} line={line} bounds={bounds} openId={openId} openCheckin={openCheckin}
                onToggle={toggle} onToggleCheckin={key => setOpenCheckin(openCheckin === key ? null : key)} onClose={close} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * What the day adds up to (see dayTotals()): "Headache 2× · 3 h 05 min", "Coffee 3×", "2 check-ins". An episode
 * carried over from the day before adds its time here, but was counted on the day it started: "Tired · 1 h 30 min".
 */
function DayTotals({ bounds, entries, episodes }: { bounds: DayBounds; entries: Entry[]; episodes: Episode[] }) {
  const trackers = allTrackers(useData());
  const { trackers: byTracker, checkins } = dayTotals(bounds, entries, episodes);
  const totals: { key: string; color: string; text: string }[] = [];
  for (const tracker of trackers.filter(t => t.type === 'episode')) {
    const total = byTracker.get(tracker.id);
    const count = total?.count ? ` ${total.count}×` : '';
    if (total) totals.push({ key: tracker.id, color: tracker.color, text: `${tracker.name}${count} · ${formatDuration(total.ms)}` });
  }
  for (const tracker of trackers.filter(t => t.type === 'moment')) {
    const count = byTracker.get(tracker.id)?.count;
    if (count) totals.push({ key: tracker.id, color: tracker.color, text: `${tracker.name} ${count}×` });
  }
  if (checkins) totals.push({ key: 'checkins', color: 'slate', text: `${checkins} ${checkins === 1 ? 'check-in' : 'check-ins'}` });

  if (!totals.length) return null;
  return (
    <p className="day-totals">
      {totals.map(total => <span key={total.key} className="day-total" style={colorStyle(total.color)}>{total.text}</span>)}
    </p>
  );
}

interface LogRowProps {
  line: Line;
  bounds: DayBounds;
  openId: string | null;
  openCheckin: string | null;
  onToggle: (id: string) => void;
  onToggleCheckin: (key: string) => void;
  onClose: () => void;
}

function LogRow({ line: { row, timeLabel, bars }, bounds, openId, openCheckin, onToggle, onToggleCheckin, onClose }: LogRowProps) {
  const data = useData();
  switch (row.type) {
    case 'now':
      return (
        <li className="day-row day-now">
          <span className="entry-time mono">Now</span>
          <span className="row-body"><span className="now-line" /></span>
          <Lanes bars={bars} />
        </li>
      );

    case 'gap':
      return (
        <li className="day-row day-gap">
          <span className="row-body">{formatDuration(row.ms)}</span>
          <Lanes bars={bars} />
        </li>
      );

    case 'checkin':
      return (
        <li className="day-row">
          <RowButton variant="is-checkin" marker="is-answer" color="slate" time={timeLabel}
            isOpen={openCheckin === row.key} onClick={() => onToggleCheckin(row.key)}>
            {checkinSummary(data, row.answers)}
          </RowButton>
          <Lanes bars={bars} />
        </li>
      );

    case 'episode': {
      const { episode } = row;
      const tracker = data.trackers.get(episode.trackerId)!;
      const isOpen = openId === episode.id;
      return (
        <li className="day-row">
          <RowButton variant="is-episode" color={tracker.color} time={timeLabel}
            note={episodeNotes(data, episode).join(' · ')} isOpen={isOpen} onClick={() => onToggle(episode.id)}>
            <span className="entry-name" style={colorStyle(tracker.color)}>{tracker.name}</span>
            {episodeDetails(episode, bounds)}
          </RowButton>
          <Lanes bars={bars} />
          {isOpen && <EpisodeEditor episode={episode} onDone={onClose} />}
          {isOpen && <Lanes bars={bars} below />}
        </li>
      );
    }

    case 'entry': {
      const { entry } = row;
      const tracker = data.trackers.get(entry.tracker_id)!;
      const isOpen = openId === entry.id;
      // Marker shape: dot for start/stop, diamond for moments, rounded square for check-in answers.
      const marker = entry.kind === 'moment' ? 'is-moment' : entry.kind === 'answer' ? 'is-answer' : undefined;
      return (
        <li className={row.nested ? 'day-row is-nested' : 'day-row'}>
          <RowButton marker={marker} color={tracker.color} time={timeLabel} note={entry.note}
            isOpen={isOpen} onClick={() => onToggle(entry.id)}>
            {entryText(entry, tracker)}
          </RowButton>
          <Lanes bars={bars} />
          {isOpen && <EntryEditor entry={entry} onDone={onClose} />}
          {isOpen && <Lanes bars={bars} below />}
        </li>
      );
    }
  }
}

interface RowButtonProps {
  variant?: string; // extra class: is-checkin, is-episode
  marker?: string;  // marker shape class: is-moment, is-answer
  color: string;
  time: string;
  note?: string | null;
  isOpen: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** A row you can tap: its time, a marker in the tracker's color, and what was logged, with any note under it. */
function RowButton({ variant, marker, color, time, note, isOpen, onClick, children }: RowButtonProps) {
  return (
    <button type="button" className={variant ? `entry-row ${variant}` : 'entry-row'} aria-expanded={isOpen} onClick={onClick}>
      <span className="entry-time mono">{time}</span>
      <span className="row-body">
        <span className={marker ? `entry-marker ${marker}` : 'entry-marker'} style={colorStyle(color)} />
        <span className="entry-text">
          {children}
          {note ? <span className="entry-note">{note}</span> : null}
        </span>
      </span>
    </button>
  );
}

/** The bars beside a row, a lane each. Beside an open editor (below), only the bars that carry on downwards continue. */
function Lanes({ bars, below = false }: { bars: (BarPiece | null)[]; below?: boolean }) {
  const data = useData();
  return (
    <span className={below ? 'lanes is-below' : 'lanes'} aria-hidden="true">
      {bars.map((piece, lane) => (
        <span key={lane} className="lane">
          {piece && (!below || piece.segment === 'through' || piece.segment === 'end') && (
            <span className={`lane-bar is-${below ? 'through' : piece.segment}`}
              style={colorStyle(data.trackers.get(piece.episode.trackerId)!.color)} />
          )}
        </span>
      ))}
    </span>
  );
}

/** "Check-in · Mood: Good, Water: 3 glasses +2 more": the first few answers, one per question. */
function checkinSummary(data: Data, answers: Entry[]): string {
  const parts = [...groupBy(answers, a => a.tracker_id)].map(([trackerId, theirs]) => {
    const tracker = data.trackers.get(trackerId)!;
    return tracker.type === 'number' ? entryText(theirs[0], tracker) : `${tracker.name}: ${theirs.map(entryLabel).join(', ')}`;
  });
  const more = parts.length > 2 ? ` +${parts.length - 2} more` : '';
  return `Check-in · ${parts.slice(0, 2).join(', ')}${more}`;
}

/**
 * What follows the episode's name: " · until 7:20 PM · 45 min", " · 25 min so far", or for one that began on an
 * earlier day, " · since Mon, Nov 10 10:00 PM · until 7:00 AM · 9 h 00 min".
 */
function episodeDetails(episode: Episode, bounds: DayBounds): string {
  const now = Date.now();
  const parts = [''];
  if (episode.start < bounds.from) parts.push(`since ${formatDayTime(episode.start)}`);
  if (episode.status !== 'ongoing') {
    parts.push(`until ${episode.end < bounds.to ? formatTime(episode.end) : formatDayTime(episode.end)}`);
    parts.push(formatDuration(episode.end - episode.start));
  } else if (now >= bounds.from && now < bounds.to) {
    parts.push(`${formatDuration(now - episode.start)} so far`);
  } else {
    parts.push('still going');
  }
  return parts.join(' · ');
}
