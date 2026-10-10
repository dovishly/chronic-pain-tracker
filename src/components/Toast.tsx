import { useToast } from '../hooks';

export function Toast() {
  const toast = useToast();
  if (!toast) return null;
  // The key replays the entrance animation for every new toast.
  return (
    <div className="toast" role="status" key={toast.id}>
      <span className="toast-message">{toast.message}</span>
      {toast.actions.map(action => (
        <button key={action.label} type="button" onClick={action.run}>{action.label}</button>
      ))}
    </div>
  );
}
