import { useNow, useData } from '../../hooks';
import { formatDuration } from '../../lib/util';
import {
  activeTrackers, groupTrackers, isWide, runningEpisodes, todayRows, type RunningEpisode, type Tracker,
} from '../../lib/model';
import { logLevel, logMoment, startAtLevel, toggleEpisode } from '../../lib/actions';
import { colorStyle } from '../../components/color';
import { CheckIcon } from '../../components/icons';
import { AddLink } from '../../components/AddLink';
import type { NewTrackerRequest } from '../settings/SettingsView';
import { DaySection } from './DaySection';
import { ArrangeToday } from './ArrangeToday';

const CLOCK_REFRESH_MS = 30_000; // keeps running durations current

interface Props {
  shownDay: string;
  onShowDay: (day: string) => void;
  onAddTracker: (request: NewTrackerRequest) => void;
  arranging: boolean;
  onArrange: (arranging: boolean) => void;
}

export function TodayView({ shownDay, onShowDay, onAddTracker, arranging, onArrange }: Props) {
  const data = useData();
  const now = useNow(CLOCK_REFRESH_MS);
  const running = runningEpisodes(data);
  // Under the headings the person gave them, in the rows they put them in: start/stop tiles and one-tap buttons
  // side by side.
  const groups = groupTrackers(activeTrackers(data, 'episode', 'moment'));

  if (arranging && groups.length) {
    return (
      <section id="view-today" className="stack spacious is-arranging">
        <ArrangeToday data={data} running={new Set(running.keys())} onAddTracker={onAddTracker} onDone={() => onArrange(false)} />
      </section>
    );
  }

  return (
    <section id="view-today" className="stack spacious">
      {groups.length ? (
        <>
          {groups.map(([group, trackers], g) => (
            <section key={group}>
              <div className="row-between section-header">
                <h2>{group}</h2>
                {/* Adding is in Arrange, with moving, so nothing here but the trackers is tapped by mistake. */}
                {g === 0 && (
                  <button type="button" className="add-link" id="arrange-today" onClick={() => onArrange(true)}>
                    Arrange
                  </button>
                )}
              </div>
              <div className="today-grid">
                {todayRows(trackers).flatMap(row => row.map((tracker, i) => (tracker.type === 'episode'
                  ? <EpisodeCard key={tracker.id} tracker={tracker} episode={running.get(tracker.id)} now={now} startsRow={i === 0} />
                  : <MomentButton key={tracker.id} tracker={tracker} startsRow={i === 0} />)))}
              </div>
            </section>
          ))}
        </>
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

/**
 * A one-tap button: half a row like a start/stop tile, but with round ends and a "+" where the tile has its ring.
 * How many times it was logged is in the day's totals below.
 */
function MomentButton({ tracker, startsRow }: { tracker: Tracker; startsRow: boolean }) {
  return (
    <button
      type="button"
      className={startsRow ? 'moment-button starts-row' : 'moment-button'}
      style={colorStyle(tracker.color)}
      data-moment={tracker.id}
      onClick={() => logMoment(tracker.id)}
    >
      <span className="moment-name">{tracker.name}</span>
      <span className="episode-icon"><PlusIcon /></span>
    </button>
  );
}

/**
 * A start/stop button. At rest it's outlined; while running it's filled in, with how long it's been going. One with
 * levels always takes a whole row, its levels underneath: tapping one sets it, or starts it at that level.
 */
function EpisodeCard({ tracker, episode, now, startsRow }: {
  tracker: Tracker; episode?: RunningEpisode; now: number; startsRow: boolean;
}) {
  const levels = (tracker.config.levels || []).filter(Boolean);
  const hasLevels = isWide(tracker);
  const className = ['episode-card', episode && 'is-running', hasLevels && 'has-levels', startsRow && 'starts-row']
    .filter(Boolean).join(' ');
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

/** On a one-tap button, where a start/stop tile has its ring: one tap adds one. */
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 1.5 V12.5 M1.5 7 H12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
