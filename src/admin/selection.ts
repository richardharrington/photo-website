/**
 * Which photos a bulk action refers to, in the photo grid and in the trash.
 *
 * Deletion is the only action that works on many photos at once. Date, time,
 * and caption stay per-photo (design.md), so the selection never has to
 * survive a form or describe anything but a set of IDs.
 *
 * Selecting in the grid is what a plain click does: click selects, double-click
 * opens, and the two modifiers below reach the same ranges every file manager
 * teaches. Marquee dragging is deliberately absent — it was tried, it never
 * worked, and it is not needed to reach any action.
 *
 * One selection covers the whole library, not one day: a shift-range runs
 * across day, month, and year boundaries in timeline order, and the selection
 * is not keyed to a route, so the headings' `replaceState` navigation leaves
 * it alone.
 */

export interface SelectionState {
  ids: ReadonlySet<string>;
  /**
   * Where a shift-click measures from: the tile clicked last with the toggle
   * modifier. A shift-click leaves it alone, so several shift-clicks in a row
   * all reach back to the same tile rather than walking the anchor forward.
   */
  anchorId: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchorId: null };

export function toggle(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchorId: id };
}

/**
 * Select everything between the anchor and `id`, inclusive.
 *
 * The range is added to what is already selected rather than replacing it, so
 * a shift-click can never take away a photo the administrator picked out by
 * hand. Shrinking a range therefore means deselecting the surplus, which is
 * the price of that.
 *
 * With no anchor yet — the first click in the grid was a shift-click — there
 * is no range to speak of, so it selects the one photo and becomes the anchor.
 */
export function extendTo(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
): SelectionState {
  const anchor = state.anchorId === null ? -1 : orderedIds.indexOf(state.anchorId);
  const target = orderedIds.indexOf(id);
  if (target === -1) return state;
  if (anchor === -1) return { ids: new Set([...state.ids, id]), anchorId: id };

  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
  const ids = new Set(state.ids);
  for (const between of orderedIds.slice(from, to + 1)) ids.add(between);
  return { ids, anchorId: state.anchorId };
}

/**
 * A plain click: the selection becomes this photograph alone — unless it is
 * already selected, in which case the selection is left exactly as it is.
 *
 * That idempotency is load-bearing, not tidiness. A double-click fires click,
 * click, dblclick; the second click lands on a photo the first one selected,
 * so it does nothing, and opening on a double-click therefore needs no timer
 * and no snapshot of the selection to restore. Do not "simplify" it into a
 * toggle, which would deselect the photo on every double-click.
 *
 * The anchor moves either way. The click still says "you are here", which is
 * what a following shift-click measures from (decisions.md #35).
 */
export function selectOnly(state: SelectionState, id: string): SelectionState {
  if (state.ids.has(id)) return { ids: state.ids, anchorId: id };
  return { ids: new Set([id]), anchorId: id };
}

export function selectAll(orderedIds: readonly string[]): SelectionState {
  return { ids: new Set(orderedIds), anchorId: null };
}

/**
 * Add these photos to the selection, keeping everything already in it.
 *
 * This is a day heading's Select all, and adding rather than replacing is what
 * makes "this day and that one" two clicks. It sets no anchor: a range is
 * measured from a tile someone actually clicked, and a whole day has no one
 * tile to measure from.
 */
export function addAll(state: SelectionState, ids: readonly string[]): SelectionState {
  return { ids: new Set([...state.ids, ...ids]), anchorId: state.anchorId };
}

export function allSelected(
  state: SelectionState,
  orderedIds: readonly string[],
): boolean {
  return orderedIds.length > 0 && orderedIds.every((id) => state.ids.has(id));
}

/**
 * Selection is by ID, and IDs that have left the list are dropped.
 *
 * Called after a restore or a delete so the selection cannot keep referring to
 * photos that are no longer shown — which would let a later bulk action cover
 * something the administrator can no longer see.
 */
export function pruneToVisible(
  state: SelectionState,
  visibleIds: Iterable<string>,
): SelectionState {
  const visible = new Set(visibleIds);
  const ids = new Set([...state.ids].filter((id) => visible.has(id)));
  const anchorId =
    state.anchorId !== null && visible.has(state.anchorId) ? state.anchorId : null;
  return { ids, anchorId };
}

export function selectedIds(state: SelectionState): string[] {
  return [...state.ids];
}
