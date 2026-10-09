import { useState } from 'react';
import { useSyncState } from '../../hooks';
import { dayKey, dayLabel, formatTime, prefs } from '../../lib/util';
import { sync, type SyncState } from '../../lib/sync';
import { safely, toast } from '../../lib/toast';
import schemaSql from '../../../schema.sql?raw';

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
  // Once a sign-in email has been sent, the address is remembered (even across restarts) and the link field appears.
  const [codeSentTo, setCodeSentTo] = useState(() => prefs.get<string>('pendingEmail'));
  const [useEmail, setUseEmail] = useState(!!codeSentTo);
  const [email, setEmail] = useState(codeSentTo || '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rememberCodeSentTo = (address: string | null) => {
    prefs.set('pendingEmail', address);
    setCodeSentTo(address);
  };

  /** Runs a sign-in step, showing its error under the form. */
  const attempt = async (step: () => Promise<void>) => {
    setBusy(true);
    try {
      await step();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const validEmail = () => {
    if (/^\S+@\S+\.\S+$/.test(email.trim())) return true;
    setError('Enter your email address.');
    return false;
  };

  const signIn = () => {
    if (!validEmail()) return;
    if (!password) return setError('Enter your password.');
    attempt(async () => {
      await sync.signIn(email, password);
      rememberCodeSentTo(null);
      toast('Signed in');
    });
  };

  const sendCode = () => {
    if (!validEmail()) return;
    attempt(async () => {
      await sync.sendCode(email);
      rememberCodeSentTo(email.trim());
      toast('Sent. Check your email.');
    });
  };

  const verify = () => {
    if (!code.trim()) return setError('Paste the link from the email, or type its code.');
    attempt(async () => {
      await sync.verify(codeSentTo!, code);
      rememberCodeSentTo(null);
      toast('Signed in');
    });
  };

  const disconnect = safely(async () => {
    await sync.disconnect();
    prefs.set('pendingEmail', null);
  });

  return (
    <>
      <p className="small">
        Connected to <span className="mono">{projectUrl.replace(/^https:\/\//, '')}</span>. Sign in with the email and password of your user in Supabase.
      </p>
      {state.detail && <p className="small error-text">{state.detail}</p>}
      <label className="field">
        Email
        <input id="sign-in-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      {useEmail ? (
        codeSentTo && (
          <>
            <label className="field">
              Link or code from the email
              <input id="sign-in-code" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false}
                value={code} onChange={e => setCode(e.target.value)} />
            </label>
            <p className="small muted">
              Press and hold the link in the email, tap <b>Copy</b>, and paste it here. Don't open it: that uses it up.
            </p>
          </>
        )
      ) : (
        <label className="field">
          Password
          <input id="sign-in-password" type="password" autoComplete="current-password" value={password}
            onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && signIn()} />
        </label>
      )}
      <p className="small error-text" id="sign-in-error">{error}</p>
      <div className="button-row">
        {!useEmail && (
          <>
            <button type="button" className="button primary" id="sign-in" disabled={busy} onClick={signIn}>Sign in</button>
            <button type="button" className="button" id="use-email-link" onClick={() => { setUseEmail(true); setError(''); }}>
              Email me a link instead
            </button>
          </>
        )}
        {useEmail && codeSentTo && (
          <button type="button" className="button primary" id="sign-in-with-link" disabled={busy} onClick={verify}>Sign in</button>
        )}
        {useEmail && (
          <>
            <button type="button" className={codeSentTo ? 'button' : 'button primary'} id="send-code" disabled={busy} onClick={sendCode}>
              {codeSentTo ? 'Send a new email' : 'Email me a sign-in link'}
            </button>
            <button type="button" className="button" id="use-password" onClick={() => { setUseEmail(false); setError(''); }}>
              Use my password
            </button>
          </>
        )}
        <button type="button" className="button danger" id="project-disconnect" onClick={disconnect}>Disconnect project</button>
      </div>
      {useEmail && <p className="small muted">Supabase sends only a couple of sign-in emails an hour.</p>}
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
      {state.status === 'needsSchema' && <SchemaSetup projectUrl={state.projectUrl!} />}
      <div className="button-row">
        <button type="button" className="button primary" id="sync-now" onClick={() => sync.run()}>Sync now</button>
        <button type="button" className="button" id="sign-out" onClick={safely(sync.signOut)}>Sign out</button>
      </div>
    </>
  );
}

/** schema.sql, with the analysis views set to this device's time zone. */
function setupSql(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!/^[\w+\-/]+$/.test(zone)) return schemaSql;
  return schemaSql.replace(/(function public\.logbook_timezone\(\)[^$]*\$\$ select ')[^']*/, '$1' + zone);
}

/** The SQL Editor for a project hosted by Supabase, or null for any other address (such as a local one). */
function sqlEditorUrl(projectUrl: string): string | null {
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(projectUrl)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : null;
}

const copySetupSql = safely(async () => {
  await navigator.clipboard.writeText(setupSql());
  toast('Setup SQL copied');
});

/** Shown when the project doesn't have Logbook's tables yet, or has an older version of them. */
function SchemaSetup({ projectUrl }: { projectUrl: string }) {
  const editorUrl = sqlEditorUrl(projectUrl);
  return (
    <div className="notice stack">
      <p><b>Your Supabase project needs Logbook's tables.</b> This happens once when you set it up, and again when an app update changes them.</p>
      <p className="small">
        Copy the setup SQL, paste it into a new query in the Supabase SQL Editor, and click <b>Run</b>. Then tap <b>Sync now</b>.
      </p>
      <div className="button-row">
        <button type="button" className="button primary" id="schema-copy" onClick={copySetupSql}>Copy setup SQL</button>
        {editorUrl && (
          <a className="button" id="schema-editor" href={editorUrl} target="_blank" rel="noreferrer">Open SQL Editor</a>
        )}
      </div>
    </div>
  );
}
