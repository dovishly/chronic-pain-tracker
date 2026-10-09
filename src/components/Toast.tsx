import { useToast } from '../hooks';
import { deleteEntry, moveEntryEarlier } from '../lib/actions';

export function Toast() {
  const toast = useToast();
  if (!toast) return null;
  const { entryId } = toast;
  // The key replays the entrance animation for every new toast.
  return (
    <div className="toast" role="status" key={toast.id}>
      <span className="toast-message">{toast.message}</span>
      {entryId && (
        <>
          <button type="button" onClick={() => moveEntryEarlier(entryId, 5)}>−5 min</button>
          <button type="button" onClick={() => moveEntryEarlier(entryId, 15)}>−15 min</button>
          <button type="button" onClick={() => deleteEntry(entryId, 'Removed')}>Undo</button>
        </>
      )}
    </div>
  );
}
