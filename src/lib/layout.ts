// How Today lays out its start/stop and one-tap trackers: under their headings, in rows of up to two, and one with
// levels on a row of its own. Arrange changes a layout with the moves below, each returning a new one, and
// arrangedTrackers() turns the result back into the trackers' order, headings and row starts, to save.
import { activeTrackers, groupName, groupTrackers, type Data, type Tracker } from './model';

/** Headings in order, each with its rows of trackers' ids: how Today is arranged. */
export type Layout = [group: string, rows: string[][]][];

/** How many trackers fit side by side in a row. */
const ROW_SIZE = 2;

/** A start/stop tracker with levels: a whole row on Today to itself, with its levels underneath. */
export const isWide = (tracker: Tracker) => tracker.type === 'episode' && (tracker.config.levels || []).some(Boolean);

/**
 * Items in rows, in order. A new row starts once a row is full, for a wide item and after one, and before any item
 * that startsRow picks out. Today's rows and Arrange's moves both fill rows this way.
 */
function fillRows<T>(items: T[], wide: (item: T) => boolean, startsRow: (item: T) => boolean = () => false): T[][] {
  const rows: T[][] = [];
  for (const item of items) {
    const row = rows.at(-1);
    if (!row || startsRow(item) || wide(item) || wide(row[0]) || row.length >= ROW_SIZE) rows.push([item]);
    else row.push(item);
  }
  return rows;
}

/** Today's headings in order, each with its rows of trackers. A tracker marked to start a row starts one. */
export const todayGroups = (data: Data): [group: string, rows: Tracker[][]][] =>
  groupTrackers(activeTrackers(data, 'episode', 'moment'))
    .map(([group, trackers]) => [group, fillRows(trackers, isWide, t => !!t.config.new_row)]);

/** Today's layout as it shows. */
export const todayLayout = (data: Data): Layout =>
  todayGroups(data).map(([group, rows]) => [group, rows.map(row => row.map(t => t.id))]);

/* ---------- moves: each returns the new layout ---------- */

export type IsWide = (id: string) => boolean;
interface Place { g: number; r: number; i: number }

const GONE = ''; // where a moved tracker was, until tidy() takes it out

const copy = (layout: Layout): Layout => layout.map(([group, rows]) => [group, rows.map(row => [...row])]);

export function placeOf(layout: Layout, id: string): Place {
  for (const [g, [, rows]] of layout.entries()) {
    for (const [r, row] of rows.entries()) if (row.includes(id)) return { g, r, i: row.indexOf(id) };
  }
  throw new Error(`${id} isn't on Today`);
}

/** Whether a row has a space beside its trackers, for another one to go into. */
export const hasRoom = (row: string[], wide: IsWide) => row.length < ROW_SIZE && !wide(row[0]);

/** Without the moved tracker's old place, emptied rows and emptied headings; one with levels on a row of its own. */
function tidy(layout: Layout, wide: IsWide): Layout {
  return layout
    .map(([group, rows]): Layout[number] => [group, rows.flatMap(row => fillRows(row.filter(id => id !== GONE), wide))])
    .filter(([, rows]) => rows.length);
}

/** Two trackers trade places. */
export function swap(layout: Layout, a: string, b: string, wide: IsWide): Layout {
  const next = copy(layout);
  const [pa, pb] = [placeOf(next, a), placeOf(next, b)];
  next[pa.g][1][pa.r][pa.i] = b;
  next[pb.g][1][pb.r][pb.i] = a;
  return tidy(next, wide);
}

/** Into the empty space beside the tracker in row r. */
export function intoSpace(layout: Layout, id: string, g: number, r: number, wide: IsWide): Layout {
  const next = copy(layout);
  const from = placeOf(next, id);
  next[from.g][1][from.r][from.i] = GONE;
  next[g][1][r].push(id);
  return tidy(next, wide);
}

/** On a row of its own, made at row r (0 for above the heading's first row). */
export function newRow(layout: Layout, id: string, g: number, r: number, wide: IsWide): Layout {
  const next = copy(layout);
  const from = placeOf(next, id);
  next[from.g][1][from.r][from.i] = GONE;
  next[g][1].splice(r, 0, [id]);
  return tidy(next, wide);
}

/**
 * One place earlier (-1) or later (1), going through the empty spaces too: into a space, it moves there; onto a
 * tracker, they trade places. Into another heading, it's put on a row of its own, so no other tracker is moved out
 * of its heading. Null if there's nowhere to go.
 */
export function step(layout: Layout, id: string, direction: -1 | 1, wide: IsWide): Layout | null {
  const from = placeOf(layout, id);
  // Every place in reading order: a row with levels is one place, any other row has ROW_SIZE (null for a space).
  const places = layout.flatMap(([, rows], g) => rows.flatMap((row, r) => (wide(row[0])
    ? [{ g, r, id: row[0] }]
    : Array.from({ length: ROW_SIZE }, (_, i): { g: number; r: number; id: string | null } => ({ g, r, id: row[i] ?? null })))));
  let k = places.findIndex(p => p.id === id) + direction;
  // Past the space beside itself (it would stay put), and any space, for one with levels (it takes a whole row).
  while (places[k] && places[k].id === null && (wide(id) || (places[k].g === from.g && places[k].r === from.r))) k += direction;
  const to = places[k];
  if (!to) return null;
  if (to.id === null) return intoSpace(layout, id, to.g, to.r, wide);
  if (to.g !== from.g) return newRow(layout, id, to.g, direction > 0 ? 0 : layout[to.g][1].length, wide);
  return swap(layout, id, to.id, wide);
}

/** Off the row it shares, onto a new one just below. Null if it has a row to itself already. */
export function ownRow(layout: Layout, id: string, wide: IsWide): Layout | null {
  const { g, r } = placeOf(layout, id);
  return layout[g][1][r].length > 1 ? newRow(layout, id, g, r + 1, wide) : null;
}

/** A heading, with its trackers, one place up (-1) or down (1). */
export function moveHeading(layout: Layout, index: number, direction: -1 | 1): Layout {
  const next = copy(layout);
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  return next;
}

/* ---------- saving ---------- */

/**
 * The trackers that change when Today is arranged as layout. Its trackers take the places in the list they held
 * between them, in the new order, so the check-in trackers stay where they were. A tracker moved under another
 * heading takes its name, and each one that begins a row (after a heading's first) is marked to, so the rows come
 * back as they were left.
 */
export function arrangedTrackers(data: Data, layout: Layout): Tracker[] {
  const placed = new Map(layout.flatMap(([group, rows]) =>
    rows.flatMap((row, r) => row.map((id, i) => [id, { group, newRow: r > 0 && i === 0 }] as const))));
  const newOrder = layout.flatMap(([, rows]) => rows.flat());
  let next = 0;
  const order = activeTrackers(data).map(t => (placed.has(t.id) ? data.trackers.get(newOrder[next++])! : t));
  return order.flatMap((tracker, i) => {
    const sort_order = (i + 1) * 10;
    const place = placed.get(tracker.id);
    if (!place) return tracker.sort_order === sort_order ? [] : [{ ...tracker, sort_order }];
    // Unchanged when it stays put, so a tracker without a heading keeps none rather than becoming "Other".
    const group_name = place.group === groupName(tracker) ? tracker.group_name : place.group;
    const { new_row, ...config } = tracker.config;
    const sameRow = !!new_row === place.newRow;
    if (tracker.sort_order === sort_order && tracker.group_name === group_name && sameRow) return [];
    return [{ ...tracker, sort_order, group_name, config: sameRow ? tracker.config : place.newRow ? { ...config, new_row: true } : config }];
  });
}
