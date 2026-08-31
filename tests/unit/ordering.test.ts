import { describe, it, expect } from 'vitest';
import {
  buildHierarchy,
  comparePhotosWithinDay,
  compareUndatedPhotos,
  findDay,
  findMonth,
  findYear,
  siblingsWithinGroup,
} from '../../src/shared/ordering.ts';
import { makePhoto, testPhotoId } from '../support/photos.ts';

describe('comparePhotosWithinDay', () => {
  it('orders timed photos chronologically', () => {
    const morning = makePhoto({ id: testPhotoId('m'), captureTime: '08:15:00' });
    const evening = makePhoto({ id: testPhotoId('e'), captureTime: '19:40:00' });

    expect(comparePhotosWithinDay(morning, evening)).toBeLessThan(0);
    expect(comparePhotosWithinDay(evening, morning)).toBeGreaterThan(0);
  });

  it('separates same-second photos by their fractional part', () => {
    const first = makePhoto({ id: testPhotoId('1'), captureTime: '08:15:00.100' });
    const second = makePhoto({ id: testPhotoId('2'), captureTime: '08:15:00.900' });

    expect(comparePhotosWithinDay(first, second)).toBeLessThan(0);
  });

  it('places every date-only photo after every timed photo', () => {
    const timed = makePhoto({ id: testPhotoId('t'), captureTime: '23:59:59.999' });
    const dateOnly = makePhoto({ id: testPhotoId('d'), captureTime: null });

    expect(comparePhotosWithinDay(timed, dateOnly)).toBeLessThan(0);
  });

  it('orders date-only photos by batch, then by selection index', () => {
    const earlierBatch = makePhoto({
      id: testPhotoId('a'),
      captureTime: null,
      batchSeq: 4,
      selectionIndex: 9,
    });
    const laterBatch = makePhoto({
      id: testPhotoId('b'),
      captureTime: null,
      batchSeq: 5,
      selectionIndex: 0,
    });
    const sameBatchLater = makePhoto({
      id: testPhotoId('c'),
      captureTime: null,
      batchSeq: 4,
      selectionIndex: 10,
    });

    expect(comparePhotosWithinDay(earlierBatch, laterBatch)).toBeLessThan(0);
    expect(comparePhotosWithinDay(earlierBatch, sameBatchLater)).toBeLessThan(0);
  });

  it('is a total order, so the grid and prev/next cannot disagree', () => {
    const a = makePhoto({
      id: testPhotoId('aaa'),
      captureTime: null,
      batchSeq: 1,
      selectionIndex: 0,
    });
    const b = makePhoto({
      id: testPhotoId('bbb'),
      captureTime: null,
      batchSeq: 1,
      selectionIndex: 0,
    });

    expect(comparePhotosWithinDay(a, b)).toBeLessThan(0);
    expect(comparePhotosWithinDay(b, a)).toBeGreaterThan(0);
    expect(comparePhotosWithinDay(a, a)).toBe(0);
  });

  it('never uses ingestion time as a stand-in for capture time', () => {
    // `createdAt` deliberately contradicts the batch order; ordering must
    // follow the batch, not the clock.
    const first = makePhoto({
      id: testPhotoId('x'),
      captureTime: null,
      batchSeq: 1,
      selectionIndex: 0,
      createdAt: '2026-09-09T23:00:00.000Z',
    });
    const second = makePhoto({
      id: testPhotoId('y'),
      captureTime: null,
      batchSeq: 2,
      selectionIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(comparePhotosWithinDay(first, second)).toBeLessThan(0);
  });
});

describe('compareUndatedPhotos', () => {
  it('orders by batch then selection index', () => {
    const a = makePhoto({ id: testPhotoId('a'), batchSeq: 2, selectionIndex: 1 });
    const b = makePhoto({ id: testPhotoId('b'), batchSeq: 2, selectionIndex: 2 });
    const c = makePhoto({ id: testPhotoId('c'), batchSeq: 3, selectionIndex: 0 });

    expect([c, b, a].sort(compareUndatedPhotos).map((p) => p.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });
});

describe('buildHierarchy', () => {
  const photos = [
    makePhoto({
      id: testPhotoId('p1'),
      captureDate: '2026-08-02',
      captureTime: '17:48:50',
    }),
    makePhoto({
      id: testPhotoId('p2'),
      captureDate: '2026-08-02',
      captureTime: '08:15:00',
    }),
    makePhoto({
      id: testPhotoId('p3'),
      captureDate: '2026-08-15',
      captureTime: '12:00:00',
    }),
    makePhoto({
      id: testPhotoId('p4'),
      captureDate: '2026-03-01',
      captureTime: null,
      batchSeq: 2,
      selectionIndex: 0,
    }),
    makePhoto({
      id: testPhotoId('p5'),
      captureDate: '2025-12-25',
      captureTime: '09:00:00',
    }),
    makePhoto({
      id: testPhotoId('u1'),
      captureDate: null,
      captureTime: null,
      batchSeq: 3,
      selectionIndex: 1,
    }),
    makePhoto({
      id: testPhotoId('u2'),
      captureDate: null,
      captureTime: null,
      batchSeq: 3,
      selectionIndex: 0,
    }),
  ];

  const hierarchy = buildHierarchy(photos);

  it('lists years newest first', () => {
    expect(hierarchy.years.map((y) => y.year)).toEqual([2026, 2025]);
  });

  it('lists months and days newest first', () => {
    const year = findYear(hierarchy, 2026)!;
    expect(year.months.map((m) => m.month)).toEqual([8, 3]);

    const august = findMonth(hierarchy, 2026, 8)!;
    expect(august.days.map((d) => d.day)).toEqual([15, 2]);
  });

  it('rolls counts up through the hierarchy', () => {
    expect(findDay(hierarchy, 2026, 8, 2)!.count).toBe(2);
    expect(findMonth(hierarchy, 2026, 8)!.count).toBe(3);
    expect(findYear(hierarchy, 2026)!.count).toBe(4);
    expect(findYear(hierarchy, 2025)!.count).toBe(1);
  });

  it('orders photos within a day chronologically, oldest first', () => {
    const day = findDay(hierarchy, 2026, 8, 2)!;
    expect(day.photos.map((p) => p.captureTime)).toEqual(['08:15:00', '17:48:50']);
  });

  it('separates undated photos into their own group, in upload order', () => {
    expect(hierarchy.undated.count).toBe(2);
    expect(hierarchy.undated.photos.map((p) => p.selectionIndex)).toEqual([0, 1]);
  });

  it('does not repeat photos as representative thumbnails on group indexes', () => {
    // Group entries carry counts only; photos live exclusively in day grids.
    const year = findYear(hierarchy, 2026)!;
    expect(Object.keys(year)).toEqual(['year', 'count', 'months']);
    expect(Object.keys(year.months[0]!)).toEqual(['year', 'month', 'count', 'days']);
  });

  it('counts every photo exactly once', () => {
    const inDays = hierarchy.years
      .flatMap((y) => y.months)
      .flatMap((m) => m.days)
      .flatMap((d) => d.photos);

    expect(inDays.length + hierarchy.undated.count).toBe(photos.length);
    expect(hierarchy.total).toBe(photos.length);
  });

  it('returns null for groups that do not exist', () => {
    expect(findYear(hierarchy, 1999)).toBeNull();
    expect(findMonth(hierarchy, 2026, 1)).toBeNull();
    expect(findDay(hierarchy, 2026, 8, 3)).toBeNull();
  });

  it('handles an empty library', () => {
    const empty = buildHierarchy([]);
    expect(empty.years).toEqual([]);
    expect(empty.undated.count).toBe(0);
    expect(empty.total).toBe(0);
  });
});

describe('siblingsWithinGroup', () => {
  const group = [
    makePhoto({ id: testPhotoId('a') }),
    makePhoto({ id: testPhotoId('b') }),
    makePhoto({ id: testPhotoId('c') }),
  ];

  it('reports neighbours and position', () => {
    const middle = siblingsWithinGroup(group, group[1]!.id)!;
    expect(middle.previous?.id).toBe(group[0]!.id);
    expect(middle.next?.id).toBe(group[2]!.id);
    expect(middle.index).toBe(1);
    expect(middle.total).toBe(3);
  });

  it('does not wrap at the ends', () => {
    expect(siblingsWithinGroup(group, group[0]!.id)!.previous).toBeNull();
    expect(siblingsWithinGroup(group, group[2]!.id)!.next).toBeNull();
  });

  it('returns null for a photo outside the group', () => {
    expect(siblingsWithinGroup(group, testPhotoId('zz'))).toBeNull();
  });

  it('handles a single-photo group', () => {
    const one = siblingsWithinGroup([group[0]!], group[0]!.id)!;
    expect(one.previous).toBeNull();
    expect(one.next).toBeNull();
    expect(one.total).toBe(1);
  });
});
