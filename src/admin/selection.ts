/**
 * Trash selection.
 *
 * Only the trash view selects: a click toggles a tile, and the toolbar acts
 * on whatever is toggled, because that is the only route to Restore and
 * Delete permanently.
 *
 * The photo grid deliberately has no selection. It once had marquee dragging
 * and modifier-click, which never worked — a plain click opened the detail
 * panel instead of selecting, so nothing could ever be selected and "Delete
 * selected" was permanently disabled. Bulk deletion is "Delete this whole
 * group"; single deletion is the detail panel's own Delete.
 */

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

/**
 * Selection is by ID, and IDs that have left the list are dropped.
 *
 * Called after a restore or a permanent delete so the selection cannot keep
 * referring to photos that are no longer shown — which would let a later bulk
 * action cover something the administrator can no longer see.
 */
export function pruneToVisible(
  state: SelectionState,
  visibleIds: Iterable<string>,
): SelectionState {
  const visible = new Set(visibleIds);
  const ids = new Set([...state.ids].filter((id) => visible.has(id)));
  return { ids };
}

export function selectedIds(state: SelectionState): string[] {
  return [...state.ids];
}
