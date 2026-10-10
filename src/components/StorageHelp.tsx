import { useRef } from 'react';
import { useSyncState } from '../hooks';

/** A "?" next to the sync pill, explaining where data is kept and how long it lasts. */
export function StorageHelp({ onOpenSettings }: { onOpenSettings: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const { projectUrl } = useSyncState();
  const close = () => dialog.current?.close();
  // Focus the title, not the first button (at the bottom), so it opens at the top.
  const open = () => {
    dialog.current?.showModal();
    title.current?.focus();
  };

  return (
    <>
      <button type="button" className="help-button" id="storage-help" aria-label="Where your data is kept"
        onClick={open}>?</button>
      {/* A tap on the backdrop (the dialog itself, outside its body) closes it. */}
      <dialog ref={dialog} className="help-dialog" id="storage-help-dialog" aria-labelledby="storage-help-title"
        onClick={e => e.target === dialog.current && close()}>
        <div className="help-dialog-body stack">
          <h2 className="help-title" id="storage-help-title" ref={title} tabIndex={-1}>Where your data lives</h2>
          <p>
            Everything you log is saved on this device first, so Log Lightly works offline and without an account.
            {projectUrl
              ? " You've also connected Supabase, so there's a copy online too."
              : " At the moment, it's only on this device."}
          </p>

          <section>
            <h3>Just on this device</h3>
            <ul>
              <li>Simple and private: no account, and nothing leaves your device.</li>
              <li>
                If you delete Log Lightly from your Home Screen, clear Safari's data, or lose your device,
                your entries go with it.
              </li>
              <li>
                Always open it from the Home Screen icon. Safari on its own can wipe a site's data if you don't visit
                for a week or so.
              </li>
              <li>
                Every so often, tap <b>Settings → Export backup</b> and save the file to iCloud Drive. If your entries
                are ever lost, <b>Restore backup</b> brings them back from it.
              </li>
            </ul>
          </section>

          <section>
            <h3>Synced with Supabase</h3>
            <ul>
              <li>
                Supabase is a free online database. You set up your own (about 15 minutes, in <b>Settings → Sync</b>),
                and Log Lightly keeps a copy of everything there.
              </li>
              <li>Lose or replace your device? Sign in again and it all comes back. It syncs between devices, too.</li>
              <li>
                Free projects are paused after about a week without using it, so logging most days keeps your database running.
              </li>
            </ul>
          </section>

          <div className="button-row">
            {!projectUrl && (
              <button type="button" className="button" id="storage-help-sync" onClick={() => { close(); onOpenSettings(); }}>
                Set up sync
              </button>
            )}
            <button type="button" className="button primary" id="storage-help-close" onClick={close}>Got it</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
