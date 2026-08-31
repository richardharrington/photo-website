/**
 * Grid selection.
 *
 * Laptop-oriented by design: a normal click opens the detail panel, dragging
 * on empty grid area draws a marquee, and modifier-click adds or removes one
 * photo. Touch-specific bulk selection is explicitly out of scope for the
 * first release.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function rectFromPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Rect {
  return {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Any overlap counts, so a marquee grazing a thumbnail selects it. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/**
 * A drag shorter than this is a click that wobbled, not a marquee. Without it,
 * every click would clear the selection through a zero-area marquee.
 */
export const MARQUEE_THRESHOLD_PX = 4;

export function isMarquee(rect: Rect): boolean {
  return rect.width >= MARQUEE_THRESHOLD_PX || rect.height >= MARQUEE_THRESHOLD_PX;
}

export interface SelectionState {
  ids: ReadonlySet<string>;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set() };

export function toggle(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids };
}

export function replace(ids: Iterable<string>): SelectionState {
  return { ids: new Set(ids) };
}

/** Marquee result. Additive when a modifier is held, replacing otherwise. */
export function applyMarquee(
  state: SelectionState,
  hitIds: Iterable<string>,
  additive: boolean,
): SelectionState {
  if (!additive) return replace(hitIds);
  const ids = new Set(state.ids);
  for (const id of hitIds) ids.add(id);
  return { ids };
}

/**
 * Selection is by ID, and IDs that have left the grid are dropped.
 *
 * Called after a trash or restore so the selection cannot keep referring to
 * photos that are no longer shown — which would let a later bulk action cover
 * something the administrator can no longer see.
 */
export function pruneToVisible(
  state: SelectionState,
  visibleIds: Iterable<string>,
): SelectionState {
  const visible = new Set(visibleIds);
  const ids = new Set([...state.ids].filter((id) => visible.has(id)));
  return { ids };
}

export function selectedCount(state: SelectionState): number {
  return state.ids.size;
}

export function selectedIds(state: SelectionState): string[] {
  return [...state.ids];
}
