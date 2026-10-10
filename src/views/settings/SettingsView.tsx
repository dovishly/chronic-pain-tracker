import { useState } from 'react';
import { useData, useSyncState, useTheme } from '../../hooks';
import { setTheme, type ThemeChoice } from '../../lib/theme';
import { CheckIcon } from '../../components/icons';
import { dayKey, dayLabel, uuid } from '../../lib/util';
import { defaultConfig, entryTime, liveEntries, type Tracker } from '../../lib/model';
import { exportBackup, exportForAnalysis } from '../../lib/export';
import { resetDevice, resetEverywhere } from '../../lib/actions';
import { safely } from '../../lib/toast';
import { TrackerEditor } from './TrackerEditor';
import { ArchivedTrackers, TrackerList } from './TrackerList';
import { SyncPanel } from './SyncPanel';

const newTracker = (): Tracker => ({
  id: uuid(), name: '', type: 'episode', group_name: '', color: 'indigo', config: defaultConfig('episode'), sort_order: 0, archived: false, deleted: false,
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

      <section aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <div className="panel stack">
          <Appearance />
        </div>
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

      <section>
        <h2>Start over</h2>
        <div className="panel stack">
          <StartOver />
        </div>
      </section>
    </section>
  );
}

const THEME_CHOICES: [ThemeChoice, string][] = [['phone', 'Match device'], ['light', 'Light'], ['dark', 'Dark']];

/** Light or dark, or whichever the phone is set to. Kept on this phone only. */
function Appearance() {
  const theme = useTheme();
  return (
    <>
      <div className="segmented" id="theme-choice" role="group" aria-labelledby="appearance-heading">
        {THEME_CHOICES.map(([choice, label]) => (
          <button key={choice} type="button" aria-pressed={theme === choice} onClick={() => setTheme(choice)}>
            <CheckIcon />
            {label}
          </button>
        ))}
      </div>
      <p className="small muted">Match device switches between light and dark with your device.</p>
    </>
  );
}

function dataStats(times: number[]): string {
  if (!times.length) return '0 entries on this device.';
  return `${times.length} entries on this device, from ${dayLabel(dayKey(Math.min(...times)))}.`;
}

/** Back to the starter trackers: on this phone only, or (signed in) in the whole account. Each asks first. */
function StartOver() {
  const { signedIn } = useSyncState();
  const [confirming, setConfirming] = useState<'device' | 'everywhere' | null>(null);
  const cancel = (
    <button type="button" className="button" onClick={() => setConfirming(null)}>Cancel</button>
  );

  return (
    <>
      <p className="small muted">Go back to the starter trackers, with no entries.</p>
      <div className="button-row">
        <button type="button" className="button" id="reset-device" onClick={() => setConfirming('device')}>Reset this device</button>
        {signedIn && (
          <button type="button" className="button danger" id="reset-everywhere" onClick={() => setConfirming('everywhere')}>
            Reset everywhere
          </button>
        )}
      </div>
      {confirming === 'device' && (
        <div className="notice stack">
          <p>
            <b>Reset this device?</b> Everything on it is erased, including your Supabase sign-in, and Log Lightly starts
            again with the starter trackers.{' '}
            {signedIn
              ? "Your synced data stays in Supabase: connect and sign in again to get it back. Anything that hasn't synced yet is lost."
              : "There's no other copy, so export a backup first if you might want it."}
          </p>
          <div className="button-row">
            <button type="button" className="button danger" id="reset-device-confirm" onClick={resetDevice}>Erase this device</button>
            {cancel}
          </div>
        </div>
      )}
      {confirming === 'everywhere' && (
        <div className="notice stack">
          <p>
            <b>Reset everywhere?</b> Every tracker and entry is deleted, here, in Supabase, and on your other devices
            when they next sync. Log Lightly starts again with the starter trackers. This can't be undone, so export a
            backup first if you might want it.
          </p>
          <div className="button-row">
            <button type="button" className="button danger" id="reset-everywhere-confirm"
              onClick={async () => { if (await resetEverywhere()) setConfirming(null); }}>
              Delete everything
            </button>
            {cancel}
          </div>
        </div>
      )}
    </>
  );
}
