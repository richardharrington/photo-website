import { describe, expect, it } from 'vitest';
import { timelineResponse } from '../../src/shared/display-api.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * The timeline projection: the whole library in one response.
 *
 * It is built from the same hierarchy the old index pages used, and these
 * tests exist to pin that it stays that way — every ordering and visibility
 * rule the viewer depends on now arrives in a single payload, so a regression
 * here is a regression in the entire page rather than in one route.
 */

const catalog = fixtureCatalog();
const timeline = timelineResponse(catalog, 'Family Photos');

/** Every photo, in the order the page renders them. */
function flatten() {
  return [
    ...timeline.years.flatMap((year) =>
      year.months.flatMap((month) => month.days.flatMap((day) => day.photos)),
    ),
    ...timeline.undated.photos,
  ];
}

describe('timelineResponse', () => {
  it('carries the site title', () => {
    expect(timeline.title).toBe('Family Photos');
  });

  it('orders years, months, and days newest first', () => {
    expect(timeline.years.map((year) => year.year)).toEqual([2026, 2025]);

    const y2026 = timeline.years[0]!;
    expect(y2026.months.map((month) => month.month)).toEqual([8, 3]);
    expect(y2026.months[0]!.days.map((day) => day.day)).toEqual([15, 2]);
  });

  it('orders a day by capture time, then by upload order', () => {
    const august2 = timeline.years[0]!.months[0]!.days[1]!;
    expect(august2.day).toBe(2);
    expect(august2.photos.map((photo) => photo.captureTime)).toEqual([
      '08:15:02',
      '12:30:11.100',
      '12:30:11.850',
      '17:48:50.943',
      // Date-only photos come after every timed one, in upload order.
      null,
      null,
    ]);
    expect(august2.photos[4]!.originalFilename).toBe('scan-0042.png');
    expect(august2.photos[5]!.originalFilename).toBe('scan-0043.png');
  });

  it('puts the undated group last, in upload order', () => {
    expect(timeline.undated.photos.map((photo) => photo.originalFilename)).toEqual([
      'DSC_0041.JPG',
      'DSC_0042.JPG',
    ]);
    expect(flatten().at(-1)!.originalFilename).toBe('DSC_0042.JPG');
  });

  it('excludes trashed photos everywhere', () => {
    const ids = flatten().map((photo) => photo.id);
    expect(ids).not.toContain(FIXTURE_PHOTO_IDS['deleted']);
    // The trashed photo would otherwise sit at the end of August 2nd.
    expect(timeline.years[0]!.months[0]!.days[1]!.count).toBe(6);
  });

  it('counts agree at every level and with the photos actually present', () => {
    const photos = flatten();
    expect(timeline.total).toBe(photos.length);
    expect(timeline.undated.count).toBe(timeline.undated.photos.length);

    for (const year of timeline.years) {
      let yearTotal = 0;
      for (const month of year.months) {
        const monthTotal = month.days.reduce((sum, day) => sum + day.count, 0);
        expect(month.count).toBe(monthTotal);
        for (const day of month.days) {
          expect(day.count).toBe(day.photos.length);
        }
        yearTotal += monthTotal;
      }
      expect(year.count).toBe(yearTotal);
    }
  });

  it('publishes only the public photo fields', () => {
    for (const photo of flatten()) {
      // `contentHash` would let someone confirm whether a file they already
      // hold is in the library; ordering keys are already applied server-side.
      expect(Object.keys(photo).sort()).toEqual([
        'caption',
        'captureDate',
        'captureTime',
        'captureUtcOffset',
        'derivatives',
        'id',
        'originalFilename',
      ]);
    }
  });

  it('handles a library with nothing in it', () => {
    const empty = timelineResponse({ ...catalog, photos: {} }, 'Family Photos');
    expect(empty.years).toEqual([]);
    expect(empty.undated).toEqual({ count: 0, photos: [] });
    expect(empty.total).toBe(0);
  });
});
