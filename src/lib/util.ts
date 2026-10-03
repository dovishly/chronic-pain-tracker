// Small helpers: dates and times, ids, saved preferences.

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

/** "45 min" or "2 h 05 min". Negative durations show as 0 min. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)} min`;
}

/** "9:05 AM" if ms is today, otherwise e.g. "Yesterday 9:05 AM". */
export function startedAt(ms: number): string {
  const time = formatTime(ms);
  return dayKey(ms) === dayKey(Date.now()) ? time : `${dayLabel(dayKey(ms))} ${time}`;
}

/* ---------- ids ---------- */

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers: a random version-4 UUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/* ---------- preferences ---------- */

/** Small settings kept as JSON in localStorage under "logbook.<name>". */
export const prefs = {
  get<T>(name: string, fallback: T | null = null): T | null {
    try {
      const stored = localStorage.getItem('logbook.' + name);
      return stored == null ? fallback : (JSON.parse(stored) as T);
    } catch {
      return fallback;
    }
  },
  set(name: string, value: unknown): void {
    try {
      if (value == null) localStorage.removeItem('logbook.' + name);
      else localStorage.setItem('logbook.' + name, JSON.stringify(value));
    } catch {
      // Storage unavailable (e.g. private browsing); the app keeps working without it.
    }
  },
};
