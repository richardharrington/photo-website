import { describe, expect, it } from 'vitest';
import { removePhotos, upsertPhoto } from '../../src/shared/timeline-patch.ts';
import { timelineResponse } from '../../src/shared/display-api.ts';
import type { PublicPhoto, TimelineResponse } from '../../src/shared/display-api.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * The admin's in-memory patches to the library.
 *
 * They are a forecast of what the next `/timeline` will say, so what has to
 * hold is the same invariant the projection guarantees: every count agrees
 * with the photos actually present, and an empty group does not exist. A patch
 * that broke either would put the page into a state the server could never
 * produce — an empty day heading, or a count that does not match the tiles
 * beneath it — until the background refetch happened to land.
 */

const NOW_MS = Date.parse('2026-09-04T12:00:00.000Z');
const base = timelineResponse(fixtureCatalog(), 'Family Photos', NOW_MS);

/** Every photo, in the order the page renders them. */
function flatten(timeline: TimelineResponse): PublicPhoto[] {
  return [
    ...timeline.years.flatMap((year) =>
      year.months.flatMap((month) => month.days.flatMap((day) => day.photos)),
    ),
    ...timeline.undated.photos,
  ];
}

/** The same assertions display-api.test.ts makes about the projection. */
function expectCountsAgree(timeline: TimelineResponse): void {
  expect(timeline.total).toBe(flatten(timeline).length);
  expect(timeline.undated.count).toBe(timeline.undated.photos.length);

  for (const year of timeline.years) {
    let yearTotal = 0;
    for (const month of year.months) {
      expect(month.days.length).toBeGreaterThan(0);
      const monthTotal = month.days.reduce((sum, day) => sum + day.count, 0);
      expect(month.count).toBe(monthTotal);
      for (const day of month.days) {
        expect(day.count).toBe(day.photos.length);
        expect(day.photos.length).toBeGreaterThan(0);
      }
      yearTotal += monthTotal;
    }
    expect(year.months.length).toBeGreaterThan(0);
    expect(year.count).toBe(yearTotal);
  }
}

/** Days newest first, as the projection orders them. */
function daysOf(timeline: TimelineResponse, year: number, month: number): number[] {
  return (
    timeline.years
      .find((entry) => entry.year === year)
      ?.months.find((entry) => entry.month === month)
      ?.days.map((day) => day.day) ?? []
  );
}

function photosOn(
  timeline: TimelineResponse,
  year: number,
  month: number,
  day: number,
): PublicPhoto[] {
  return (
    timeline.years
      .find((entry) => entry.year === year)
      ?.months.find((entry) => entry.month === month)
      ?.days.find((entry) => entry.day === day)?.photos ?? []
  );
}

function photo(seed: string): PublicPhoto {
  const found = flatten(base).find((entry) => entry.id === FIXTURE_PHOTO_IDS[seed]);
  if (!found) throw new Error(`No such fixture photo: ${seed}`);
  return found;
}

describe('the fixture this works on', () => {
  it('is the library the projection produces', () => {
    expect(base.total).toBe(18);
    expectCountsAgree(base);
  });
});

describe('removePhotos', () => {
  it('recomputes every count above the photos it took', () => {
    const patched = removePhotos(base, [photo('beach-early').id]);

    expect(photosOn(patched, 2026, 8, 2)).toHaveLength(5);
    const august = patched.years[0]!.months[0]!;
    expect(august.count).toBe(6);
    expect(patched.years[0]!.count).toBe(13);
    expect(patched.total).toBe(17);
    expectCountsAgree(patched);
  });

  it('drops a day, and the month with it, when the last photo goes', () => {
    // March 1st holds one photograph, and March holds only that day.
    const patched = removePhotos(base, [photo('snowdrops').id]);

    expect(daysOf(patched, 2026, 3)).toEqual([]);
    expect(patched.years[0]!.months.map((month) => month.month)).toEqual([8, 7]);
    expectCountsAgree(patched);
  });

  it('drops a year when its last photo goes', () => {
    const patched = removePhotos(base, [
      photo('christmas').id,
      photo('early-start').id,
    ]);

    expect(patched.years.map((year) => year.year)).toEqual([2026]);
    expect(patched.total).toBe(16);
    expectCountsAgree(patched);
  });

  it('takes undated photos, and leaves the group behind', () => {
    // Unlike a day, the Undated group is a fixed part of the page and valid
    // when empty.
    const patched = removePhotos(base, [photo('undated-a').id, photo('undated-b').id]);

    expect(patched.undated).toEqual({ count: 0, photos: [] });
    expect(patched.total).toBe(16);
    expectCountsAgree(patched);
  });

  it('ignores an ID that is not in the timeline, and an empty list', () => {
    expect(removePhotos(base, [])).toBe(base);
    expect(removePhotos(base, ['f'.repeat(32)]).total).toBe(18);
  });
});

describe('upsertPhoto', () => {
  it('moves a photo to another day, in clock order there', () => {
    // The market photo is at 10:05; the snowdrops photo on March 1st is at
    // 14:22, so the corrected date puts it first.
    const moved = { ...photo('market'), captureDate: '2026-03-01' };
    const patched = upsertPhoto(base, moved);

    expect(photosOn(patched, 2026, 3, 1).map((entry) => entry.captureTime)).toEqual([
      '10:05:00',
      '14:22:19',
    ]);
    // And it is not left behind on August 15th, which is now gone.
    expect(daysOf(patched, 2026, 8)).toEqual([2]);
    expect(patched.total).toBe(18);
    expectCountsAgree(patched);
  });

  it('creates a day, a month, and a year in newest-first position', () => {
    const moved = {
      ...photo('market'),
      captureDate: '2024-06-09',
      captureTime: '11:00:00',
    };
    const patched = upsertPhoto(base, moved);

    expect(patched.years.map((year) => year.year)).toEqual([2026, 2025, 2024]);
    expect(photosOn(patched, 2024, 6, 9)).toHaveLength(1);
    expectCountsAgree(patched);
  });

  it('inserts a day in newest-first order within its month', () => {
    const moved = {
      ...photo('market'),
      captureDate: '2026-08-09',
      captureTime: '11:00:00',
    };
    const patched = upsertPhoto(base, moved);

    // August 15th emptied, and the 9th slots between what is left.
    expect(daysOf(patched, 2026, 8)).toEqual([9, 2]);
    expectCountsAgree(patched);
  });

  it('appends a date-only photo after the day it lands on', () => {
    // Ordering among date-only photos is by batch and selection index, which
    // a public photo does not carry; after the timed ones is the honest place.
    const moved = {
      ...photo('market'),
      captureDate: '2026-08-02',
      captureTime: null,
    };
    const patched = upsertPhoto(base, moved);

    const august2 = photosOn(patched, 2026, 8, 2);
    expect(august2).toHaveLength(7);
    expect(august2.at(-1)!.id).toBe(moved.id);
    expectCountsAgree(patched);
  });

  it('moves a dated photo into the undated group', () => {
    const cleared = { ...photo('market'), captureDate: null, captureTime: null };
    const patched = upsertPhoto(base, cleared);

    expect(patched.undated.count).toBe(3);
    expect(patched.undated.photos.at(-1)!.id).toBe(cleared.id);
    expect(daysOf(patched, 2026, 8)).toEqual([2]);
    expect(patched.total).toBe(18);
    expectCountsAgree(patched);
  });

  it('moves an undated photo onto a day', () => {
    const dated = {
      ...photo('undated-a'),
      captureDate: '2026-08-02',
      captureTime: '09:00:00',
    };
    const patched = upsertPhoto(base, dated);

    expect(patched.undated.count).toBe(1);
    expect(photosOn(patched, 2026, 8, 2).map((entry) => entry.id)[1]).toBe(dated.id);
    expect(patched.total).toBe(18);
    expectCountsAgree(patched);
  });

  it('adds a photo the timeline has never seen', () => {
    const added: PublicPhoto = {
      ...photo('market'),
      id: 'a'.repeat(32),
      captureDate: '2026-08-15',
      captureTime: '18:00:00',
    };
    const patched = upsertPhoto(base, added);

    expect(photosOn(patched, 2026, 8, 15)).toHaveLength(2);
    expect(patched.total).toBe(19);
    expectCountsAgree(patched);
  });

  it('leaves the original alone', () => {
    upsertPhoto(base, { ...photo('market'), captureDate: '2026-03-01' });
    expect(daysOf(base, 2026, 8)).toEqual([15, 2]);
    expect(base.total).toBe(18);
  });
});

/**
 * The Recently Uploaded groups, patched.
 *
 * The two mutations differ here on purpose. A delete has to take the photo out
 * of the sittings as well, or the page would hold an id it can no longer
 * render. An edit must leave them completely alone: a photograph does not stop
 * having arrived when its date is corrected, and `upsertPhoto` was built on
 * `removePhotos`, so without the split it would vanish from `/recent` until
 * the refetch landed.
 */
describe('the recent groups', () => {
  const marketId = FIXTURE_PHOTO_IDS['market']!;
  const undatedId = FIXTURE_PHOTO_IDS['undated-a']!;

  function groupHolding(timeline: TimelineResponse, id: string) {
    return timeline.recent.find((group) => group.photoIds.includes(id));
  }

  it('is carried in the projection at all', () => {
    expect(base.recent.length).toBeGreaterThan(0);
    expect(groupHolding(base, marketId)).toBeDefined();
  });

  it('drops deleted ids and recounts the group', () => {
    const before = groupHolding(base, marketId)!;
    const patched = removePhotos(base, [marketId]);
    const after = patched.recent.find(
      (group) => group.uploadedAt === before.uploadedAt,
    )!;

    expect(after.photoIds).not.toContain(marketId);
    expect(after.count).toBe(before.count - 1);
    expect(after.photoIds).toHaveLength(after.count);
  });

  it('lowers the undated count only for an undated photograph', () => {
    const before = groupHolding(base, undatedId)!;

    const datedGone = removePhotos(base, [marketId]).recent.find(
      (group) => group.uploadedAt === before.uploadedAt,
    )!;
    expect(datedGone.undatedCount).toBe(before.undatedCount);

    const undatedGone = removePhotos(base, [undatedId]).recent.find(
      (group) => group.uploadedAt === before.uploadedAt,
    )!;
    expect(undatedGone.undatedCount).toBe(before.undatedCount - 1);
  });

  it('drops a sitting that empties', () => {
    const everything = flatten(base).map((entry) => entry.id);
    expect(removePhotos(base, everything).recent).toEqual([]);
  });

  it('is left untouched by an edit', () => {
    const moved = upsertPhoto(base, {
      ...photo('market'),
      captureDate: '1999-01-01',
      captureTime: null,
    });

    expect(moved.recent).toEqual(base.recent);
    expect(groupHolding(moved, marketId)!.photoIds).toContain(marketId);
  });
});
