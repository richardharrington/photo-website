/**
 * Chronological grouping and ordering for the display hierarchy.
 *
 * Ingestion time is never used as a stand-in for capture time. Photos that
 * have no capture time fall back to `(batchSeq, selectionIndex)` — a
 * server-assigned global batch number and the file's position in the drop or
 * selection — which keeps their relative order stable across batches
 * (decisions.md #10).
 */

import { splitCaptureDate, timeSortKey } from './datetime.ts';
import type { CaptureDate } from './datetime.ts';
import type { PhotoRecord } from './catalog.ts';

export interface DayGroup {
  date: CaptureDate;
  year: number;
  month: number;
  day: number;
  count: number;
  photos: PhotoRecord[];
}

export interface MonthGroup {
  year: number;
  month: number;
  count: number;
  days: DayGroup[];
}

export interface YearGroup {
  year: number;
  count: number;
  months: MonthGroup[];
}

export interface Hierarchy {
  years: YearGroup[];
  undated: { count: number; photos: PhotoRecord[] };
  total: number;
}

/** Upload order: batch first, then position within the batch, then ID. */
function compareUploadOrder(a: PhotoRecord, b: PhotoRecord): number {
  if (a.batchSeq !== b.batchSeq) return a.batchSeq - b.batchSeq;
  if (a.selectionIndex !== b.selectionIndex) {
    return a.selectionIndex - b.selectionIndex;
  }
  // Total order, so pagination and prev/next never disagree with the grid.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Order within a single day: timed photos in clock order first, then
 * date-only photos in upload order. `timeSortKey` returns +Infinity for a
 * null time, which places date-only photos after every timed one without a
 * separate branch.
 */
export function comparePhotosWithinDay(a: PhotoRecord, b: PhotoRecord): number {
  const keyA = timeSortKey(a.captureTime);
  const keyB = timeSortKey(b.captureTime);
  if (keyA !== keyB) return keyA - keyB;
  return compareUploadOrder(a, b);
}

/** Undated photos have nothing else to order by. */
export function compareUndatedPhotos(a: PhotoRecord, b: PhotoRecord): number {
  return compareUploadOrder(a, b);
}

/**
 * Build the full newest-first hierarchy from a flat list of live photos.
 *
 * Group index pages show counts only; photos appear solely in their day grid
 * and are never repeated as representative thumbnails, so nothing here lifts
 * a photo into a year or month entry.
 */
export function buildHierarchy(photos: readonly PhotoRecord[]): Hierarchy {
  const byDate = new Map<CaptureDate, PhotoRecord[]>();
  const undated: PhotoRecord[] = [];

  for (const photo of photos) {
    if (photo.captureDate === null) {
      undated.push(photo);
      continue;
    }
    const bucket = byDate.get(photo.captureDate);
    if (bucket) bucket.push(photo);
    else byDate.set(photo.captureDate, [photo]);
  }

  const days: DayGroup[] = [];
  for (const [date, group] of byDate) {
    const { year, month, day } = splitCaptureDate(date);
    days.push({
      date,
      year,
      month,
      day,
      count: group.length,
      photos: [...group].sort(comparePhotosWithinDay),
    });
  }

  const years = new Map<number, Map<number, DayGroup[]>>();
  for (const dayGroup of days) {
    const months = years.get(dayGroup.year) ?? new Map<number, DayGroup[]>();
    years.set(dayGroup.year, months);
    const bucket = months.get(dayGroup.month);
    if (bucket) bucket.push(dayGroup);
    else months.set(dayGroup.month, [dayGroup]);
  }

  const yearGroups: YearGroup[] = [];
  for (const [year, months] of years) {
    const monthGroups: MonthGroup[] = [];
    for (const [month, dayGroups] of months) {
      const sortedDays = [...dayGroups].sort((a, b) => b.day - a.day);
      monthGroups.push({
        year,
        month,
        count: sumCounts(sortedDays),
        days: sortedDays,
      });
    }
    monthGroups.sort((a, b) => b.month - a.month);
    yearGroups.push({
      year,
      count: monthGroups.reduce((total, m) => total + m.count, 0),
      months: monthGroups,
    });
  }
  yearGroups.sort((a, b) => b.year - a.year);

  return {
    years: yearGroups,
    undated: {
      count: undated.length,
      photos: [...undated].sort(compareUndatedPhotos),
    },
    total: photos.length,
  };
}

function sumCounts(days: readonly DayGroup[]): number {
  return days.reduce((total, day) => total + day.count, 0);
}

export function findYear(hierarchy: Hierarchy, year: number): YearGroup | null {
  return hierarchy.years.find((entry) => entry.year === year) ?? null;
}

export function findMonth(
  hierarchy: Hierarchy,
  year: number,
  month: number,
): MonthGroup | null {
  return findYear(hierarchy, year)?.months.find((m) => m.month === month) ?? null;
}

export function findDay(
  hierarchy: Hierarchy,
  year: number,
  month: number,
  day: number,
): DayGroup | null {
  return findMonth(hierarchy, year, month)?.days.find((d) => d.day === day) ?? null;
}

export interface Siblings {
  previous: PhotoRecord | null;
  next: PhotoRecord | null;
  index: number;
  total: number;
}

/**
 * Previous/next within the photo's own group — the day grid, or the Undated
 * group. Navigation never crosses a group boundary.
 */
export function siblingsWithinGroup(
  group: readonly PhotoRecord[],
  photoId: string,
): Siblings | null {
  const index = group.findIndex((photo) => photo.id === photoId);
  if (index === -1) return null;
  return {
    previous: index > 0 ? (group[index - 1] ?? null) : null,
    next: index < group.length - 1 ? (group[index + 1] ?? null) : null,
    index,
    total: group.length,
  };
}
