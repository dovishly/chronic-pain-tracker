import { useNow, useData } from '../../hooks';
import { dayKey, dayStart, formatDuration } from '../../lib/util';
import {
  activeTrackers, entryTime, groupTrackers, liveEntries, runningEpisodes, type Data, type RunningEpisode, type Tracker,
} from '../../lib/model';
import { logLevel, logMoment, startAtLevel, toggleEpisode } from '../../lib/actions';
import { colorStyle } from '../../components/color';
import { CheckIcon } from '../../components/icons';
import { DaySection } from './DaySection';

const CLOCK_REFRESH_MS = 30_000; // keeps running durations current

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
}

export function TodayView({ shownDay, onShowDay }: Props) {
  const data = useData();
  const now = useNow(CLOCK_REFRESH_MS);
  const running = runningEpisodes(data);
  const episodeGroups = groupTrackers(activeTrackers(data, 'episode'));
  const moments = activeTrackers(data, 'moment');
  const momentsToday = countMomentsToday(data, now);

  return (
    <section id="view-today" className="stack spacious">
      <div className="stack spacious">
        {episodeGroups.length ? (
          episodeGroups.map(([group, trackers]) => (
            <section key={group}>
              <h2>{group}</h2>
              <div className="episode-grid">
                {trackers.map(tracker => (
                  <EpisodeCard key={tracker.id} tracker={tracker} episode={running.get(tracker.id)} now={now} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <p className="empty-note">No start/stop trackers yet. Add one in Settings.</p>
        )}
      </div>

      {moments.length > 0 && (
        <section aria-labelledby="moments-heading">
          <h2 id="moments-heading">Moments</h2>
          <div className="moment-buttons" id="moments">
            {moments.map(tracker => {
              const count = momentsToday.get(tracker.id) ?? 0;
              return (
                <button
                  key={tracker.id}
                  type="button"
                  className="moment-button"
                  style={colorStyle(tracker.color)}
                  data-moment={tracker.id}
                  aria-label={count ? `${tracker.name}, ${count} today` : undefined}
                  onClick={() => logMoment(tracker.id)}
                >
                  {tracker.name}
                  {count > 0 && <span className="moment-count mono">×{count}</span>}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <DaySection shownDay={shownDay} onShowDay={onShowDay} />
    </section>
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
        <span className="episode-name">{tracker.name}</span>
        {episode && (
          <span className="episode-duration">
            <RunningIcon />
            {formatDuration(now - episode.since)}
          </span>
        )}
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

/** A dot in a ring, beside a running episode's time. */
function RunningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="3" fill="currentColor" />
    </svg>
  );
}
