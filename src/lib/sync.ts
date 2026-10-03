// Sync with the owner's own Supabase project over plain HTTPS: the REST (/rest/v1) and
// Auth (/auth/v1) endpoints, no SDK. The protocol is described in CLAUDE.md.
import { prefs } from './util';
import { db } from './db';
import { trackers, entries, pendingKeys, dataChanged } from './data';
import { normalizeEntry, normalizeTracker, type Entry, type Tracker } from './model';

export type SyncStatus = 'local' | 'signedout' | 'syncing' | 'offline' | 'ok' | 'error' | 'needsChoice';

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

interface Config { url: string; key: string } // project URL and anon/publishable key
interface Session { access_token: string; refresh_token: string; expires_at: number; email: string | null }
interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: { email?: string };
}
/** A queued write. v is the item's updated_at when queued, so an upload can tell if it changed since. */
export interface OutboxItem { key: string; table: Table; v: string | undefined; row: Record<string, unknown> }

type Table = 'trackers' | 'entries';
const TABLES: Table[] = ['trackers', 'entries']; // trackers first, so entries never point at a missing tracker
const UPLOAD_BATCH = 200;
const PULL_PAGE = 1000;
const REFRESH_MARGIN_MS = 90_000;      // refresh the access token once it has less than this left
const SYNC_DELAY_AFTER_WRITE_MS = 700; // lets a burst of taps go up in one request

/**
 * The schema.sql version this app needs: public.logbook_schema_version() in the database must be at
 * least this. Raise both together whenever schema.sql changes the tables (see "Changing the data model"
 * in CLAUDE.md), so a phone never syncs against a database that's missing what it sends.
 */
const SCHEMA_VERSION = 1;
const OUTDATED_SCHEMA_MESSAGE =
  'Your Supabase database needs an update. Run the latest schema.sql in the Supabase SQL Editor (see the setup guide), then tap Sync now.';

let config = prefs.get<Config>('cfg');
let session = prefs.get<Session>('session');
let status: SyncStatus = 'local';
let statusDetail = '';

let running = false;
let runAgain = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | null = null; // the in-flight token refresh, shared by everyone who needs it
let schemaChecked = false;                    // once per app session; "Sync now" after an error checks again

const listeners = new Set<() => void>();
let snapshot = buildSnapshot();

function buildSnapshot(): SyncState {
  return {
    status,
    detail: statusDetail,
    projectUrl: config?.url ?? null,
    signedIn: !!session,
    email: session?.email ?? null,
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

/** An Error from a Supabase call, with the HTTP status and the server's error code if it sent one. */
export class RequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

/** Thrown by linkAccount while it waits for the owner to answer needsChoice. */
class WaitingForChoice extends Error {}

/** Thrown when the database's schema is older than this app needs. */
class OutdatedSchema extends Error {}

/* ---------- HTTP and auth ---------- */

function setSession(auth: AuthResponse | null): void {
  session = auth ? {
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    expires_at: auth.expires_at || Math.floor(Date.now() / 1000) + (auth.expires_in || 3600),
    email: auth.user?.email || session?.email || null,
  } : null;
  prefs.set('session', session);
}

const tokenExpiresSoon = (s: Session) => s.expires_at * 1000 - Date.now() <= REFRESH_MARGIN_MS;

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
}

/**
 * Calls a Supabase endpoint and returns the parsed JSON (or null for an empty body).
 * Throws a RequestError on failure. With auth, sends the access token, and retries once
 * after a refresh if the server rejects it.
 */
async function request<T = unknown>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const { method = 'GET', body, headers = {}, auth = true } = options;
  if (!config) throw new Error('Not connected');
  // Signed-out calls (send code, verify, refresh) need only the apikey header.
  const allHeaders: Record<string, string> = { apikey: config.key, 'Content-Type': 'application/json', ...headers };
  if (auth) {
    if (session && tokenExpiresSoon(session)) await refresh();
    if (!session) throw new RequestError('Signed out', 401);
    allHeaders.Authorization = 'Bearer ' + session.access_token;
  }

  const response = await fetch(config.url.replace(/\/+$/, '') + path, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && auth && !isRetry) {
    await refresh(true);
    return request<T>(path, options, true);
  }

  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; the status code alone says what happened.
  }
  if (!response.ok) {
    const message = json && (json.msg || json.message || json.error_description || json.error);
    const code = json && (json.error_code || json.code); // Auth sends error_code (text) and code (the status)
    throw new RequestError(
      typeof message === 'string' ? message : `Request failed (${response.status})`,
      response.status,
      code == null ? undefined : String(code),
    );
  }
  return json as T;
}

/**
 * Swaps the refresh token for a new session (only when the token is about to expire,
 * unless forced). If the server rejects the refresh token, signs out.
 */
function refresh(force = false): Promise<void> {
  // Decide before starting, so a refresh that has nothing to do never leaves `refreshing` set.
  if (refreshing) return refreshing;
  const current = session;
  if (!current?.refresh_token) return Promise.resolve();
  if (!force && !tokenExpiresSoon(current)) return Promise.resolve();

  refreshing = (async () => {
    try {
      const auth = await request<AuthResponse>('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: current.refresh_token },
        auth: false,
      });
      setSession(auth);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : undefined;
      const rejected = status !== undefined && status >= 400 && status < 500;
      if (!rejected) throw error;
      setSession(null);
      setStatus('signedout', 'Your sign-in expired. Sign in again in Settings.');
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ---------- upload and download ---------- */

/** Uploads queued writes. An outbox item is removed only if it wasn't changed again while being sent. */
async function flushOutbox(): Promise<void> {
  const items = await db.all<OutboxItem>('outbox');
  for (const table of TABLES) {
    const tableItems = items.filter(item => item.table === table);
    for (let i = 0; i < tableItems.length; i += UPLOAD_BATCH) {
      const batch = tableItems.slice(i, i + UPLOAD_BATCH);
      await request('/rest/v1/' + table, {
        method: 'POST',
        body: batch.map(item => item.row),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      for (const item of batch) {
        const current = await db.get<OutboxItem>('outbox', item.key);
        if (current && current.v === item.v) {
          await db.remove('outbox', item.key);
          pendingKeys.delete(item.key);
        }
      }
    }
  }
}

/** Downloads rows changed since the last pull. Returns true if anything on this device changed. */
async function pullChanges(): Promise<boolean> {
  let changed = false;
  for (const table of TABLES) {
    let cursor = (await db.getMeta<string>('cursor:' + table)) || '1970-01-01T00:00:00Z';
    while (true) {
      const query = `select=*&updated_at=gte.${encodeURIComponent(cursor)}&order=updated_at.asc&limit=${PULL_PAGE}`;
      const rows = (await request<Record<string, unknown>[] | null>(`/rest/v1/${table}?${query}`)) || [];

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
        await db.setMeta('cursor:' + table, cursor);
      }
      if (rows.length < PULL_PAGE) break;
    }
  }
  return changed;
}

/** Makes sure the database has the tables and columns this app sends; see SCHEMA_VERSION. */
async function checkSchema(): Promise<void> {
  if (schemaChecked) return;
  let version = 0;
  try {
    version = await request<number>('/rest/v1/rpc/logbook_schema_version', { method: 'POST', body: {} });
  } catch (error) {
    // 404: the function doesn't exist yet, so schema.sql is from before versions were tracked.
    if (!(error instanceof RequestError && error.status === 404)) throw error;
  }
  if (version < SCHEMA_VERSION) throw new OutdatedSchema();
  schemaChecked = true;
}

async function resetCursors(): Promise<void> {
  await db.setMeta('cursor:trackers', null);
  await db.setMeta('cursor:entries', null);
}

/**
 * First sign-in on this device. An empty account just receives this device's data on the next
 * upload. An account that already has trackers replaces this device's data, but if this device
 * has entries of its own, the owner is asked first (status needsChoice).
 */
async function linkAccount(): Promise<void> {
  const accountTrackers = await request<unknown[] | null>('/rest/v1/trackers?select=id&limit=1');
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
  if (!config) return setStatus('local', '');
  if (!session) return setStatus('signedout');
  if (!navigator.onLine) return setStatus('offline');

  running = true;
  setStatus('syncing');
  try {
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
      status = 'error';
      statusDetail = OUTDATED_SCHEMA_MESSAGE;
    } else if (!navigator.onLine || error instanceof TypeError) { // fetch throws TypeError when the network fails
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

async function signOut(): Promise<void> {
  try {
    await request('/auth/v1/logout', { method: 'POST' });
  } catch {
    // Forgetting the session locally is enough.
  }
  setSession(null);
  setStatus('signedout');
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
    url = url.trim();
    key = key.trim();
    checkProjectUrl(url);
    if (key.length < 20) throw new Error('That key looks too short. Copy the full anon or publishable key.');
    config = { url: url.replace(/\/+$/, ''), key };
    prefs.set('cfg', config);
    setStatus('signedout');
  },

  async disconnect(): Promise<void> {
    try {
      if (session) await request('/auth/v1/logout', { method: 'POST' });
    } catch {
      // Forgetting the session locally is enough.
    }
    setSession(null);
    config = null;
    prefs.set('cfg', null);
    setStatus('local');
    await resetCursors();
  },

  async sendCode(email: string): Promise<void> {
    await request('/auth/v1/otp', {
      method: 'POST',
      auth: false,
      body: { email: email.trim(), create_user: false },
    });
  },

  async verify(email: string, code: string): Promise<void> {
    const auth = await request<AuthResponse>('/auth/v1/verify', {
      method: 'POST',
      auth: false,
      body: { type: 'email', email: email.trim(), token: code.trim() },
    });
    setSession(auth);
    await db.setMeta('needsLink', true);
    setStatus('syncing');
    run();
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
