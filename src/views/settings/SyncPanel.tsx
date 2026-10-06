import { useState } from 'react';
import { useSyncState } from '../../hooks';
import { dayKey, dayLabel, formatTime, prefs } from '../../lib/util';
import { sync, type SyncState } from '../../lib/sync';
import { safely, toast } from '../../lib/toast';

export function SyncPanel() {
  const state = useSyncState();
  if (!state.projectUrl) return <ConnectForm />;
  if (state.status === 'needsChoice') return <LinkChoice />;
  if (!state.signedIn) return <SignInForm state={state} projectUrl={state.projectUrl} />;
  return <SignedIn state={state} />;
}

function ConnectForm() {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const connect = () => {
    try {
      sync.configure(url, key);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <p className="small">
        Logbook works on this device without an account. To back up and sync, connect your own Supabase project (see the setup guide).
      </p>
      <label className="field">
        Project URL
        <input id="project-url" placeholder="https://xxxx.supabase.co" autoComplete="off" autoCapitalize="off" spellCheck={false}
          value={url} onChange={e => setUrl(e.target.value)} />
      </label>
      <label className="field">
        Anon / publishable key
        <input id="project-key" autoComplete="off" autoCapitalize="off" spellCheck={false}
          value={key} onChange={e => setKey(e.target.value)} />
      </label>
      <p className="small error-text" id="project-error">{error}</p>
      <div className="button-row">
        <button type="button" className="button primary" id="project-connect" onClick={connect}>Connect</button>
      </div>
    </>
  );
}

/** Shown when this device has its own entries and the account already has data. */
function LinkChoice() {
  return (
    <div className="notice stack">
      <p><b>Your account already has data.</b> This device also has entries that were never synced.</p>
      <p className="small">
        Replace this device's data with your account's data? The entries only on this device will be removed. Export a backup first if you want to keep them.
      </p>
      <div className="button-row">
        <button type="button" className="button primary" id="use-account-data" onClick={safely(() => sync.chooseReplace(true))}>
          Use account data
        </button>
        <button type="button" className="button" id="cancel-sign-in" onClick={safely(() => sync.chooseReplace(false))}>
          Cancel and sign out
        </button>
      </div>
    </div>
  );
}

function SignInForm({ state, projectUrl }: { state: SyncState; projectUrl: string }) {
  // Once a code has been sent, the address is remembered (even across restarts) and the code field appears.
  const [codeSentTo, setCodeSentTo] = useState(() => prefs.get<string>('pendingEmail'));
  const [email, setEmail] = useState(codeSentTo || '');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);

  const rememberCodeSentTo = (address: string | null) => {
    prefs.set('pendingEmail', address);
    setCodeSentTo(address);
  };

  const sendCode = async () => {
    const address = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      setError('Enter your email address.');
      return;
    }
    setBusy('send');
    try {
      await sync.sendCode(address);
      rememberCodeSentTo(address);
      setError('');
      toast('Code sent. Check your email.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!code.trim()) {
      setError('Enter the code from the email.');
      return;
    }
    setBusy('verify');
    try {
      await sync.verify(codeSentTo!, code);
      rememberCodeSentTo(null);
      toast('Signed in');
      // Signed in now, so this form is replaced; no state to reset.
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const disconnect = safely(async () => {
    await sync.disconnect();
    prefs.set('pendingEmail', null);
  });

  return (
    <>
      <p className="small">
        Connected to <span className="mono">{projectUrl.replace(/^https:\/\//, '')}</span>. Sign in with the email on your Supabase account. You'll get a code by email.
      </p>
      {state.detail && <p className="small error-text">{state.detail}</p>}
      <label className="field">
        Email
        <input id="sign-in-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      {codeSentTo && (
        <label className="field">
          Code from the email
          <input id="sign-in-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10}
            value={code} onChange={e => setCode(e.target.value)} />
        </label>
      )}
      <p className="small error-text" id="sign-in-error">{error}</p>
      <div className="button-row">
        {codeSentTo ? (
          <>
            <button type="button" className="button primary" id="sign-in" disabled={busy === 'verify'} onClick={verify}>Sign in</button>
            <button type="button" className="button" id="send-code" disabled={busy === 'send'} onClick={sendCode}>Send a new code</button>
          </>
        ) : (
          <button type="button" className="button primary" id="send-code" disabled={busy === 'send'} onClick={sendCode}>Email me a code</button>
        )}
        <button type="button" className="button danger" id="project-disconnect" onClick={disconnect}>Disconnect project</button>
      </div>
    </>
  );
}

/** "Last synced today at 9:05 AM.", or "… on Mon, Sep 29 at …" for an older sync. */
function lastSyncText(lastSync: number | null): string {
  if (!lastSync) return 'Not synced yet.';
  const day = dayLabel(dayKey(lastSync));
  const when = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : 'on ' + day;
  return `Last synced ${when} at ${formatTime(lastSync)}.`;
}

function SignedIn({ state }: { state: SyncState }) {
  return (
    <>
      <p className="small">Signed in as <b>{state.email || 'you'}</b>. {lastSyncText(state.lastSync)}</p>
      {state.status === 'error' && <p className="small error-text">{state.detail}</p>}
      <div className="button-row">
        <button type="button" className="button primary" id="sync-now" onClick={() => sync.run()}>Sync now</button>
        <button type="button" className="button" id="sign-out" onClick={safely(sync.signOut)}>Sign out</button>
      </div>
    </>
  );
}
