import { createClient, type Session, type Subscription, type SupabaseClient } from '@supabase/supabase-js';
import { prefs } from './util';
import { db } from './db';
import { trackers, entries, pendingKeys, dataChanged } from './data';
import { normalizeEntry, normalizeTracker, type Entry, type Tracker } from './model';

export type SyncStatus = 'local' | 'signedout' | 'syncing' | 'offline' | 'ok' | 'error' | 'needsChoice' | 'needsSchema';

/** Everything the UI shows about sync. A new object whenever any of it changes. */
export interface SyncState {
  status: SyncStatus;
  detail: string;            // the error or sign-in message to show, if any
  projectUrl: string | null; // null when no project is connected
  signedIn: boolean;
  email: string | null;
  waiting: number;           // local writes not yet uploaded
  lastSync: number | null;
}

interface Project { url: string; key: string } // project URL and anon/publishable key

/** A queued write. updatedAt is the row's updated_at when queued, so an upload can tell if it changed since. */
export interface OutboxItem { key: string; table: Table; updatedAt: string | undefined; row: Record<string, unknown> }

type Table = 'trackers' | 'entries';
const TABLES: Table[] = ['trackers', 'entries']; // trackers first, so entries never point at a missing tracker
const UPLOAD_BATCH = 200;
const PULL_PAGE = 1000;
const SYNC_DELAY_AFTER_WRITE_MS = 700; // lets a burst of taps go up in one request
const AUTH_PREF = 'auth'; // the pref supabase-js keeps the session in

/** The lowest logbook_schema_version() this app syncs with. Raise it with the one in schema.sql. */
const SCHEMA_VERSION = 1;

let project = prefs.get<Project>('project');
let client: SupabaseClient | null = null;
let authSubscription: Subscription | null = null;
let session: Session | null = null;
let leaving = false; // signing out on purpose, so SIGNED_OUT isn't reported as an expired sign-in

let status: SyncStatus = 'local';
let statusDetail = '';
let running = false;
let runAgain = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let schemaChecked = false; // once per app session; "Sync now" after an error checks again

const listeners = new Set<() => void>();
let snapshot = buildSnapshot();

function buildSnapshot(): SyncState {
  return {
    status,
    detail: statusDetail,
    projectUrl: project?.url ?? null,
    signedIn: !!session,
    email: session?.user.email ?? null,
    waiting: pendingKeys.size,
    lastSync: prefs.get<number>('lastSync'),
  };
}

function notify(): void {
  snapshot = buildSnapshot();
  listeners.forEach(fn => fn());
}

function setStatus(next: SyncStatus, detail = statusDetail): void {
  status = next;
  statusDetail = detail;
  notify();
}

/** A failed Supabase call. status is the HTTP status, or 0 when the request never reached the server. */
class SyncError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Thrown by linkAccount while it waits for the owner to answer needsChoice. */
class WaitingForChoice extends Error {}

/** Thrown when the database's schema is older than this app needs. */
class OutdatedSchema extends Error {}

const isNetworkFailure = (error: unknown) => error instanceof TypeError || (error as { status?: unknown })?.status === 0;

/* ---------- the Supabase client ---------- */

function openClient(): void {
  if (!project) return;
  client = createClient(project.url, project.key, {
    auth: { storageKey: prefs.key(AUTH_PREF), detectSessionInUrl: false },
    db: { retry: false }, // the outbox retries: every minute, on focus and when back online
  });
  authSubscription = client.auth.onAuthStateChange((event, next) => {
    session = next;
    if (event === 'SIGNED_OUT' && !leaving) setStatus('signedout', 'Your sign-in expired. Sign in again in Settings.');
    else notify();
  }).data.subscription;
}

function supabase(): SupabaseClient {
  if (!client) throw new Error('Not connected');
  return client;
}

/** The data from a Supabase call, or a SyncError if it failed. */
async function check<T>(call: PromiseLike<{ data: T; error: { message: string } | null; status: number }>): Promise<T> {
  const { data, error, status } = await call;
  if (error) throw new SyncError(error.message, status);
  return data;
}

/* ---------- upload and download ---------- */

/** Uploads queued writes. An outbox item is removed only if it wasn't changed again while being sent. */
async function flushOutbox(): Promise<void> {
  const items = await db.all<OutboxItem>('outbox');
  for (const table of TABLES) {
    const tableItems = items.filter(item => item.table === table);
    for (let i = 0; i < tableItems.length; i += UPLOAD_BATCH) {
      const batch = tableItems.slice(i, i + UPLOAD_BATCH);
      await check(supabase().from(table).upsert(batch.map(item => item.row)));
      for (const item of batch) {
        const current = await db.get<OutboxItem>('outbox', item.key);
        if (current && current.updatedAt === item.updatedAt) {
          await db.remove('outbox', item.key);
          pendingKeys.delete(item.key);
        }
      }
    }
  }
}

const cursorKey = (table: Table) => 'cursor:' + table;

/** Downloads rows changed since the last pull. Returns true if anything on this device changed. */
async function pullChanges(): Promise<boolean> {
  let changed = false;
  for (const table of TABLES) {
    let cursor = (await db.getMeta<string>(cursorKey(table))) || '1970-01-01T00:00:00Z';
    while (true) {
      const rows: Record<string, unknown>[] = (await check(supabase().from(table)
        .select('*')
        .gte('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .limit(PULL_PAGE))) ?? [];

      const updated: (Tracker | Entry)[] = [];
      for (const row of rows) {
        const id = String(row.id);
        if (pendingKeys.has(table + ':' + id)) continue; // the local edit wins until it's uploaded
        const local = table === 'trackers' ? trackers.get(id) : entries.get(id);
        if (local && local.updated_at === row.updated_at) continue;
        if (table === 'trackers') {
          const tracker = normalizeTracker(row);
          trackers.set(id, tracker);
          updated.push(tracker);
        } else {
          const entry = normalizeEntry(row);
          entries.set(id, entry);
          updated.push(entry);
        }
      }
      if (updated.length) {
        await db.putMany(table, updated);
        changed = true;
      }

      if (rows.length) {
        cursor = String(rows[rows.length - 1].updated_at);
        await db.setMeta(cursorKey(table), cursor);
      }
      if (rows.length < PULL_PAGE) break;
    }
  }
  return changed;
}

async function resetCursors(): Promise<void> {
  for (const table of TABLES) await db.setMeta(cursorKey(table), null);
}

/** Makes sure the database has the tables and columns this app sends; see SCHEMA_VERSION. */
async function checkSchema(): Promise<void> {
  if (schemaChecked) return;
  const { data, error, status: httpStatus } = await supabase().rpc('logbook_schema_version');
  // 404: the function doesn't exist yet, so schema.sql is from before versions were tracked.
  if (error && httpStatus !== 404) throw new SyncError(error.message, httpStatus);
  if ((error ? 0 : Number(data)) < SCHEMA_VERSION) throw new OutdatedSchema();
  schemaChecked = true;
}

/**
 * First sign-in on this device. An empty account just receives this device's data on the next
 * upload. An account that already has trackers replaces this device's data, but if this device
 * has entries of its own, the owner is asked first (status needsChoice).
 */
async function linkAccount(): Promise<void> {
  const accountTrackers = await check(supabase().from('trackers').select('id').limit(1));
  if (accountTrackers?.length) {
    const localEntryCount = [...entries.values()].filter(e => !e.deleted).length;
    if (localEntryCount > 0 && !(await db.getMeta<boolean>('replaceConfirmed'))) {
      setStatus('needsChoice');
      throw new WaitingForChoice();
    }
    await db.clear('trackers');
    await db.clear('entries');
    await db.clear('outbox');
    trackers.clear();
    entries.clear();
    pendingKeys.clear();
    dataChanged();
    await resetCursors();
  }
  await db.setMeta('needsLink', false);
  await db.setMeta('replaceConfirmed', false);
}

/* ---------- running a sync ---------- */

async function run(): Promise<void> {
  if (running) {
    runAgain = true;
    return;
  }
  if (!project) return setStatus('local', '');

  running = true;
  try {
    const { data, error } = await supabase().auth.getSession(); // refreshes the access token if it's about to expire
    if (error) throw error;
    if (!data.session) return setStatus('signedout');
    if (!navigator.onLine) return setStatus('offline');

    setStatus('syncing');
    await checkSchema();
    if (await db.getMeta<boolean>('needsLink')) await linkAccount();
    await flushOutbox();
    const changed = await pullChanges();
    status = 'ok';
    statusDetail = '';
    prefs.set('lastSync', Date.now());
    if (changed) dataChanged();
  } catch (error) {
    if (error instanceof WaitingForChoice) {
      // Keep the needsChoice status until the owner answers.
    } else if (error instanceof OutdatedSchema) {
      status = 'needsSchema'; // Settings shows how to run schema.sql
      statusDetail = '';
    } else if (!navigator.onLine || isNetworkFailure(error)) {
      status = 'offline';
      statusDetail = '';
    } else if (status !== 'signedout') {
      status = 'error';
      statusDetail = (error as Error).message || 'Sync failed';
    }
  } finally {
    running = false;
    notify();
    if (runAgain) {
      runAgain = false;
      setTimeout(run, 300);
    }
  }
}

/** Signs out on the server too. Throws if that fails (say, offline), leaving the person signed in. */
async function signOut(): Promise<void> {
  leaving = true;
  try {
    const { error } = await supabase().auth.signOut();
    if (error) throw error;
  } finally {
    leaving = false;
  }
  setStatus('signedout', '');
}

/**
 * A project URL must be https, except a Supabase running on this computer or the home network
 * (the local one from `supabase start` is http://127.0.0.1:54321). Throws a message for the person.
 */
function checkProjectUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The project URL should start with https://');
  }
  if (parsed.protocol === 'https:') return;
  const local = /^(localhost|127(\.\d+){3}|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)$/
    .test(parsed.hostname);
  if (parsed.protocol !== 'http:' || !local) {
    throw new Error('The project URL should start with https:// (http:// only works for a Supabase on this computer or your home network).');
  }
  // Browsers block http requests from an https page, so a local Supabase needs a local copy of the app.
  if (location.protocol === 'https:') {
    throw new Error('This copy of the app can only connect to https:// projects. To use a local Supabase, run the app with npm run dev.');
  }
}

/**
 * The token in a sign-in link from the email, or null if the text isn't one. New free projects can't change
 * the email to show a code, and opening the link would sign in Safari rather than the Home Screen app.
 */
function linkToken(text: string): string | null {
  try {
    const params = new URL(text).searchParams;
    return params.get('token_hash') || params.get('token');
  } catch {
    return null;
  }
}

/** The first sync after signing in links this device to the account; see linkAccount. */
async function startAfterSignIn(): Promise<void> {
  await db.setMeta('needsLink', true);
  setStatus('syncing');
  run();
}

/** Error codes Supabase Auth sends when asked for a code for an email that isn't a user (sign-ups are off). */
const NOT_A_USER = ['otp_disabled', 'signup_disabled', 'user_not_found'];

openClient();

export const sync = {
  /** For useSyncExternalStore: the current SyncState, and change notifications. */
  get: (): SyncState => snapshot,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  run,
  signOut,

  /** Called after every local write: syncs shortly, so rapid taps go up together. */
  syncSoon(): void {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(run, SYNC_DELAY_AFTER_WRITE_MS);
    notify();
  },

  configure(url: string, key: string): void {
    url = url.trim().replace(/\/+$/, '');
    key = key.trim();
    checkProjectUrl(url);
    if (key.length < 20) throw new Error('That key looks too short. Copy the full anon or publishable key.');
    project = { url, key };
    prefs.set('project', project);
    openClient();
    setStatus('signedout');
  },

  /** Forgets the project. Signs out on the server if it can; offline, the session is forgotten here anyway. */
  async disconnect(): Promise<void> {
    leaving = true;
    try {
      await client?.auth.signOut();
    } finally {
      leaving = false;
    }
    client?.auth.stopAutoRefresh();
    authSubscription?.unsubscribe();
    prefs.set(AUTH_PREF, null);
    client = null;
    authSubscription = null;
    session = null;
    project = null;
    prefs.set('project', null);
    setStatus('local', '');
    await resetCursors();
  },

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      throw new Error(error.code === 'invalid_credentials' || /invalid login/i.test(error.message)
        ? "That email and password don't match a user in this project."
        : error.message);
    }
    await startAfterSignIn();
  },

  async sendCode(email: string): Promise<void> {
    const { error } = await supabase().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
    if (!error) return;
    const notAUser = NOT_A_USER.includes(error.code ?? '') || /signups? not allowed|user not found/i.test(error.message);
    throw new Error(notAUser
      ? "That email isn't a user in this project. Add yourself in Supabase → Authentication → Users first."
      : error.message);
  },

  /** Signs in with the code from the email, or with its sign-in link pasted rather than opened. */
  async verify(email: string, codeOrLink: string): Promise<void> {
    const tokenHash = linkToken(codeOrLink.trim());
    const { error } = tokenHash
      ? await supabase().auth.verifyOtp({ type: 'email', token_hash: tokenHash })
      : await supabase().auth.verifyOtp({ type: 'email', email: email.trim(), token: codeOrLink.trim() });
    if (error) {
      throw new Error(/expired|invalid/i.test(error.message)
        ? "That link or code didn't work or has expired. Send a new email."
        : error.message);
    }
    await startAfterSignIn();
  },

  /** The owner's answer to needsChoice: replace this device's data, or back out and sign out. */
  async chooseReplace(replace: boolean): Promise<void> {
    if (replace) {
      await db.setMeta('replaceConfirmed', true);
      run();
    } else {
      await signOut();
      await db.setMeta('needsLink', false);
    }
  },
};
