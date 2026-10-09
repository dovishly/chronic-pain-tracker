// The forms that open under a row of the day's log, to change a time or note, or delete.
import { useState, type ReactNode } from 'react';
import { useData } from '../../hooks';
import { clockTime } from '../../lib/util';
import { entryTime, episodeNotes, type Entry, type Episode } from '../../lib/model';
import { deleteEntry, deleteEpisode, editEntry, editEpisode } from '../../lib/actions';

/** An entry's time (on its own day) and note. */
export function EntryEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [time, setTime] = useState(() => clockTime(entryTime(entry)));
  const [note, setNote] = useState(entry.note || '');
  return (
    <EditorForm
      id={entry.id}
      note={note}
      onNoteChange={setNote}
      onSave={async () => { if (await editEntry(entry.id, time, note)) onDone(); }}
      onDelete={() => { onDone(); deleteEntry(entry.id, 'Deleted'); }}
    >
      <TimeField label="Time" value={time} onChange={setTime} />
    </EditorForm>
  );
}

/** An episode's start and end times (each on its own day) and its note. Delete removes the whole episode. */
export function EpisodeEditor({ episode, onDone }: { episode: Episode; onDone: () => void }) {
  const data = useData();
  const [start, setStart] = useState(() => clockTime(episode.start));
  const [end, setEnd] = useState(() => (episode.endEntryId ? clockTime(episode.end) : ''));
  // Shown together, as on the row; saving keeps the note on the start.
  const [note, setNote] = useState(() => episodeNotes(data, episode).join(' · '));
  return (
    <EditorForm
      id={episode.id}
      note={note}
      onNoteChange={setNote}
      onSave={async () => { if (await editEpisode(episode, start, end, note)) onDone(); }}
      onDelete={() => { onDone(); deleteEpisode(episode); }}
    >
      <TimeField label="Start" value={start} onChange={setStart} />
      {episode.endEntryId && <TimeField label="End" value={end} onChange={setEnd} />}
    </EditorForm>
  );
}

interface EditorFormProps {
  id: string;
  note: string;
  onNoteChange: (note: string) => void;
  onSave: () => void;
  onDelete: () => void;
  children: ReactNode; // the time fields
}

function EditorForm({ id, note, onNoteChange, onSave, onDelete, children }: EditorFormProps) {
  return (
    <div className="entry-editor">
      {children}
      <label className="field note-field">
        Note
        <input type="text" value={note} placeholder="Optional" onChange={e => onNoteChange(e.target.value)} />
      </label>
      <button type="button" className="button primary" data-save-entry={id} onClick={onSave}>Save</button>
      <button type="button" className="button danger" onClick={onDelete}>Delete</button>
    </div>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (time: string) => void }) {
  return (
    <label className="field">
      {label}
      <input type="time" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  );
}
