import { dayKey, nowIso } from './util';
import { dataStore } from './data';
import { allTrackers, liveEntries } from './model';
import { buildAnalysisTables, toCsv } from './analysis';
import { zip } from './zip';

interface ExportFile {
  name: string;
  data: string | Uint8Array<ArrayBuffer>;
  type: string;
}

/** Opens the share sheet where the browser can share files, otherwise downloads. */
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

/** The analysis CSVs in one .zip, in a folder named after today's date. */
export function exportForAnalysis(): Promise<void> {
  const folder = `log-lightly-${today()}`;
  const encoder = new TextEncoder();
  const files = buildAnalysisTables(dataStore.get())
    .map((table): [string, Uint8Array] => [`${folder}/${table.name}.csv`, encoder.encode(toCsv(table))]);
  return shareOrDownload({ name: `${folder}.zip`, data: zip(files), type: 'application/zip' });
}

/** Every tracker and entry in one JSON file. Deleted ones are left out: they hold nothing to keep. */
export function exportBackup(): Promise<void> {
  const data = dataStore.get();
  const backup = {
    app: 'logbook', // Log Lightly's former name, kept so every backup names the same format
    version: 1,
    exported: nowIso(),
    trackers: allTrackers(data),
    entries: liveEntries(data),
  };
  return shareOrDownload({
    name: `log-lightly-backup-${today()}.json`,
    data: JSON.stringify(backup, null, 1),
    type: 'application/json',
  });
}
