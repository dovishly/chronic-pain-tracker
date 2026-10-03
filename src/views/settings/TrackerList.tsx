import { Fragment, type ReactNode } from 'react';
import { useData } from '../../hooks';
import { TYPE_LABELS, groupTrackers, sortedTrackers, type Tracker } from '../../lib/model';
import { moveTracker, restoreTracker } from '../../lib/actions';
import { colorStyle } from '../../components/style';

function TrackerRow({ tracker, children }: { tracker: Tracker; children: ReactNode }) {
  return (
    <li>
      <span className="dot" style={colorStyle(tracker.color)} />
      <span className="tn">
        {tracker.name}
        <span className="tt">{TYPE_LABELS[tracker.type]}</span>
      </span>
      <span className="acts">{children}</span>
    </li>
  );
}

/** Active trackers by group, with buttons to reorder (within the group) and edit. */
export function TrackerList({ onEdit }: { onEdit: (trackerId: string) => void }) {
  const groups = groupTrackers(sortedTrackers(useData()));
  return (
    <div id="trackerList">
      {groups.length ? (
        groups.map(([group, trackers]) => (
          <Fragment key={group}>
            <h2 style={{ margin: '10px 0 2px' }}>{group}</h2>
            <ul className="tlist">
              {trackers.map(tracker => (
                <TrackerRow key={tracker.id} tracker={tracker}>
                  <button type="button" data-move-up={tracker.id} aria-label={`Move ${tracker.name} up`}
                    onClick={() => moveTracker(tracker.id, -1)}>↑</button>
                  <button type="button" data-move-down={tracker.id} aria-label={`Move ${tracker.name} down`}
                    onClick={() => moveTracker(tracker.id, 1)}>↓</button>
                  <button type="button" data-edit-tracker={tracker.id} onClick={() => onEdit(tracker.id)}>Edit</button>
                </TrackerRow>
              ))}
            </ul>
          </Fragment>
        ))
      ) : (
        <p className="empty">No trackers yet. Tap Add tracker.</p>
      )}
    </div>
  );
}

export function ArchivedTrackers() {
  const archived = sortedTrackers(useData(), null, { includeArchived: true }).filter(t => t.archived);
  if (!archived.length) return null;
  return (
    <details style={{ marginTop: 10 }} id="archWrap">
      <summary>Archived trackers</summary>
      <div className="panel" style={{ marginTop: 8 }}>
        <ul className="tlist" id="archList">
          {archived.map(tracker => (
            <TrackerRow key={tracker.id} tracker={tracker}>
              <button type="button" data-restore-tracker={tracker.id} onClick={() => restoreTracker(tracker.id)}>
                Restore
              </button>
            </TrackerRow>
          ))}
        </ul>
      </div>
    </details>
  );
}
