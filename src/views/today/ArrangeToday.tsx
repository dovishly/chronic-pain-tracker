import { Fragment, useState, type CSSProperties, type Ref } from 'react';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { activeTrackers, groupTrackers, isWide, todayRows, type Data, type Tracker } from '../../lib/model';
import { arrangeToday, type Layout } from '../../lib/actions';
import { colorStyle } from '../../components/color';
import type { NewTrackerRequest } from '../settings/SettingsView';

/** Today's headings and their rows of trackers, as they show. */
export const todayLayout = (data: Data): Layout =>
  groupTrackers(activeTrackers(data, 'episode', 'moment'))
    .map(([group, trackers]) => [group, todayRows(trackers).map(row => row.map(t => t.id))]);

/* ---------- moves: each returns the new layout ---------- */

type IsWide = (id: string) => boolean;
interface Place { g: number; r: number; i: number }

const GONE = ''; // where a moved tracker was, until tidy() takes it out

const copy = (layout: Layout): Layout => layout.map(([group, rows]) => [group, rows.map(row => [...row])]);

function placeOf(layout: Layout, id: string): Place {
  for (const [g, [, rows]] of layout.entries()) {
    for (const [r, row] of rows.entries()) if (row.includes(id)) return { g, r, i: row.indexOf(id) };
  }
  throw new Error(`${id} isn't on Today`);
}

/** Without the moved tracker's old place, emptied rows and emptied headings; one with levels on a row of its own. */
function tidy(layout: Layout, wide: IsWide): Layout {
  return layout
    .map(([group, rows]): Layout[number] => [group, rows.flatMap(row => {
      const tidied: string[][] = [];
      for (const id of row.filter(id => id !== GONE)) {
        const last = tidied.at(-1);
        if (!last || wide(id) || wide(last[0]) || last.length >= 2) tidied.push([id]);
        else last.push(id);
      }
      return tidied;
    })])
    .filter(([, rows]) => rows.length);
}

/** Two trackers trade places. */
function swap(layout: Layout, a: string, b: string, wide: IsWide): Layout {
  const next = copy(layout);
  const [pa, pb] = [placeOf(next, a), placeOf(next, b)];
  next[pa.g][1][pa.r][pa.i] = b;
  next[pb.g][1][pb.r][pb.i] = a;
  return tidy(next, wide);
}

/** Into the empty space beside the one tracker in row r. */
function intoSpace(layout: Layout, id: string, g: number, r: number, wide: IsWide): Layout {
  const next = copy(layout);
  const from = placeOf(next, id);
  next[from.g][1][from.r][from.i] = GONE;
  next[g][1][r].push(id);
  return tidy(next, wide);
}

/** On a row of its own, made at row r (0 for above the heading's first row). */
function newRow(layout: Layout, id: string, g: number, r: number, wide: IsWide): Layout {
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
function step(layout: Layout, id: string, direction: -1 | 1, wide: IsWide): Layout | null {
  const from = placeOf(layout, id);
  const places = layout.flatMap(([, rows], g) => rows.flatMap((row, r) =>
    wide(row[0]) ? [{ g, r, id: row[0] }] : [{ g, r, id: row[0] }, { g, r, id: row[1] ?? null }]));
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
function ownRow(layout: Layout, id: string, wide: IsWide): Layout | null {
  const { g, r } = placeOf(layout, id);
  return layout[g][1][r].length > 1 ? newRow(layout, id, g, r + 1, wide) : null;
}

/** A heading, with its trackers, one place up (-1) or down (1). */
function moveHeading(layout: Layout, index: number, direction: -1 | 1): Layout {
  const next = copy(layout);
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  return next;
}

/* ---------- the view ---------- */

interface Props {
  data: Data;
  running: Set<string>;
  onAddTracker: (request: NewTrackerRequest) => void;
  onDone: () => void;
}

/**
 * Today with its trackers held still to be moved. Drag a tile onto another to trade places, into the empty space
 * beside a tile on its own, or between rows for a row of its own; or tap one and use the arrows in the bar (or the
 * arrow keys). Headings move with their own arrows, and each has "+ Add". Each move is saved as it's made.
 */
export function ArrangeToday({ data, running, onAddTracker, onDone }: Props) {
  const layout = todayLayout(data);
  const tracker = (id: string) => data.trackers.get(id)!;
  const wide: IsWide = id => isWide(tracker(id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [pickedId, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // Let go of a tracker that's no longer on Today (archived, say, on another device).
  const picked = pickedId && layout.some(([, rows]) => rows.some(row => row.includes(pickedId))) ? pickedId : null;

  // A quick touch still scrolls the page: a tile lifts after a short press, or with the mouse once it moves.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const where = (id: string, in_: Layout) => {
    const { g, r } = placeOf(in_, id);
    const [group, rows] = in_[g];
    const partner = rows[r].find(other => other !== id);
    return `${tracker(id).name}: ${group}, row ${r + 1} of ${rows.length}, ${partner ? `beside ${tracker(partner).name}` : 'on its own'}`;
  };

  const save = (next: Layout | null, id?: string) => {
    if (!next) return;
    const hadFocus = id && (document.activeElement as HTMLElement | null)?.dataset.arrange === id;
    void arrangeToday(next);
    if (id) setStatus(where(id, next));
    // A tile in a new row or heading is drawn afresh there, so give it back the focus it had.
    if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-arrange="${id}"]`)?.focus());
  };

  const pick = (id: string) => {
    const next = picked === id ? null : id;
    setPicked(next);
    setStatus(next ? `${tracker(id).name} picked. Move it with the arrows.` : '');
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={({ active, over }) => {
        setDragging(null);
        const id = String(active.id);
        const [kind, a, b] = String(over?.id ?? '').split(':');
        if (kind === 'tile' && a !== id) save(swap(layout, id, a, wide), id);
        if (kind === 'space') save(intoSpace(layout, id, +a, +b, wide), id);
        if (kind === 'gap') save(newRow(layout, id, +a, +b, wide), id);
      }}
    >
      {/* First, so it's found first; drawn at the bottom of the screen, within reach of a thumb. */}
      <div className="arrange-bar" role="group" aria-label="Arrange Today">
        {picked ? (
          <>
            <p className="arrange-hint arrange-picked">{tracker(picked).name}</p>
            <button type="button" className="arrange-arrow" id="arrange-earlier" aria-label={`Move ${tracker(picked).name} earlier`}
              disabled={!step(layout, picked, -1, wide)} onClick={() => save(step(layout, picked, -1, wide), picked)}>←</button>
            <button type="button" className="arrange-arrow" id="arrange-later" aria-label={`Move ${tracker(picked).name} later`}
              disabled={!step(layout, picked, 1, wide)} onClick={() => save(step(layout, picked, 1, wide), picked)}>→</button>
            <button type="button" className="arrange-arrow arrange-new-row" id="arrange-new-row"
              aria-label={`Put ${tracker(picked).name} on a new row`}
              disabled={!ownRow(layout, picked, wide)} onClick={() => save(ownRow(layout, picked, wide), picked)}>New row</button>
          </>
        ) : (
          <p className="arrange-hint">Drag a tile, or tap one to use the arrows.</p>
        )}
        <button type="button" className="button primary" id="arrange-done" onClick={onDone}>Done</button>
      </div>

      {layout.map(([group, rows], g) => (
        <section key={group}>
          <div className="row-between section-header">
            <h2>{group}</h2>
            <span className="heading-moves">
              {/* A new one of the kind the heading already has, start/stop first. */}
              <button type="button" className="add-link" aria-label={`Add to ${group}`}
                onClick={() => onAddTracker({
                  type: rows.flat().some(id => tracker(id).type === 'episode') ? 'episode' : 'moment', group,
                })}>
                + Add
              </button>
              <button type="button" className="heading-move" aria-label={`Move ${group} up`} disabled={g === 0}
                onClick={() => save(moveHeading(layout, g, -1))}>↑</button>
              <button type="button" className="heading-move" aria-label={`Move ${group} down`} disabled={g === layout.length - 1}
                onClick={() => save(moveHeading(layout, g, 1))}>↓</button>
            </span>
          </div>
          <div className={dragging ? 'today-grid arrange-grid is-dragging' : 'today-grid arrange-grid'}>
            <Gap g={g} r={0} />
            {rows.map((row, r) => (
              <Fragment key={r}>
                {row.map((id, i) => (
                  <DraggableTile key={id} tracker={tracker(id)} running={running.has(id)} startsRow={i === 0}
                    picked={picked === id} onPick={() => pick(id)}
                    onMove={direction => save(step(layout, id, direction, wide), id)} />
                ))}
                {row.length === 1 && !wide(row[0]) && <Space g={g} r={r} disabled={!!dragging && wide(dragging)} />}
                <Gap g={g} r={r + 1} />
              </Fragment>
            ))}
          </div>
        </section>
      ))}

      <DragOverlay>
        {dragging && <Tile tracker={tracker(dragging)} running={running.has(dragging)} lifted />}
      </DragOverlay>
      <p className="visually-hidden" aria-live="polite">{status}</p>
    </DndContext>
  );
}

/** The empty half of a row with one tile in it: drop a tile here to put it beside that one. */
function Space({ g, r, disabled }: { g: number; r: number; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `space:${g}:${r}`, disabled });
  return <div ref={setNodeRef} className={isOver ? 'arrange-space is-over' : 'arrange-space'} aria-hidden="true" />;
}

/** Between rows (and above the first): drop a tile here for a new row of its own. */
function Gap({ g, r }: { g: number; r: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${g}:${r}` });
  return <div ref={setNodeRef} className={isOver ? 'arrange-gap is-over' : 'arrange-gap'} aria-hidden="true" />;
}

interface TileProps {
  tracker: Tracker;
  running: boolean;
  startsRow?: boolean;
  picked?: boolean;
  lifted?: boolean;
  onPick?: () => void;
  onMove?: (direction: -1 | 1) => void;
}

/** A tile to drag, and to drop another on, to trade places. */
function DraggableTile(props: TileProps) {
  const id = props.tracker.id;
  const drag = useDraggable({ id });
  const drop = useDroppable({ id: `tile:${id}` });
  return (
    <Tile {...props} listeners={drag.listeners} placeholder={drag.isDragging} target={drop.isOver && !drag.isDragging}
      ref={node => { drag.setNodeRef(node); drop.setNodeRef(node); }} />
  );
}

/** A tracker as it sits on Today, as wide and the same shape, with a grip instead of its controls. */
function Tile({ tracker, running, startsRow, picked, lifted, placeholder, target, onPick, onMove, ref, listeners, style }: TileProps & {
  placeholder?: boolean;
  target?: boolean;
  ref?: Ref<HTMLButtonElement>;
  listeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
}) {
  const className = [
    'arrange-tile', tracker.type === 'moment' ? 'is-moment' : 'is-episode', isWide(tracker) && 'is-wide',
    startsRow && 'starts-row', running && 'is-running', picked && 'is-picked', lifted && 'is-lifted',
    placeholder && 'is-placeholder', target && 'is-target',
  ].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      style={{ ...colorStyle(tracker.color), ...style }}
      // The copy in hand is only something to see.
      data-arrange={lifted ? undefined : tracker.id}
      aria-hidden={lifted || undefined}
      tabIndex={lifted ? -1 : undefined}
      aria-pressed={!!picked}
      aria-label={`${tracker.name}, tap to move`}
      onClick={onPick}
      onKeyDown={event => {
        const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key] as -1 | 1 | undefined;
        if (!picked || !direction || !onMove) return;
        event.preventDefault();
        onMove(direction);
      }}
      {...listeners}
    >
      <span className="arrange-name">{tracker.name}</span>
      <GripIcon />
    </button>
  );
}

/** Six dots: something to take hold of. */
function GripIcon() {
  return (
    <svg className="arrange-grip" width="12" height="18" viewBox="0 0 12 18" aria-hidden="true">
      {[3, 9, 15].flatMap(y => [3, 9].map(x => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" fill="currentColor" />))}
    </svg>
  );
}
