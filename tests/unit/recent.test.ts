import { describe, expect, it } from 'vitest';
import { recentGroups, timelineResponse } from '../../src/shared/display-api.ts';
import {
  RECENT_FLOOR,
  RECENT_GAP_HOURS,
  RECENT_WINDOW_DAYS,
} from '../../src/shared/constants.ts';
import { makeCatalog, makePhoto } from '../../fixtures/photos.ts';
import type { PhotoRecord } from '../../src/shared/catalog.ts';

/**
 * The Recently Uploaded projection: which photographs count as new, where one
 * upload sitting ends, and what order they read in.
 *
 * These build their own records rather than reading `fixtures/catalog.ts`:
 * every photo in that fixture shares one `createdAt`, which is exactly the
 * dimension under test here.
 */

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let sequence = 0;

/** A photo that arrived `agoMs` before `NOW`. */
function arrived(agoMs: number, overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  sequence += 1;
  const id = String(sequence).padStart(32, 'f');
  return makePhoto({
    id,
    createdAt: new Date(NOW - agoMs).toISOString(),
    batchSeq: sequence,
    ...overrides,
  });
}

function idsIn(photos: readonly PhotoRecord[], nowMs = NOW): Set<string> {
  return new Set(
    recentGroups(makeCatalog(photos), nowMs).flatMap((group) => group.photoIds),
  );
}

describe('the recent set', () => {
  it('takes the newest fifty when nothing is inside the window', () => {
    // Every one of them a batch of its own, so closure adds nothing.
    const photos = Array.from({ length: 60 }, (_, index) =>
      arrived((90 + index) * DAY),
    );
    const included = idsIn(photos);

    expect(included.size).toBe(RECENT_FLOOR);
    // The floor is the *newest* fifty, so the ten oldest are out.
    for (const photo of photos.slice(0, RECENT_FLOOR)) {
      expect(included.has(photo.id), photo.createdAt).toBe(true);
    }
    for (const photo of photos.slice(RECENT_FLOOR)) {
      expect(included.has(photo.id), photo.createdAt).toBe(false);
    }
  });

  it('takes everything inside the window even when that is fewer than fifty', () => {
    const photos = Array.from({ length: 5 }, (_, index) => arrived(index * HOUR));
    expect(idsIn(photos).size).toBe(5);
  });

  it('takes everything inside the window when that exceeds the floor', () => {
    // Eighty photographs in one heavy fortnight, each its own batch: the
    // window has no ceiling, so all of them are in.
    const photos = Array.from({ length: 80 }, (_, index) => arrived(index * 4 * HOUR));
    expect(idsIn(photos).size).toBe(80);
  });

  it('includes the exact fourteen-day boundary and excludes what falls outside it', () => {
    const inside = arrived(RECENT_WINDOW_DAYS * DAY - 1, { batchSeq: 1 });
    const outside = arrived(RECENT_WINDOW_DAYS * DAY, { batchSeq: 2 });
    // Enough newer photographs to use the floor up, so only the window can
    // let either of these in.
    const filler = Array.from({ length: RECENT_FLOOR }, (_, index) =>
      arrived(index * 60_000, { batchSeq: 100 + index }),
    );

    const included = idsIn([inside, outside, ...filler]);
    expect(included.has(inside.id)).toBe(true);
    expect(included.has(outside.id)).toBe(false);
  });

  it('pulls in a batch member older than both the floor and the window', () => {
    // One old photograph committed in the same batch as a new one: an upload
    // is never shown cut in half, however far apart the two ends are. The
    // fillers use the floor up, so nothing but closure can reach back this far.
    const fillers = Array.from({ length: RECENT_FLOOR - 1 }, (_, index) =>
      arrived(30 * DAY + index * 60_000, { batchSeq: 100 + index }),
    );
    const recent = arrived(30 * DAY + RECENT_FLOOR * 60_000, { batchSeq: 42 });
    const straggler = arrived(400 * DAY, { batchSeq: 42 });
    const unrelated = arrived(400 * DAY, { batchSeq: 43 });

    const included = idsIn([...fillers, recent, straggler, unrelated]);
    expect(included.has(recent.id)).toBe(true);
    expect(included.has(straggler.id)).toBe(true);
    expect(included.has(unrelated.id)).toBe(false);
  });

  it('leaves a trashed member of an included batch out', () => {
    const live = arrived(2 * HOUR, { batchSeq: 7 });
    const trashed = arrived(2 * HOUR, {
      batchSeq: 7,
      trashedAt: '2026-09-03T00:00:00.000Z',
    });

    const included = idsIn([live, trashed]);
    expect(included.has(live.id)).toBe(true);
    expect(included.has(trashed.id)).toBe(false);
  });

  it('orders arrivals reproducibly when two share a createdAt', () => {
    // A tie is near-impossible in production, but the order must not fall
    // through to whatever `Object.values` happens to return.
    const createdAt = new Date(NOW - HOUR).toISOString();
    const a = makePhoto({ id: 'a'.repeat(32), createdAt, batchSeq: 1 });
    const b = makePhoto({ id: 'b'.repeat(32), createdAt, batchSeq: 2 });

    const forwards = recentGroups(makeCatalog([a, b]), NOW);
    const backwards = recentGroups(makeCatalog([b, a]), NOW);
    expect(forwards).toEqual(backwards);
    expect(forwards[0]!.count).toBe(2);
  });
});

describe('grouping into upload sittings', () => {
  function uploadedAtOf(photos: readonly PhotoRecord[]): string[] {
    return recentGroups(makeCatalog(photos), NOW).map((group) => group.uploadedAt);
  }

  it('keeps a gap of exactly the threshold in one sitting', () => {
    const newer = arrived(0);
    const older = arrived(RECENT_GAP_HOURS * HOUR);
    expect(uploadedAtOf([newer, older])).toEqual([newer.createdAt]);
  });

  it('opens a new sitting one millisecond past the threshold', () => {
    const newer = arrived(0);
    const older = arrived(RECENT_GAP_HOURS * HOUR + 1);
    expect(uploadedAtOf([newer, older])).toEqual([newer.createdAt, older.createdAt]);
  });

  it('keeps a sitting split across a page reload together', () => {
    // Two batches — the tab was reloaded midway — twenty minutes apart. The
    // family never sees a batch boundary, so neither does the page.
    const first = arrived(40 * 60_000, { batchSeq: 1 });
    const second = arrived(20 * 60_000, { batchSeq: 2 });
    expect(uploadedAtOf([first, second])).toEqual([second.createdAt]);
  });

  it('separates two sittings a day apart', () => {
    const today = arrived(HOUR);
    const yesterday = arrived(25 * HOUR);
    expect(uploadedAtOf([today, yesterday])).toEqual([
      today.createdAt,
      yesterday.createdAt,
    ]);
  });

  it('names a sitting by its newest arrival', () => {
    const photos = [arrived(3 * HOUR), arrived(HOUR), arrived(2 * HOUR)];
    const [group] = recentGroups(makeCatalog(photos), NOW);
    expect(group!.uploadedAt).toBe(photos[1]!.createdAt);
  });
});

describe('a group, as the response describes it', () => {
  it('reports the capture span, the undated count, and the total', () => {
    const photos = [
      arrived(HOUR, { batchSeq: 1, captureDate: '1978-08-14', captureTime: null }),
      arrived(HOUR, { batchSeq: 1, captureDate: '1977-03-02', captureTime: null }),
      arrived(HOUR, { batchSeq: 1, captureDate: null, captureTime: null }),
    ];

    const [group] = recentGroups(makeCatalog(photos), NOW);
    expect(group!.count).toBe(3);
    expect(group!.undatedCount).toBe(1);
    expect(group!.captureRange).toEqual({
      earliest: '1977-03-02',
      latest: '1978-08-14',
    });
  });

  it('reports a null capture range when everything in it is undated', () => {
    const photos = [
      arrived(HOUR, { batchSeq: 1, captureDate: null, captureTime: null }),
      arrived(HOUR, { batchSeq: 1, captureDate: null, captureTime: null }),
    ];
    const [group] = recentGroups(makeCatalog(photos), NOW);
    expect(group!.captureRange).toBeNull();
    expect(group!.undatedCount).toBe(2);
  });

  it('orders a group by capture: newest date first, timed before date-only, undated last', () => {
    const undated = arrived(HOUR, {
      batchSeq: 1,
      captureDate: null,
      captureTime: null,
      selectionIndex: 0,
    });
    const dateOnly = arrived(HOUR, {
      batchSeq: 1,
      captureDate: '2026-08-02',
      captureTime: null,
      selectionIndex: 1,
    });
    const morning = arrived(HOUR, {
      batchSeq: 1,
      captureDate: '2026-08-02',
      captureTime: '08:15:02',
      selectionIndex: 2,
    });
    const newerDay = arrived(HOUR, {
      batchSeq: 1,
      captureDate: '2026-08-15',
      captureTime: '10:05:00',
      selectionIndex: 3,
    });

    const [group] = recentGroups(
      makeCatalog([undated, dateOnly, morning, newerDay]),
      NOW,
    );
    expect(group!.photoIds).toEqual([newerDay.id, morning.id, dateOnly.id, undated.id]);
  });
});

describe('the recent field of the timeline response', () => {
  /**
   * Both projections derive from `livePhotos`, so an id in one is an id in the
   * other. A group naming a photograph the page does not hold would render a
   * gap in the grid with nothing to explain it.
   */
  it('names only photographs the same response carries', () => {
    const photos = [
      arrived(HOUR, { batchSeq: 1, captureDate: '2026-08-02' }),
      arrived(30 * HOUR, { batchSeq: 2, captureDate: null, captureTime: null }),
      arrived(200 * DAY, { batchSeq: 3, captureDate: '2019-01-01' }),
    ];

    const timeline = timelineResponse(makeCatalog(photos), 'Family Photos', NOW);
    const inLibrary = new Set([
      ...timeline.years.flatMap((year) =>
        year.months.flatMap((month) =>
          month.days.flatMap((day) => day.photos.map((photo) => photo.id)),
        ),
      ),
      ...timeline.undated.photos.map((photo) => photo.id),
    ]);

    const inRecent = timeline.recent.flatMap((group) => group.photoIds);
    expect(inRecent.length).toBeGreaterThan(0);
    for (const id of inRecent) expect(inLibrary.has(id)).toBe(true);
  });

  it('is empty only when the library is', () => {
    expect(timelineResponse(makeCatalog([]), 'Family Photos', NOW).recent).toEqual([]);
  });
});
