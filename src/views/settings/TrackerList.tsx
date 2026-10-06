import { Fragment, useState, type ReactNode } from 'react';
import { useData } from '../../hooks';
import { TYPE_LABELS, groupTrackers, sortedTrackers, type Tracker } from '../../lib/model';
import { deleteTracker, moveTracker, restoreTracker } from '../../lib/actions';
import { colorStyle } from '../../components/style';

function TrackerRow({ tracker, children }: { tracker: Tracker; children: ReactNode }) {
  return (
    <li>
      <span className="color-dot" style={colorStyle(tracker.color)} />
      <span className="tracker-name">
        {tracker.name}
        <span className="tracker-type">{TYPE_LABELS[tracker.type]}</span>
      </span>
      <span className="tracker-actions">{children}</span>
    </li>
  );
}

/** Active trackers by group, with buttons to reorder (within the group) and edit. */
export function TrackerList({ onEdit }: { onEdit: (trackerId: string) => void }) {
  const groups = groupTrackers(sortedTrackers(useData()));
  return (
    <div id="trackers">
      {groups.length ? (
        groups.map(([group, trackers]) => (
          <Fragment key={group}>
            <h2 className="tracker-list-group">{group}</h2>
            <ul className="tracker-list">
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
        <p className="empty-note">No trackers yet. Tap Add tracker.</p>
      )}
    </div>
  );
}

/** Archived trackers, to restore or delete. Delete takes a second tap. */
export function ArchivedTrackers() {
  const archived = sortedTrackers(useData(), null, { includeArchived: true }).filter(t => t.archived);
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!archived.length) return null;
  return (
    <details className="archived-trackers" id="archived-trackers">
      <summary>Archived trackers</summary>
      <div className="panel">
        <ul className="tracker-list">
          {archived.map(tracker => (
            <TrackerRow key={tracker.id} tracker={tracker}>
              <button type="button" data-restore-tracker={tracker.id} onClick={() => restoreTracker(tracker.id)}>
                Restore
              </button>
              <button type="button" className={confirming === tracker.id ? 'is-confirming' : undefined}
                data-delete-tracker={tracker.id}
                onClick={() => (confirming === tracker.id ? deleteTracker(tracker.id) : setConfirming(tracker.id))}>
                {confirming === tracker.id ? 'Delete for good?' : 'Delete'}
              </button>
            </TrackerRow>
          ))}
        </ul>
      </div>
    </details>
  );
}
