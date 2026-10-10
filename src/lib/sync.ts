// Sync with the owner's Supabase project. This is the only code that talks to it.
// Local changes wait in the outbox (outbox.ts) until they're uploaded; changes made on other devices are
// pulled in after a cursor. A sync runs on start, every minute, on focus, when back online, and shortly
// after each change (see main.tsx and store.ts).
import { createClient, type Session, type Subscription, type SupabaseClient } from '@supabase/supabase-js';
import { createStore, prefs } from './util';
import { db } from './db';
import { clearMemory, dataStore, putInMemory } from './data';
import { outbox } from './outbox';
import { normalizeEntry, normalizeTracker, type Entry, type Table, type Tracker } from './model';

export type SyncStatus = 'local' | 'signedout' | 'syncing' | 'offline' | 'ok' | 'error' | 'needsChoice' | 'needsSchema';

/** Everything the UI shows about sync. */
export interface SyncState {
  status: SyncStatus;
  detail: string;            // the error, or why the person was signed out
  projectUrl: string | null; // null when no project is connected
  signedIn: boolean;
  email: string | null;
  waiting: number;           // local changes not uploaded yet
  lastSync: number | null;
}

const TABLES: Table[] = ['trackers', 'entries']; // trackers first, so entries never point at a missing tracker

interface Project { url: string; key: string } // project URL and anon/publishable key

/** Where the last pull stopped: the last row's updated_at, and its id to tell apart rows that share one. */
interface Cursor { updatedAt: string; id: string }

const UPLOAD_BATCH = 200;
const PULL_PAGE = 1000;
const SYNC_DELAY_AFTER_CHANGE_MS = 700; // lets a burst of taps go up in one request
const AUTH_PREF = 'auth'; // the pref supabase-js keeps the session in

/** The lowest logbook_schema_version() this app syncs with. Raise it with the one in schema.sql. */
const SCHEMA_VERSION = 3;

let project = prefs.get<Project>('project');
let client: SupabaseClient | null = null;
let authSubscription: Subscription | null = null;
let session: Session | null = null;
let signingOut = false; // so a deliberate sign-out isn't reported as an expired sign-in

let status: SyncStatus = 'local';
let detail = '';
let running = false;
let runAgain = false;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
let schemaChecked = false; // set once the database is new enough, for this app session and project

export const syncState = createStore<SyncState>(currentState());

function currentState(): SyncState {
  return {
    status,
    detail,
    projectUrl: project?.url ?? null,
    signedIn: !!session,
    email: session?.user.email ?? null,
    waiting: outbox.size(),
    lastSync: prefs.get<number>('lastSync'),
  };
}

const notify = () => syncState.set(currentState());

function setStatus(next: SyncStatus, nextDetail = ''): void {
  status = next;
  detail = nextDetail;
  notify();
}

/** A failed Supabase call. status is the HTTP status, or 0 when the request never reached the server. */
class SyncError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const isNetworkFailure = (error: unknown) =>
  !navigator.onLine || error instanceof TypeError || (error as { status?: unknown })?.status === 0;

/* ---------- the Supabase client ---------- */

function openClient(): void {
  if (!project) return;
  client = createClient(project.url, project.key, {
    auth: { storageKey: prefs.key(AUTH_PREF), detectSessionInUrl: false },
    db: { retry: false }, // the outbox retries: every minute, on focus and when back online
  });
  authSubscription = client.auth.onAuthStateChange((event, next) => {
    session = next;
    if (event === 'SIGNED_OUT' && !signingOut) setStatus('signedout', 'Your sign-in expired. Sign in again in Settings.');
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

/* ---------- a sync ---------- */

async function run(): Promise<void> {
  if (running) {
    runAgain = true;
    return;
  }
  if (!project) return setStatus('local');
  running = true;
  try {
    await syncOnce();
  } catch (error) {
    if (isNetworkFailure(error)) setStatus('offline');
    else if (status !== 'signedout') setStatus('error', (error as Error).message || 'Sync failed');
  } finally {
    running = false;
    notify(); // the waiting count may have changed
    if (runAgain) {
      runAgain = false;
      setTimeout(run, 300);
    }
  }
}

/** Uploads this device's changes and downloads everyone else's, setting the status as it goes. */
async function syncOnce(): Promise<void> {
  const { data, error } = await supabase().auth.getSession(); // refreshes the sign-in if it's about to expire
  if (error) throw error;
  if (!data.session) return setStatus('signedout', detail); // keeps saying why, if the sign-in expired
  if (!navigator.onLine) return setStatus('offline');

  setStatus('syncing');
  if (!(await schemaIsCurrent())) return setStatus('needsSchema'); // Settings → Sync shows how to update it
  if ((await db.getMeta<boolean>('needsLink')) && !(await linkAccount())) return setStatus('needsChoice');
  await flushOutbox();
  await pullChanges();
  prefs.set('lastSync', Date.now());
  setStatus('ok');
}

/** Whether the database has the tables and columns this app uploads (see SCHEMA_VERSION). */
async function schemaIsCurrent(): Promise<boolean> {
  if (schemaChecked) return true;
  const { data, error, status: httpStatus } = await supabase().rpc('logbook_schema_version');
  // 404: there's no such function, so schema.sql hasn't been run yet, or is from before versions were tracked.
  if (error && httpStatus !== 404) throw new SyncError(error.message, httpStatus);
  schemaChecked = !error && Number(data) >= SCHEMA_VERSION;
  return schemaChecked;
}

/**
 * The first sync after signing in on this device. An empty account just receives this device's data. An
 * account that already has trackers replaces it, but if this device has entries of its own, the owner is
 * asked first (status needsChoice). Returns false while waiting for that answer.
 */
async function linkAccount(): Promise<boolean> {
  const accountTrackers = await check(supabase().from('trackers').select('id').eq('deleted', false).limit(1));
  if (accountTrackers?.length) {
    const hasOwnEntries = [...dataStore.get().entries.values()].some(e => !e.deleted);
    if (hasOwnEntries && !(await db.getMeta<boolean>('replaceConfirmed'))) return false;
    for (const store of ['trackers', 'entries'] as const) await db.clear(store);
    await outbox.clear();
    clearMemory();
    await resetCursors();
  }
  await db.setMeta('needsLink', false);
  await db.setMeta('replaceConfirmed', false);
  return true;
}

/** Uploads waiting changes. An item leaves the outbox only if it wasn't changed again while being sent. */
async function flushOutbox(): Promise<void> {
  const items = await outbox.all();
  for (const table of TABLES) {
    const waiting = items.filter(item => item.table === table);
    for (let i = 0; i < waiting.length; i += UPLOAD_BATCH) {
      const batch = waiting.slice(i, i + UPLOAD_BATCH);
      await check(supabase().from(table).upsert(batch.map(item => item.row)));
      await outbox.remove(batch);
    }
  }
}

const cursorKey = (table: Table) => 'cursor:' + table;

/** Downloads rows changed since the last pull. */
async function pullChanges(): Promise<void> {
  for (const table of TABLES) {
    let cursor = await db.getMeta<Cursor>(cursorKey(table));
    let rows: Record<string, unknown>[];
    do {
      let query = supabase().from(table).select('*');
      if (cursor) query = query.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`);
      rows = (await check(query.order('updated_at').order('id').limit(PULL_PAGE))) ?? [];
      await takeIn(table, rows);
      if (rows.length) {
        const last = rows[rows.length - 1];
        cursor = { updatedAt: String(last.updated_at), id: String(last.id) };
        await db.setMeta(cursorKey(table), cursor);
      }
    } while (rows.length === PULL_PAGE);
  }
}

/** Keeps pulled rows, except ones this device already has or has a change of its own to. */
async function takeIn(table: Table, rows: Record<string, unknown>[]): Promise<void> {
  const inMemory: ReadonlyMap<string, Tracker | Entry> = dataStore.get()[table];
  const normalize = table === 'trackers' ? normalizeTracker : normalizeEntry;
  const fresh = rows
    .filter(row => !outbox.has(table, String(row.id))) // the local change wins until it's uploaded
    .filter(row => inMemory.get(String(row.id))?.updated_at !== row.updated_at)
    .map(row => normalize(row));
  if (!fresh.length) return;
  putInMemory(table, fresh);
  await db.putMany(table, fresh);
}

async function resetCursors(): Promise<void> {
  for (const table of TABLES) await db.setMeta(cursorKey(table), null);
}

/* ---------- what the app calls ---------- */

/** After every local change: syncs shortly, so rapid taps go up together. */
function syncSoon(): void {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(run, SYNC_DELAY_AFTER_CHANGE_MS);
  notify();
}

// A local Supabase (http://127.0.0.1:54321 from `supabase start`) or one on the home network: localhost,
// 127.x.x.x, [::1], 10.x.x.x, 192.168.x.x, 172.16–31.x.x, or a *.local name.
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)$/;

/** Connects a project. Throws a message for the person if the URL or key can't be right. */
function configure(url: string, key: string): void {
  url = url.trim().replace(/\/+$/, '');
  key = key.trim();
  checkProjectUrl(url);
  if (key.length < 20) throw new Error('That key looks too short. Copy the full anon or publishable key.');
  project = { url, key };
  prefs.set('project', project);
  schemaChecked = false;
  openClient();
  setStatus('signedout');
}

/** A project URL must be https, except a local one, which also needs the app itself on http (npm run dev). */
function checkProjectUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The project URL should start with https://');
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:' || !LOCAL_HOST.test(parsed.hostname)) {
    throw new Error('The project URL should start with https:// (http:// only works for a Supabase on this computer or your home network).');
  }
  // Browsers block http requests from an https page.
  if (location.protocol === 'https:') {
    throw new Error('This copy of the app can only connect to https:// projects. To use a local Supabase, run the app with npm run dev.');
  }
}

async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    throw new Error(error.code === 'invalid_credentials' || /invalid login/i.test(error.message)
      ? "That email and password don't match a user in this project."
      : error.message);
  }
  await db.setMeta('needsLink', true); // the first sync links this device to the account
  setStatus('syncing');
  run();
}

/** Signs out here and on the server, so it needs a connection. */
async function signOut(): Promise<void> {
  if (!navigator.onLine) throw new Error('Signing out needs a connection.');
  signingOut = true;
  try {
    const { error } = await supabase().auth.signOut();
    // supabase-js forgets the session even when the server call fails, and then this device is signed out all the same.
    if (error && session) throw error;
  } finally {
    signingOut = false;
  }
  setStatus('signedout');
}

/** The owner's answer to needsChoice: replace this device's data with the account's, or back out and sign out. */
async function chooseReplace(replace: boolean): Promise<void> {
  if (replace) {
    await db.setMeta('replaceConfirmed', true);
    run();
  } else {
    await signOut();
    await db.setMeta('needsLink', false);
  }
}

/** Forgets the project. Signs out on the server if it can; offline, the session is forgotten here anyway. */
async function disconnect(): Promise<void> {
  signingOut = true;
  try {
    await client?.auth.signOut();
  } finally {
    signingOut = false;
  }
  client?.auth.stopAutoRefresh();
  authSubscription?.unsubscribe();
  prefs.set(AUTH_PREF, null);
  client = null;
  authSubscription = null;
  session = null;
  project = null;
  schemaChecked = false;
  prefs.set('project', null);
  setStatus('local');
  await resetCursors();
}

/**
 * Marks every tracker and entry in the account deleted, including ones this device hasn't downloaded yet; the
 * triggers in schema.sql wipe what they held. Trackers go first: an entry whose tracker is deleted counts as
 * deleted, so once they're done, so is the reset.
 */
async function deleteAccountData(): Promise<void> {
  if (!session) throw new Error('Sign in first.');
  if (status === 'needsSchema') throw new Error('Your Supabase project needs updating first (see Sync).');
  try {
    await check(supabase().from('trackers').update({ deleted: true }).eq('deleted', false));
  } catch (error) {
    if (isNetworkFailure(error)) throw new Error('Resetting everywhere needs a connection. Nothing was changed.');
    throw error;
  }
  await supabase().from('entries').update({ deleted: true }).eq('deleted', false); // tidying up, so a failure doesn't matter
}

openClient();

export const sync = { run, syncSoon, configure, signIn, signOut, chooseReplace, disconnect, deleteAccountData };
