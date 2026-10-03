// The sync panel: connect a Supabase project, sign in with an emailed code, and sync status.
import { useState } from 'react';
import { useSyncState } from '../../hooks';
import { dayKey, dayLabel, formatTime, prefs } from '../../lib/util';
import { sync, RequestError, type SyncState } from '../../lib/sync';
import { safely, toast } from '../../lib/toast';
import { dangerText } from '../../components/style';

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
      <label className="f" htmlFor="cfgUrl">
        Project URL
        <input id="cfgUrl" placeholder="https://xxxx.supabase.co" autoComplete="off" autoCapitalize="off" spellCheck={false}
          value={url} onChange={e => setUrl(e.target.value)} />
      </label>
      <label className="f" htmlFor="cfgKey">
        Anon / publishable key
        <input id="cfgKey" autoComplete="off" autoCapitalize="off" spellCheck={false}
          value={key} onChange={e => setKey(e.target.value)} />
      </label>
      <p className="small" id="cfgErr" style={dangerText}>{error}</p>
      <div className="btns">
        <button type="button" className="btn primary" id="cfgSave" onClick={connect}>Connect</button>
      </div>
    </>
  );
}

/** Shown when this device has its own entries and the account already has data. */
function LinkChoice() {
  return (
    <div className="banner stack">
      <p><b>Your account already has data.</b> This device also has entries that were never synced.</p>
      <p className="small">
        Replace this device's data with your account's data? The entries only on this device will be removed. Export a backup first if you want to keep them.
      </p>
      <div className="btns">
        <button type="button" className="btn primary" id="useAccount" onClick={safely(() => sync.chooseReplace(true))}>
          Use account data
        </button>
        <button type="button" className="btn" id="cancelLink" onClick={safely(() => sync.chooseReplace(false))}>
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
      const message = (e as Error).message;
      const notAUser = (e instanceof RequestError && e.status === 422) || /signup|not found|not allowed/i.test(message);
      setError(notAUser
        ? "That email isn't a user in this project. Add yourself in Supabase → Authentication → Users first."
        : message);
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
      const message = (e as Error).message;
      setError(/expired|invalid/i.test(message) ? "That code didn't work or has expired. Send a new one." : message);
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
      {state.detail && <p className="small" style={dangerText}>{state.detail}</p>}
      <label className="f" htmlFor="authEmail">
        Email
        <input id="authEmail" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      {codeSentTo && (
        <label className="f" htmlFor="authCode">
          Code from the email
          <input id="authCode" inputMode="numeric" autoComplete="one-time-code" maxLength={10}
            value={code} onChange={e => setCode(e.target.value)} />
        </label>
      )}
      <p className="small" id="authErr" style={dangerText}>{error}</p>
      <div className="btns">
        {codeSentTo ? (
          <>
            <button type="button" className="btn primary" id="authVerify" disabled={busy === 'verify'} onClick={verify}>Sign in</button>
            <button type="button" className="btn" id="authSend" disabled={busy === 'send'} onClick={sendCode}>Send a new code</button>
          </>
        ) : (
          <button type="button" className="btn primary" id="authSend" disabled={busy === 'send'} onClick={sendCode}>Email me a code</button>
        )}
        <button type="button" className="btn danger" id="cfgDisconnect" onClick={disconnect}>Disconnect project</button>
      </div>
    </>
  );
}

function SignedIn({ state }: { state: SyncState }) {
  const { lastSync } = state;
  const lastSyncText = lastSync
    ? `Last synced ${dayLabel(dayKey(lastSync)).toLowerCase()} at ${formatTime(lastSync)}.`
    : 'Not synced yet.';
  return (
    <>
      <p className="small">Signed in as <b>{state.email || 'you'}</b>. {lastSyncText}</p>
      {state.status === 'error' && <p className="small" style={dangerText}>{state.detail}</p>}
      <div className="btns">
        <button type="button" className="btn primary" id="syncNow" onClick={() => sync.run()}>Sync now</button>
        <button type="button" className="btn" id="signOut" onClick={safely(sync.signOut)}>Sign out</button>
      </div>
    </>
  );
}
