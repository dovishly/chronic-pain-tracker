import { useNow, useData } from '../../hooks';
import { dayKey, dayStart, formatDuration } from '../../lib/util';
import {
  activeTrackers, entryTime, groupTrackers, liveEntries, runningEpisodes, type Data, type RunningEpisode, type Tracker,
} from '../../lib/model';
import { logLevel, logMoment, startAtLevel, toggleEpisode } from '../../lib/actions';
import { colorStyle } from '../../components/color';
import { CheckIcon } from '../../components/icons';
import { AddLink } from '../../components/AddLink';
import type { NewTrackerRequest } from '../settings/SettingsView';
import { DaySection } from './DaySection';

const CLOCK_REFRESH_MS = 30_000; // keeps running durations current

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
  onAddTracker: (request: NewTrackerRequest) => void;
}

export function TodayView({ shownDay, onShowDay, onAddTracker }: Props) {
  const data = useData();
  const now = useNow(CLOCK_REFRESH_MS);
  const running = runningEpisodes(data);
  // Under the headings the person gave them, start/stop tiles first and one-tap buttons after.
  const groups = groupTrackers(activeTrackers(data, 'episode', 'moment'));
  const momentsToday = countMomentsToday(data, now);

  return (
    <section id="view-today" className="stack spacious">
      {groups.length ? (
        groups.map(([group, trackers]) => {
          const episodes = trackers.filter(t => t.type === 'episode');
          const moments = trackers.filter(t => t.type === 'moment');
          return (
            <section key={group}>
              <div className="row-between section-header">
                <h2>{group}</h2>
                {/* A new one of the kind the section already has, start/stop first. */}
                <AddLink label={`Add to ${group}`}
                  onClick={() => onAddTracker({ type: episodes.length ? 'episode' : 'moment', group })} />
              </div>
              <div className="today-group">
                {episodes.length > 0 && (
                  <div className="episode-grid">
                    {episodes.map(tracker => (
                      <EpisodeCard key={tracker.id} tracker={tracker} episode={running.get(tracker.id)} now={now} />
                    ))}
                  </div>
                )}
                {moments.length > 0 && (
                  <div className="moment-buttons">
                    {moments.map(tracker => (
                      <MomentButton key={tracker.id} tracker={tracker} count={momentsToday.get(tracker.id) ?? 0} />
                    ))}
                  </div>
                )}
              </div>
            </section>
          );
        })
      ) : (
        <section>
          <div className="row-between section-header">
            <h2>Symptoms</h2>
            <AddLink label="Add to Symptoms" onClick={() => onAddTracker({ type: 'episode', group: 'Symptoms' })} />
          </div>
          <p className="empty-note">Nothing to tap yet. Add something that comes and goes, like pain, or happens at a moment, like a dose of medication.</p>
        </section>
      )}

      <DaySection shownDay={shownDay} onShowDay={onShowDay} />
    </section>
  );
}

/** A one-tap button: a pill with a "+", and how many times it's been logged today. */
function MomentButton({ tracker, count }: { tracker: Tracker; count: number }) {
  return (
    <button
      type="button"
      className="moment-button"
      style={colorStyle(tracker.color)}
      data-moment={tracker.id}
      aria-label={count ? `${tracker.name}, ${count} today` : undefined}
      onClick={() => logMoment(tracker.id)}
    >
      <span className="moment-plus" aria-hidden="true">+</span>
      {tracker.name}
      {count > 0 && <span className="moment-count mono">×{count}</span>}
    </button>
  );
}

/** How many times each moment tracker has been logged since midnight, by tracker id. */
function countMomentsToday(data: Data, now: number): Map<string, number> {
  const since = dayStart(dayKey(now));
  const counts = new Map<string, number>();
  for (const entry of liveEntries(data)) {
    if (entry.kind === 'moment' && entryTime(entry) >= since) counts.set(entry.tracker_id, (counts.get(entry.tracker_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * A start/stop button. At rest it's outlined; while running it's filled in, with how long it's been going. One with
 * levels always takes a whole row, its levels underneath: tapping one sets it, or starts it at that level.
 */
function EpisodeCard({ tracker, episode, now }: { tracker: Tracker; episode?: RunningEpisode; now: number }) {
  const levels = (tracker.config.levels || []).filter(Boolean);
  const hasLevels = levels.length > 0;
  const className = ['episode-card', episode && 'is-running', hasLevels && 'has-levels'].filter(Boolean).join(' ');
  const pickLevel = (level: number) => (episode ? logLevel(tracker.id, level) : startAtLevel(tracker.id, level));

  return (
    <div className={className} style={colorStyle(tracker.color)}>
      <button
        type="button"
        className="episode-button"
        data-episode={tracker.id}
        aria-pressed={!!episode}
        onClick={() => toggleEpisode(tracker.id)}
      >
        {/* Laid out the same at rest and running (see .episode-button), so nothing moves when it's tapped. */}
        <span className="episode-name">{tracker.name}</span>
        {episode && <span className="episode-time">{formatDuration(now - episode.since)}</span>}
        <span className="episode-icon"><StateIcon running={!!episode} /></span>
      </button>
      {hasLevels && (
        <div className="level-buttons" role="group"
          aria-label={episode ? `${tracker.name} level` : `Start ${tracker.name} at a level`}>
          {levels.map((label, i) => {
            const picked = episode?.level === i + 1;
            return (
              <button key={i} type="button" data-level={i + 1} aria-pressed={picked} onClick={() => pickLevel(i + 1)}>
                {picked && <CheckIcon />}
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What a start/stop tile is doing: an empty ring at rest, filled in with a dot while running. It
 * tells a start/stop tile from a one-tap button, which has a "+" instead.
 */
function StateIcon({ running }: { running: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {running && <circle cx="7" cy="7" r="3" fill="currentColor" />}
    </svg>
  );
}
