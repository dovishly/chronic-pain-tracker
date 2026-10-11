import { useState } from 'react';
import { useData, useLastBackup, useNow, useSyncState } from '../hooks';
import { DAY_MS, prefs } from '../lib/util';
import { liveEntries } from '../lib/model';
import { exportBackup } from '../lib/export';

const DUE_AFTER_MS = 14 * DAY_MS; // since the last backup, or since the oldest entry if there's never been one
const NOT_NOW_MS = 3 * DAY_MS;

/**
 * On Today, when everything is only on this device and hasn't been backed up for a while: a nudge to export a
 * backup, since a lost phone or cleared Safari data takes the entries with it. Not shown once Supabase is connected.
 */
export function BackupReminder() {
  const data = useData();
  const lastBackup = useLastBackup();
  const { projectUrl } = useSyncState();
  const now = useNow(60 * 60_000);
  const [notNowUntil, setNotNowUntil] = useState(() => prefs.get<number>('backupReminderNotNowUntil') ?? 0);

  if (projectUrl || now < notNowUntil) return null;
  const since = lastBackup ?? Math.min(...liveEntries(data).map(e => Date.parse(e.occurred_at)));
  if (!Number.isFinite(since) || now - since < DUE_AFTER_MS) return null;

  const notNow = () => {
    const until = Date.now() + NOT_NOW_MS;
    prefs.set('backupReminderNotNowUntil', until);
    setNotNowUntil(until);
  };

  const weeks = Math.floor((now - since) / (7 * DAY_MS));
  return (
    <div className="notice stack" id="backup-reminder" role="region" aria-label="Backup reminder">
      <p>
        {lastBackup
          ? `Your last backup was ${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago.`
          : "You haven't backed up yet."}{' '}
        Your entries are only on this device, so save a backup somewhere safe, like iCloud Drive.
      </p>
      <div className="button-row">
        <button type="button" className="button primary" id="backup-reminder-export" onClick={exportBackup}>
          Back up now
        </button>
        <button type="button" className="button" id="backup-reminder-not-now" onClick={notNow}>Not now</button>
      </div>
    </div>
  );
}
