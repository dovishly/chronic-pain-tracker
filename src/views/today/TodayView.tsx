// The Today view: what's running now, the start/stop and moment buttons, and one day's timeline and log.
import { useNow, useData } from '../../hooks';
import { formatDuration, startedAt } from '../../lib/util';
import { activeEpisodes, groupTrackers, sortedTrackers, type ActiveEpisode, type Tracker } from '../../lib/model';
import { logLevel, logMoment, toggleEpisode } from '../../lib/actions';
import { colorStyle } from '../../components/style';
import { DaySection } from './DaySection';

const CLOCK_REFRESH_MS = 30_000; // keeps running durations current

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
}

export function TodayView({ shownDay, onShowDay }: Props) {
  const data = useData();
  const now = useNow(CLOCK_REFRESH_MS);
  const active = activeEpisodes(data);
  const episodeGroups = groupTrackers(sortedTrackers(data, 'episode'));
  const moments = sortedTrackers(data, 'moment');

  return (
    <section id="view-today" className="stack" style={{ gap: 22 }}>
      <section aria-labelledby="now-h">
        <h2 id="now-h">On now</h2>
        <div className="now" id="now">
          {Object.keys(active).length ? (
            Object.entries(active).map(([trackerId, episode]) => (
              <RunningPill key={trackerId} tracker={data.trackers.get(trackerId)!} episode={episode} now={now} />
            ))
          ) : (
            <span className="empty">Nothing running. Tap a button below when something starts, and again when it stops.</span>
          )}
        </div>
      </section>

      <div id="episodes" className="stack" style={{ gap: 22 }}>
        {episodeGroups.length ? (
          episodeGroups.map(([group, trackers]) => (
            <section key={group}>
              <h2>{group}</h2>
              <div className="grid">
                {trackers.map(tracker => (
                  <EpisodeCard key={tracker.id} tracker={tracker} episode={active[tracker.id]} now={now} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <p className="empty">No start/stop trackers yet. Add one in Settings.</p>
        )}
      </div>

      {moments.length > 0 && (
        <section aria-labelledby="marks-h" id="marksWrap">
          <h2 id="marks-h">Moments</h2>
          <div className="marks" id="marks">
            {moments.map(tracker => (
              <button
                key={tracker.id}
                type="button"
                className="mark"
                style={colorStyle(tracker.color)}
                data-moment={tracker.id}
                onClick={() => logMoment(tracker.id)}
              >
                {tracker.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <DaySection shownDay={shownDay} onShowDay={onShowDay} />
    </section>
  );
}

/** A running episode at the top of Today. Tapping it ends the episode. */
function RunningPill({ tracker, episode, now }: { tracker: Tracker; episode: ActiveEpisode; now: number }) {
  return (
    <button
      type="button"
      className="pill"
      style={colorStyle(tracker.color)}
      data-episode={tracker.id}
      aria-label={`End ${tracker.name}, running since ${startedAt(episode.since)}`}
      onClick={() => toggleEpisode(tracker.id)}
    >
      {tracker.name}
      {episode.label ? ` · ${episode.label}` : ''}
      <span className="mono">{formatDuration(now - episode.since)}</span>
    </button>
  );
}

/** A start/stop button. While running, it shows how long, plus severity buttons if the tracker has levels. */
function EpisodeCard({ tracker, episode, now }: { tracker: Tracker; episode?: ActiveEpisode; now: number }) {
  const levels = (tracker.config.levels || []).filter(Boolean);
  const status = episode
    ? `Since ${startedAt(episode.since)} · ${formatDuration(now - episode.since)} · tap to end`
    : 'Tap when it starts';

  return (
    <div className={episode ? 'card on' : 'card'} style={colorStyle(tracker.color)}>
      <button
        type="button"
        className="main"
        data-episode={tracker.id}
        aria-pressed={!!episode}
        onClick={() => toggleEpisode(tracker.id)}
      >
        <span className="name">
          <span className="dot" />
          <span>{tracker.name}</span>
        </span>
        <span className="sub">{status}</span>
      </button>
      {episode && levels.length > 0 && (
        <div className="levels" role="group" aria-label={`${tracker.name} level`}>
          {levels.map((label, i) => (
            <button
              key={i}
              type="button"
              data-level={i + 1}
              aria-label={label}
              title={label}
              aria-pressed={episode.level === i + 1}
              onClick={() => logLevel(tracker.id, i + 1)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
