import { describe, expect, it } from 'vitest';
import { recentGroups, timelineResponse } from '../../src/shared/display-api.ts';
import { indexTimeline, recentOrderedIds } from '../../src/shared/ui/timeline-index.ts';
import { extendTo, pruneToVisible } from '../../src/admin/selection.ts';
import { nextAfterDeleting } from '../../src/admin/advance.ts';
import { makeCatalog, makePhoto } from '../../fixtures/photos.ts';

/**
 * The order the admin's selection reasons about is the order on screen.
 *
 * `extendTo`, `nextAfterDeleting`, and `pruneToVisible` all take an ordered
 * list, so switching views is a substitution rather than a rewiring — but
 * getting it wrong fails *silently*: a shift-range measured in library order
 * would quietly pick up photographs scattered across years and look as though
 * it had worked. That is what this file exists to catch.
 */

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/**
 * Two upload sittings that interleave in the library.
 *
 * Today's holds a photograph taken this August and a print scanned from 1990.
 * Yesterday's holds one from 2020 and one from 1978. By capture date the four
 * alternate between the sittings, which is exactly the shape that makes a
 * range measured in the wrong order look plausible on screen and be wrong.
 */
const todayNew = makePhoto({
  id: 'e'.repeat(32),
  captureDate: '2026-08-15',
  captureTime: '10:00:00',
  batchSeq: 3,
  createdAt: new Date(NOW - HOUR).toISOString(),
});
const todayScan = makePhoto({
  id: 'd'.repeat(32),
  captureDate: '1990-01-01',
  captureTime: null,
  batchSeq: 3,
  createdAt: new Date(NOW - HOUR).toISOString(),
});
const yesterday2020 = makePhoto({
  id: 'c'.repeat(32),
  captureDate: '2020-05-05',
  captureTime: '12:00:00',
  batchSeq: 1,
  createdAt: new Date(NOW - 30 * HOUR).toISOString(),
});
const yesterday1978 = makePhoto({
  id: 'b'.repeat(32),
  captureDate: '1978-08-14',
  captureTime: null,
  batchSeq: 1,
  createdAt: new Date(NOW - 30 * HOUR).toISOString(),
});

const catalog = makeCatalog([todayNew, todayScan, yesterday2020, yesterday1978]);
const timeline = timelineResponse(catalog, 'Family Photos', NOW);

const libraryOrder = indexTimeline(timeline).orderedIds;
const recentOrder = recentOrderedIds(timeline);

describe('the two orders', () => {
  it('are genuinely different', () => {
    // The library: capture date alone, newest first, sittings ignored.
    expect(libraryOrder).toEqual([
      todayNew.id,
      yesterday2020.id,
      todayScan.id,
      yesterday1978.id,
    ]);

    // The recent view: today's sitting, then yesterday's, each in capture order.
    expect(recentOrder).toEqual([
      todayNew.id,
      todayScan.id,
      yesterday2020.id,
      yesterday1978.id,
    ]);
  });

  it('puts the sittings in the order the page renders them', () => {
    expect(recentGroups(catalog, NOW).map((group) => group.photoIds)).toEqual([
      [todayNew.id, todayScan.id],
      [yesterday2020.id, yesterday1978.id],
    ]);
  });
});

/**
 * Anchor on today's new photograph and shift-click the scan directly beneath
 * it on screen. In recent order those are two adjacent tiles; in library order
 * the same two clicks span a 2020 photograph the reader can see from neither.
 */
describe('a shift-range in the recent view', () => {
  const anchored = { ids: new Set([todayNew.id]), anchorId: todayNew.id };

  it('selects the run the reader can actually see', () => {
    const extended = extendTo(anchored, recentOrder, todayScan.id);
    expect([...extended.ids].sort()).toEqual([todayNew.id, todayScan.id].sort());
  });

  it('would have reached an unseen photograph in library order', () => {
    // The case worth asserting: the same two clicks, measured wrongly.
    const extended = extendTo(anchored, libraryOrder, todayScan.id);
    expect(extended.ids.has(yesterday2020.id)).toBe(true);
  });
});

describe('the rest of what the ordered list decides', () => {
  it('advances after a delete to the neighbour on screen', () => {
    // What follows the last of today's sitting is the first of yesterday's,
    // not the 1978 print the library puts there.
    expect(nextAfterDeleting(recentOrder, [todayScan.id], todayScan.id)).toBe(
      yesterday2020.id,
    );
    expect(nextAfterDeleting(libraryOrder, [todayScan.id], todayScan.id)).toBe(
      yesterday1978.id,
    );
  });

  it('prunes a selection to what the page is showing', () => {
    const gone = 'f'.repeat(32);
    const pruned = pruneToVisible(
      { ids: new Set([todayScan.id, gone]), anchorId: gone },
      recentOrder,
    );
    expect([...pruned.ids]).toEqual([todayScan.id]);
    expect(pruned.anchorId).toBeNull();
  });
});
