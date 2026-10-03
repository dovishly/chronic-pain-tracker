// Exports: a CSV for spreadsheets, and a JSON backup of everything on this device.
import { MINUTE_MS, dayKey, clockTime, nowIso } from './util';
import { dataStore } from './data';
import { entryTime, byTime, liveEntries, episodesByEndEntry } from './model';

const CSV_COLUMNS = [
  'date', 'time', 'timestamp', 'tracker', 'type', 'group', 'kind',
  'value', 'label', 'duration_min', 'note', 'checkin_id', 'entry_id',
];

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per live entry, oldest first. "end" rows carry the episode's length in minutes. */
function buildCsv(): string {
  const data = dataStore.get();
  const episodeByEnd = episodesByEndEntry(data);
  const lines = [CSV_COLUMNS.join(',')];
  for (const entry of liveEntries(data).sort(byTime)) {
    const tracker = data.trackers.get(entry.tracker_id)!;
    const time = entryTime(entry);
    const episode = episodeByEnd[entry.id];
    const row = [
      dayKey(time),
      clockTime(time),
      entry.ts,
      tracker.name,
      tracker.type,
      tracker.grp || '',
      entry.kind,
      entry.num ?? '',
      entry.txt ?? '',
      episode ? Math.round((episode.end - episode.start) / MINUTE_MS) : '',
      entry.note || '',
      entry.checkin_id || '',
      entry.id,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}

function buildBackup(): string {
  const data = dataStore.get();
  const backup = {
    app: 'logbook',
    version: 1,
    exported: nowIso(),
    trackers: [...data.trackers.values()],
    entries: [...data.entries.values()],
  };
  return JSON.stringify(backup, null, 1);
}

/** Opens the share sheet where the browser supports sharing files (iPhone), otherwise downloads. */
async function shareOrDownload(fileName: string, text: string, mimeType: string): Promise<void> {
  const blob = new Blob([text], { type: mimeType });
  try {
    const file = new File([blob], fileName, { type: mimeType });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: fileName });
      return;
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return; // the person closed the share sheet
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const today = () => dayKey(Date.now());

export const exportCsv = () => shareOrDownload(`logbook-${today()}.csv`, buildCsv(), 'text/csv');
export const exportBackup = () => shareOrDownload(`logbook-backup-${today()}.json`, buildBackup(), 'application/json');
