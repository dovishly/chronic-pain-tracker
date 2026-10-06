import { useSyncState } from '../hooks';
import { formatTime } from '../lib/util';
import type { SyncState } from '../lib/sync';

/** [label, tone] for the pill. Tone is a CSS class: ok, warn, err, or '' for neutral. */
function pillContent({ status, waiting, lastSync }: SyncState): [string, string] {
  switch (status) {
    case 'local': return ['On this device only', 'warn'];
    case 'signedout': return ['Signed out', 'warn'];
    case 'syncing': return ['Syncing…', ''];
    case 'offline': return [waiting ? `Offline · ${waiting} waiting` : 'Offline', 'warn'];
    case 'error': return ['Sync problem', 'err'];
    case 'needsChoice': return ['Action needed', 'err'];
  }
  if (waiting) return [`${waiting} waiting`, 'warn'];
  return [lastSync ? `Synced ${formatTime(lastSync)}` : 'Synced', 'ok'];
}

/** Sync status in the header. Tapping it opens Settings, where the details are. */
export function SyncPill({ onClick }: { onClick: () => void }) {
  const [label, tone] = pillContent(useSyncState());
  return (
    <button className={`sync-pill ${tone}`} id="sync-pill" type="button" onClick={onClick}>
      {label}
    </button>
  );
}
