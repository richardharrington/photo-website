import { describe, expect, it } from 'vitest';
import {
  allSelected,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectAll,
  selectedIds,
  toggle,
} from '../../src/admin/selection.ts';

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

  it('drops photos, and an anchor, that have left the list', () => {
    const state = extendTo(toggle(EMPTY_SELECTION, 'b'), ids, 'd');
    const pruned = pruneToVisible(state, ['c', 'd']);
    expect(selectedIds(pruned).sort()).toEqual(['c', 'd']);
    expect(pruned.anchorId).toBeNull();
  });
});
