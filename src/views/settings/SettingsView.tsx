// The Settings view: trackers (list and editor), sync, and data export.
import { useState } from 'react';
import { useData } from '../../hooks';
import { dayKey, dayLabel, uuid } from '../../lib/util';
import { defaultConfig, entryTime, liveEntries, type Tracker } from '../../lib/model';
import { exportBackup, exportForAnalysis } from '../../lib/export';
import { safely } from '../../lib/toast';
import { TrackerEditor } from './TrackerEditor';
import { ArchivedTrackers, TrackerList } from './TrackerList';
import { SyncPanel } from './SyncPanel';

const newTracker = (): Tracker => ({
  id: uuid(), name: '', type: 'episode', group_name: '', color: 'indigo', config: defaultConfig('episode'), sort_order: 0, archived: false,
});

export function SettingsView() {
  const data = useData();
  const [editing, setEditing] = useState<{ tracker: Tracker; isNew: boolean } | null>(null);

  const editTracker = (id: string) => {
    setEditing({ tracker: data.trackers.get(id)!, isNew: false });
    window.scrollTo(0, 0);
  };

  return (
    <section id="view-settings" className="stack">
      <section>
        <div className="row-between section-header">
          <h2>Trackers</h2>
          <button className="button" id="add-tracker" type="button" onClick={() => setEditing({ tracker: newTracker(), isNew: true })}>
            Add tracker
          </button>
        </div>
        {editing && (
          <TrackerEditor
            key={editing.tracker.id}
            tracker={editing.tracker}
            isNew={editing.isNew}
            onClose={() => setEditing(null)}
          />
        )}
        <div className="panel">
          <TrackerList onEdit={editTracker} />
        </div>
        <ArchivedTrackers />
      </section>

      <section>
        <h2>Sync</h2>
        <div className="panel stack" id="sync-panel">
          <SyncPanel />
        </div>
      </section>

      <section>
        <h2>Your data</h2>
        <div className="panel stack">
          <p className="small muted">
            Everything is saved on this device first. <b>Export for analysis</b> gives one .zip of five spreadsheets (CSV)
            that line up by date and id: daily, check-ins, episodes, entries and trackers. <b>Export backup</b> is
            one file with everything.
          </p>
          <div className="button-row">
            <button className="button primary" id="export-analysis" type="button" onClick={safely(exportForAnalysis)}>
              Export for analysis
            </button>
            <button className="button" id="export-backup" type="button" onClick={safely(exportBackup)}>Export backup</button>
          </div>
          <p className="small muted">{dataStats(liveEntries(data).map(entryTime))}</p>
        </div>
      </section>
    </section>
  );
}

function dataStats(times: number[]): string {
  if (!times.length) return '0 entries on this device.';
  return `${times.length} entries on this device, from ${dayLabel(dayKey(Math.min(...times)))}.`;
}
