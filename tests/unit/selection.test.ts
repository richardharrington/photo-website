import { describe, expect, it } from 'vitest';
import {
  addAll,
  allSelected,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectAll,
  selectedIds,
  selectOnly,
  toggle,
} from '../../src/admin/selection.ts';
import type { SelectionState } from '../../src/admin/selection.ts';

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('selection', () => {
  it('toggles one photo at a time and anchors on it', () => {
    const one = toggle(EMPTY_SELECTION, 'b');
    expect(selectedIds(one)).toEqual(['b']);
    expect(one.anchorId).toBe('b');

    const both = toggle(one, 'd');
    expect(selectedIds(both).sort()).toEqual(['b', 'd']);

    const back = toggle(both, 'b');
    expect(selectedIds(back)).toEqual(['d']);
    // Deselecting still anchors: a shift-click after it measures from there.
    expect(back.anchorId).toBe('b');
  });

  it('narrows the selection to one photo on a plain click, and anchors on it', () => {
    const some = addAll(EMPTY_SELECTION, ['a', 'b', 'e']);
    const one = selectOnly(some, 'c');
    expect(selectedIds(one)).toEqual(['c']);
    expect(one.anchorId).toBe('c');
  });

  /*
   * Decision 2 of the click spec, and the load-bearing one: a double-click
   * fires click, click, dblclick, so the second click lands on a photo the
   * first one selected. Because that is a no-op, opening on a double-click
   * needs no timer and no snapshot of the selection to put back.
   */
  it('leaves an already-selected photo alone, and still moves the anchor', () => {
    const three = addAll(EMPTY_SELECTION, ['a', 'c', 'e']);
    const clicked = selectOnly(three, 'c');
    expect(selectedIds(clicked).sort()).toEqual(['a', 'c', 'e']);
    expect(clicked.anchorId).toBe('c');
  });

  it('is the same applied twice as applied once — the double-click sequence', () => {
    const some = addAll(EMPTY_SELECTION, ['a', 'b', 'e']);
    const once = selectOnly(some, 'd');
    const twice = selectOnly(once, 'd');
    expect(selectedIds(twice)).toEqual(selectedIds(once));
    expect(twice.anchorId).toBe(once.anchorId);
    expect(selectedIds(twice)).toEqual(['d']);
  });

  it('moves the anchor a following shift-click measures from', () => {
    // A and b selected with the anchor on a; a plain click on d then a
    // shift-click on f is d–f. Without the anchor moving, the commonest gesture
    // of all reaches back to the wrong tile (decisions.md #35).
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const held: SelectionState = { ids: new Set(['a', 'b']), anchorId: 'a' };
    const range = extendTo(selectOnly(held, 'd'), six, 'f');
    expect(selectedIds(range).sort()).toEqual(['d', 'e', 'f']);
    expect(range.anchorId).toBe('d');
  });

  /*
   * Where the two rules meet. A plain click inside a selection keeps it
   * (decision 2), and a shift-click adds rather than replaces (#35), so
   * clicking within a whole selected range and shift-clicking its end changes
   * nothing but the anchor. Asserted rather than left to be discovered: it is
   * the one case where "the anchor moves" does not visibly narrow anything.
   */
  it('keeps a range whole when the plain click lands inside it', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const all: SelectionState = { ids: new Set(six), anchorId: 'a' };
    const after = extendTo(selectOnly(all, 'd'), six, 'f');
    expect(selectedIds(after).sort()).toEqual(six);
    expect(after.anchorId).toBe('d');
  });

  it('extends from the anchor in either direction', () => {
    const anchored = toggle(EMPTY_SELECTION, 'd');
    expect(selectedIds(extendTo(anchored, ids, 'b')).sort()).toEqual(['b', 'c', 'd']);
    expect(selectedIds(extendTo(anchored, ids, 'e')).sort()).toEqual(['d', 'e']);
  });

  it('keeps the anchor across successive extensions, and keeps what was already selected', () => {
    const state = extendTo(toggle(toggle(EMPTY_SELECTION, 'a'), 'c'), ids, 'e');
    // Anchored on c, so a survives from the hand-picked selection.
    expect(selectedIds(state).sort()).toEqual(['a', 'c', 'd', 'e']);
    expect(state.anchorId).toBe('c');

    // A second shift-click still measures from c, not from e.
    expect(selectedIds(extendTo(state, ids, 'b')).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('selects just the one photo when there is no anchor yet', () => {
    const state = extendTo(EMPTY_SELECTION, ids, 'c');
    expect(selectedIds(state)).toEqual(['c']);
    expect(state.anchorId).toBe('c');
  });

  it('ignores an extension to a photo that is not in the list', () => {
    const anchored = toggle(EMPTY_SELECTION, 'b');
    expect(extendTo(anchored, ids, 'zz')).toBe(anchored);
  });

  it('reports all-selected only for a non-empty list', () => {
    expect(allSelected(selectAll(ids), ids)).toBe(true);
    expect(allSelected(toggle(selectAll(ids), 'c'), ids)).toBe(false);
    expect(allSelected(EMPTY_SELECTION, [])).toBe(false);
  });

  it('adds a group to the selection without replacing it', () => {
    // A day heading's Select all. Selecting a second day must not drop the
    // first, which is the whole difference from selectAll.
    const held = toggle(EMPTY_SELECTION, 'a');
    const both = addAll(held, ['c', 'd']);
    expect(selectedIds(both).sort()).toEqual(['a', 'c', 'd']);

    // Idempotent, and it leaves the anchor where a click put it.
    expect(selectedIds(addAll(both, ['c'])).sort()).toEqual(['a', 'c', 'd']);
    expect(both.anchorId).toBe('a');

    // Unlike selectAll, which is the replacing version.
    expect(selectedIds(selectAll(['c', 'd'])).sort()).toEqual(['c', 'd']);
  });

  it('drops photos, and an anchor, that have left the list', () => {
    const state = extendTo(toggle(EMPTY_SELECTION, 'b'), ids, 'd');
    const pruned = pruneToVisible(state, ['c', 'd']);
    expect(selectedIds(pruned).sort()).toEqual(['c', 'd']);
    expect(pruned.anchorId).toBeNull();
  });
});
