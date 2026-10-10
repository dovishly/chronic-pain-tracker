import { useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DraggableSyntheticListeners, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { activeTrackers, groupTrackers, type Data, type Tracker } from '../../lib/model';
import { arrangeToday, type Layout } from '../../lib/actions';
import { colorStyle } from '../../components/color';

/** Today's headings and trackers, in the order they show. */
export const todayLayout = (data: Data): Layout =>
  groupTrackers(activeTrackers(data, 'episode', 'moment')).map(([group, trackers]) => [group, trackers.map(t => t.id)]);

const copy = (layout: Layout): Layout => layout.map(([group, ids]) => [group, [...ids]]);

/** A tracker one place earlier (-1) or later (1). Past either end of its heading, it goes into the next heading. */
export function moveTrackerIn(layout: Layout, id: string, direction: -1 | 1): Layout {
  const next = copy(layout);
  const from = next.findIndex(([, ids]) => ids.includes(id));
  const ids = next[from][1];
  const i = ids.indexOf(id);
  const j = i + direction;
  if (j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return next;
  }
  const neighbor = next[from + direction];
  if (!neighbor) return layout;
  ids.splice(i, 1);
  if (direction < 0) neighbor[1].push(id);
  else neighbor[1].unshift(id);
  return next.filter(([, ids]) => ids.length);
}

/** A heading, with its trackers, one place up (-1) or down (1). */
function moveHeadingIn(layout: Layout, index: number, direction: -1 | 1): Layout {
  const next = copy(layout);
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  return next;
}

const SECTION = 'section:';

/** The tile under the pointer, or failing that its heading's area (for one that's been emptied), or the nearest. */
const collisions: CollisionDetection = args => {
  const found = pointerWithin(args);
  if (!found.length) return closestCenter(args);
  const tile = found.find(c => !String(c.id).startsWith(SECTION));
  return tile ? [tile] : found;
};

interface Props {
  data: Data;
  running: Set<string>;
  onDone: () => void;
}

/**
 * Today with its trackers held still to be moved: drag a tile, including into another heading, or tap one and
 * use the arrows (or the arrow keys). Headings move with their own arrows. Each move is saved as it's made.
 */
export function ArrangeToday({ data, running, onDone }: Props) {
  const saved = todayLayout(data);
  // While dragging: the layout as it's being dragged into. Saved, and dropped, when the tile is let go.
  const [draft, setDraftState] = useState<Layout | null>(null);
  const draftRef = useRef<Layout | null>(null);
  const setDraft = (next: Layout | null) => { draftRef.current = next; setDraftState(next); };
  const [dragging, setDragging] = useState<string | null>(null);
  const [pickedId, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const layout = draft ?? saved;
  const tracker = (id: string) => data.trackers.get(id)!;

  // A quick touch still scrolls the page: a tile lifts after a short press, or with the mouse once it moves.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const groupIndex = (id: UniqueIdentifier, from: Layout) =>
    String(id).startsWith(SECTION)
      ? from.findIndex(([group]) => SECTION + group === id)
      : from.findIndex(([, ids]) => ids.includes(String(id)));

  const where = (id: string, in_: Layout) => {
    const [group, ids] = in_[groupIndex(id, in_)];
    return `${tracker(id).name}, ${ids.indexOf(id) + 1} of ${ids.length} in ${group}`;
  };

  const save = (next: Layout, id?: string) => {
    void arrangeToday(next);
    setDraft(null);
    if (id) setStatus(where(id, next));
  };

  const move = (id: string, direction: -1 | 1) => {
    const hadFocus = (document.activeElement as HTMLElement | null)?.dataset.arrange === id;
    save(moveTrackerIn(layout, id, direction), id);
    // A tile moved under another heading is drawn afresh there, so give it back the focus it had.
    if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-arrange="${id}"]`)?.focus());
  };

  const flat = layout.flatMap(([, ids]) => ids);
  const canMove = (id: string | null, direction: -1 | 1) => {
    if (!id || !flat.includes(id)) return false;
    const i = flat.indexOf(id) + direction;
    return i >= 0 && i < flat.length;
  };

  // Let go of a tracker that's no longer on Today (archived, say, on another device).
  const picked = pickedId && flat.includes(pickedId) ? pickedId : null;

  const pick = (id: string) => {
    const next = picked === id ? null : id;
    setPicked(next);
    setStatus(next ? `${tracker(id).name} picked. Move it with the arrows.` : '');
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      onDragStart={({ active }) => {
        setDragging(String(active.id));
        setDraft(saved);
      }}
      onDragOver={({ active, over }) => {
        // Into another heading as soon as it's over it. Within one, the tiles make room as it passes (see onDragEnd).
        const current = draftRef.current ?? saved;
        if (!over) return;
        const from = groupIndex(active.id, current);
        const to = groupIndex(over.id, current);
        if (from < 0 || to < 0 || from === to) return;
        const next: Layout = current.map(([group, ids]) => [group, ids.filter(id => id !== active.id)]);
        const target = next[to][1];
        const at = target.indexOf(String(over.id));
        target.splice(at < 0 ? target.length : at, 0, String(active.id));
        setDraft(next);
      }}
      onDragEnd={({ active, over }) => {
        setDragging(null);
        let next = draftRef.current ?? saved;
        const g = over ? groupIndex(over.id, next) : -1;
        if (over && g >= 0) {
          const ids = next[g][1];
          const from = ids.indexOf(String(active.id));
          const to = ids.indexOf(String(over.id));
          if (from >= 0 && to >= 0 && from !== to) next = next.map((entry, i) => (i === g ? [entry[0], arrayMove(ids, from, to)] : entry));
        }
        save(next.filter(([, ids]) => ids.length), String(active.id));
      }}
      onDragCancel={() => {
        setDragging(null);
        setDraft(null);
      }}
    >
      {/* First, so it's found first; drawn at the bottom of the screen, within reach of a thumb. */}
      <div className="arrange-bar" role="group" aria-label="Arrange Today">
        <p className="arrange-hint">
          {picked ? <b>{tracker(picked).name}</b> : 'Drag a tile, or tap one to move it with the arrows.'}
        </p>
        {picked && (
          <>
            <button type="button" className="arrange-arrow" id="arrange-earlier" aria-label={`Move ${tracker(picked).name} earlier`}
              disabled={!canMove(picked, -1)} onClick={() => move(picked, -1)}>←</button>
            <button type="button" className="arrange-arrow" id="arrange-later" aria-label={`Move ${tracker(picked).name} later`}
              disabled={!canMove(picked, 1)} onClick={() => move(picked, 1)}>→</button>
          </>
        )}
        <button type="button" className="button primary" id="arrange-done" onClick={onDone}>Done</button>
      </div>

      {layout.map(([group, ids], index) => (
        <section key={group}>
          <div className="row-between section-header">
            <h2>{group}</h2>
            <span className="heading-moves">
              <button type="button" aria-label={`Move ${group} up`} disabled={index === 0}
                onClick={() => save(moveHeadingIn(layout, index, -1))}>↑</button>
              <button type="button" aria-label={`Move ${group} down`} disabled={index === layout.length - 1}
                onClick={() => save(moveHeadingIn(layout, index, 1))}>↓</button>
            </span>
          </div>
          <ArrangeSection group={group} ids={ids}>
            {ids.map(id => (
              <SortableTile key={id} tracker={tracker(id)} running={running.has(id)} picked={picked === id}
                onPick={() => pick(id)}
                onMove={direction => canMove(id, direction) && move(id, direction)} />
            ))}
          </ArrangeSection>
        </section>
      ))}

      <DragOverlay>
        {dragging && <Tile tracker={tracker(dragging)} running={running.has(dragging)} lifted />}
      </DragOverlay>
      <p className="visually-hidden" aria-live="polite">{status}</p>
    </DndContext>
  );
}

/** A heading's tiles, which can also be dropped on as a whole once its last tile has been dragged out. */
function ArrangeSection({ group, ids, children }: { group: string; ids: string[]; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: SECTION + group });
  return (
    <SortableContext id={group} items={ids} strategy={rectSortingStrategy}>
      <div ref={setNodeRef} className="today-grid arrange-grid">{children}</div>
    </SortableContext>
  );
}

interface TileProps {
  tracker: Tracker;
  running: boolean;
  picked?: boolean;
  lifted?: boolean;
  onPick?: () => void;
  onMove?: (direction: -1 | 1) => void;
}

function SortableTile(props: TileProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.tracker.id });
  return (
    <Tile {...props} ref={setNodeRef} listeners={listeners} placeholder={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }} />
  );
}

/** A tracker as it sits on Today, as wide and the same shape, with a grip instead of its controls. */
function Tile({ tracker, running, picked, lifted, placeholder, onPick, onMove, ref, listeners, style }: TileProps & {
  placeholder?: boolean;
  ref?: Ref<HTMLButtonElement>;
  listeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
}) {
  const wide = tracker.type === 'episode' && (tracker.config.levels || []).some(Boolean);
  const className = [
    'arrange-tile', tracker.type === 'moment' ? 'is-moment' : 'is-episode', wide && 'is-wide', running && 'is-running',
    picked && 'is-picked', lifted && 'is-lifted', placeholder && 'is-placeholder',
  ].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      style={{ ...colorStyle(tracker.color), ...style }}
      data-arrange={tracker.id}
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
