import { useState } from 'react';
import { useData, useSyncState, useTheme } from '../../hooks';
import { setTheme, type ThemeChoice } from '../../lib/theme';
import { CheckIcon } from '../../components/icons';
import { dayKey, dayLabel, formatDate } from '../../lib/util';
import { entryTime, liveEntries, newTracker, type Tracker } from '../../lib/model';
import { exportBackup, exportForAnalysis } from '../../lib/export';
import { backupContents, entriesNotInBackup, readBackup, type Backup } from '../../lib/backup';
import { resetDevice, resetEverywhere, restoreBackup } from '../../lib/actions';
import type { NewTrackerRequest } from '../../navigation';
import { TrackerEditor } from './TrackerEditor';
import { ArchivedTrackers, TrackerList } from './TrackerList';
import { SyncPanel } from './SyncPanel';

interface Props {
  /** Opens with a new tracker's editor, from "+ Add" on another tab; onAddDone takes the person back there. */
  addRequest: NewTrackerRequest | null;
  onAddDone: () => void;
}

export function SettingsView({ addRequest, onAddDone }: Props) {
  const data = useData();
  const [editing, setEditing] = useState<{ tracker: Tracker; isNew: boolean; fromAdd?: boolean } | null>(
    () => (addRequest ? { tracker: newTracker(data, addRequest.type, addRequest.group), isNew: true, fromAdd: true } : null),
  );
  const closeEditor = () => {
    setEditing(null);
    if (editing?.fromAdd) onAddDone();
  };

  const editTracker = (id: string) => {
    setEditing({ tracker: data.trackers.get(id)!, isNew: false });
    window.scrollTo(0, 0);
  };

  return (
    <section id="view-settings" className="stack">
      <section>
        <div className="row-between section-header">
          <h2>Trackers</h2>
          <button className="button" id="add-tracker" type="button" onClick={() => setEditing({ tracker: newTracker(data), isNew: true })}>
            Add tracker
          </button>
        </div>
        {editing && (
          <TrackerEditor
            key={editing.tracker.id}
            tracker={editing.tracker}
            isNew={editing.isNew}
            onClose={closeEditor}
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
          <YourData />
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

const THEME_CHOICES: [ThemeChoice, string][] = [['device', 'Match device'], ['light', 'Light'], ['dark', 'Dark']];

/** Light or dark, or whichever the device is set to. Kept on this device only. */
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

/**
 * The exports, and Restore backup on a device without sync (one that syncs gets its data from the account). A
 * backup file is read and described first, and replaces nothing until that's confirmed.
 */
function YourData() {
  const data = useData();
  const { projectUrl } = useSyncState();
  const [backup, setBackup] = useState<Backup | null>(null); // read from a file, waiting to be confirmed
  const [error, setError] = useState('');

  const readFile = async (file: File | undefined) => {
    setBackup(null);
    setError('');
    if (!file) return;
    try {
      setBackup(readBackup(await file.text()));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = async () => {
    if (backup && (await restoreBackup(backup))) setBackup(null);
  };

  const lost = backup ? entriesNotInBackup(data, backup) : 0;
  return (
    <>
      <p className="small muted">
        Everything is saved on this device first. <b>Export for analysis</b> gives one .zip of five spreadsheets (CSV)
        that line up by date and id: daily, check-ins, episodes, entries and trackers. <b>Export backup</b> is
        one file with everything{projectUrl ? '.' : <>, and <b>Restore backup</b> brings one back.</>}
      </p>
      <div className="button-row">
        <button className="button primary" id="export-analysis" type="button" onClick={exportForAnalysis}>
          Export for analysis
        </button>
        <button className="button" id="export-backup" type="button" onClick={exportBackup}>Export backup</button>
        {/* The device's own file picker, invisible over the button, so a tap opens it. */}
        {!projectUrl && (
          <label className="button file-button">
            Restore backup
            <input type="file" id="restore-backup-file" accept=".json,application/json"
              onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        )}
      </div>
      {error && <p className="small error-text" id="restore-backup-error">{error}</p>}
      {backup && (
        <div className="notice stack">
          <p>
            <b>Restore the backup{backup.exported ? ` from ${formatDate(backup.exported)}` : ''}?</b> It has{' '}
            {backupContents(backup)}, and they replace everything on this device.
            {lost === 1 && " 1 entry here isn't in the backup, so it will be lost."}
            {lost > 1 && ` ${lost} entries here aren't in the backup, so they will be lost.`}
          </p>
          <div className="button-row">
            <button type="button" className="button danger" id="restore-backup-confirm" onClick={restore}>
              Replace with backup
            </button>
            <button type="button" className="button" onClick={() => setBackup(null)}>Cancel</button>
          </div>
        </div>
      )}
      <p className="small muted">{dataStats(liveEntries(data).map(entryTime))}</p>
    </>
  );
}

function dataStats(times: number[]): string {
  if (!times.length) return '0 entries on this device.';
  return `${times.length} entries on this device, from ${dayLabel(dayKey(Math.min(...times)))}.`;
}

/** Back to the starter trackers: on this device only, or (signed in) in the whole account. Each asks first. */
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
