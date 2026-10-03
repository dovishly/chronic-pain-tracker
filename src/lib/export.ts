// Exports: the analysis tables as CSV files in one .zip (see analysis.ts), and a JSON backup of everything.
import { dayKey, nowIso } from './util';
import { dataStore } from './data';
import { buildAnalysisTables, toCsv } from './analysis';
import { zip } from './zip';

interface ExportFile {
  name: string;
  data: string | Uint8Array<ArrayBuffer>;
  type: string;
}

/**
 * Opens the share sheet where the browser can share files (iPhone: Save to Files, AirDrop, Mail…),
 * otherwise downloads the file.
 */
async function shareOrDownload(file: ExportFile): Promise<void> {
  const shareable = new File([file.data], file.name, { type: file.type });
  try {
    if (navigator.canShare?.({ files: [shareable] })) {
      await navigator.share({ files: [shareable], title: file.name });
      return;
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return; // the person closed the share sheet
  }
  const url = URL.createObjectURL(shareable);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const today = () => dayKey(Date.now());

/**
 * One .zip holding a folder of five CSV files: daily, checkins, episodes, entries, trackers.
 * Unzipped, they arrive together in a folder named after the export date.
 */
export function exportForAnalysis(): Promise<void> {
  const folder = `logbook-${today()}`;
  const encoder = new TextEncoder();
  const files = buildAnalysisTables(dataStore.get())
    .map((table): [string, Uint8Array] => [`${folder}/${table.name}.csv`, encoder.encode(toCsv(table))]);
  return shareOrDownload({ name: `${folder}.zip`, data: zip(files), type: 'application/zip' });
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
  return shareOrDownload({
    name: `logbook-backup-${today()}.json`,
    data: JSON.stringify(backup, null, 1),
    type: 'application/json',
  });
}
