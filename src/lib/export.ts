// Exports: CSV tables for analysis (see analysis.ts), and a JSON backup of everything on this device.
import { dayKey, nowIso } from './util';
import { dataStore } from './data';
import { buildAnalysisTables, toCsv } from './analysis';

interface ExportFile {
  name: string;
  text: string;
  type: string;
}

/**
 * Opens the share sheet where the browser can share files (iPhone: Save to Files, AirDrop, Mail…),
 * otherwise downloads each file.
 */
async function shareOrDownload(files: ExportFile[]): Promise<void> {
  const shareable = files.map(f => new File([f.text], f.name, { type: f.type }));
  try {
    if (navigator.canShare?.({ files: shareable })) {
      await navigator.share({ files: shareable, title: files.length === 1 ? files[0].name : 'Logbook export' });
      return;
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return; // the person closed the share sheet
  }
  for (const file of shareable) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await new Promise(resolve => setTimeout(resolve, 250)); // browsers drop downloads started too close together
  }
}

const today = () => dayKey(Date.now());

/** Five CSV files: daily, checkins, episodes, entries, trackers. */
export function exportForAnalysis(): Promise<void> {
  const prefix = `logbook-${today()}`;
  const files = buildAnalysisTables(dataStore.get()).map(table => ({
    name: `${prefix}-${table.name}.csv`,
    text: toCsv(table),
    type: 'text/csv',
  }));
  return shareOrDownload(files);
}

export function exportBackup(): Promise<void> {
  const data = dataStore.get();
  const backup = {
    app: 'logbook',
    version: 1,
    exported: nowIso(),
    trackers: [...data.trackers.values()],
    entries: [...data.entries.values()],
  };
  return shareOrDownload([{
    name: `logbook-backup-${today()}.json`,
    text: JSON.stringify(backup, null, 1),
    type: 'application/json',
  }]);
}
