export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const nowIso = () => new Date().toISOString();

/* ---------- dates and times (all in the device's local time zone) ---------- */

/** The calendar day of a timestamp, as "YYYY-MM-DD". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Midnight at the start of a "YYYY-MM-DD" day, in ms. */
export function dayStart(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** The day after a "YYYY-MM-DD" day. (30 h past midnight is always the next day, even across DST changes.) */
export const nextDay = (key: string) => dayKey(dayStart(key) + 30 * 60 * MINUTE_MS);

/** "Today", "Yesterday", or a short date like "Mon, Sep 29". */
export function dayLabel(key: string): string {
  if (key === dayKey(Date.now())) return 'Today';
  if (key === dayKey(Date.now() - DAY_MS)) return 'Yesterday';
  return new Date(dayStart(key)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "HH:MM", 24-hour, as used by <input type="time"> and the CSV export. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:MM", as used by <input type="datetime-local">. */
export const toDateTimeInputValue = (ms: number) => `${dayKey(ms)}T${clockTime(ms)}`;

/** Time of day in the person's own format, e.g. "9:05 AM". */
export const formatTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "9:05 AM" if ms is today, otherwise with its day, e.g. "Yesterday 9:05 AM". */
export function formatDayTime(ms: number): string {
  const time = formatTime(ms);
  return dayKey(ms) === dayKey(Date.now()) ? time : `${dayLabel(dayKey(ms))} ${time}`;
}

/** "45 min" or "2 h 05 min". Negative durations show as 0 min. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)} min`;
}

/* ---------- collections ---------- */

/** Items grouped by key, groups in order of first appearance. */
export function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * For the default branch of a switch that must handle every case: `default: return unhandled(tracker.type, null);`
 * A missing case is a type error. At runtime it returns the fallback, so unknown values from a newer app are skipped.
 */
export function unhandled<T>(value: never, fallback: T): T {
  void value;
  return fallback;
}

/* ---------- state that React follows ---------- */

/** A value that changes over time. Components follow one with useStore() in hooks.ts. */
export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(value: T): Store<T> {
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ---------- ids ---------- */

export function uuid(): string {
  // randomUUID only exists on https pages, so a copy of the app served over http (npm run dev on the home network)
  // builds a random version-4 UUID itself.
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/* ---------- preferences ---------- */

/** Small settings kept as JSON in localStorage under "logbook.<name>". Storage can be unavailable (private browsing). */
export const prefs = {
  /** The localStorage key for a setting. */
  key: (name: string) => 'logbook.' + name,

  get<T>(name: string): T | null {
    try {
      const stored = localStorage.getItem(prefs.key(name));
      return stored == null ? null : (JSON.parse(stored) as T);
    } catch {
      return null;
    }
  },

  /** Saves a setting; null removes it. */
  set(name: string, value: unknown): void {
    try {
      if (value == null) localStorage.removeItem(prefs.key(name));
      else localStorage.setItem(prefs.key(name), JSON.stringify(value));
    } catch {
      // The app keeps working without it.
    }
  },

  /** Removes every setting, including the supabase-js session. */
  clearAll(): void {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefs.key(''))) localStorage.removeItem(key);
    } catch {
      // Nothing to clear.
    }
  },
};
