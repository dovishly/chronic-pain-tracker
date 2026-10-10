// The files Log Lightly gives you, shared or downloaded: "Export for analysis" (CSVs in a .zip, built in
// analysis.ts) and "Export backup" (one JSON file, see backup.ts). Each is only ever started by a tap, so each comes
// wrapped in safely(), like the actions: a failure shows a toast.
import { dayKey } from './util';
import { dataStore } from './data';
import { buildAnalysisTables, type Cell, type Table } from './analysis';
import { backupOf } from './backup';
import { safely } from './toast';
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
export const exportForAnalysis = safely(() => {
  const folder = `log-lightly-${today()}`;
  const encoder = new TextEncoder();
  const files = buildAnalysisTables(dataStore.get())
    .map((table): [string, Uint8Array] => [`${folder}/${table.name}.csv`, encoder.encode(toCsv(table))]);
  return shareOrDownload({ name: `${folder}.zip`, data: zip(files), type: 'application/zip' });
});

/** Every tracker and entry in one JSON file. */
export const exportBackup = safely(() => shareOrDownload({
  name: `log-lightly-backup-${today()}.json`,
  data: JSON.stringify(backupOf(dataStore.get()), null, 1),
  type: 'application/json',
}));

/* ---------- CSV ---------- */

function csvCell(value: Cell): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(table: Table): string {
  return [table.columns, ...table.rows].map(row => row.map(csvCell).join(',')).join('\n');
}
