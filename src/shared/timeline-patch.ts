/**
 * Pure edits to a timeline response, so a mutation shows on the page at once.
 *
 * The admin patches its copy of the library from the server's own reply and
 * then refetches in the background: immediate UI, and one source of truth a
 * moment later. That makes these functions a *forecast* of what the next
 * `/timeline` will say, not the authority on it — where the forecast cannot be
 * exact, `upsertPhoto` says so below, and the refetch corrects it.
 *
 * Runtime-neutral on purpose. This module is compiled into the Netlify
 * functions and the Worker along with the rest of `src/shared/`, so it touches
 * no DOM: it is outside `ui/`, and that is the line.
 *
 * Every function recomputes every count from the photos actually present, so
 * the counts-agree invariant the projection guarantees survives a patch.
 */

import { timeSortKey } from './datetime.ts';
import type {
  PublicPhoto,
  TimelineDay,
  TimelineMonth,
  TimelineResponse,
  TimelineYear,
} from './display-api.ts';

/** Rebuild a month from its days, dropping it when nothing is left. */
function withDays(month: TimelineMonth, days: TimelineDay[]): TimelineMonth | null {
  if (days.length === 0) return null;
  return {
    month: month.month,
    count: days.reduce((total, day) => total + day.count, 0),
    days,
  };
}

/** Rebuild a year from its months, dropping it when nothing is left. */
function withMonths(year: TimelineYear, months: TimelineMonth[]): TimelineYear | null {
  if (months.length === 0) return null;
  return {
    year: year.year,
    count: months.reduce((total, month) => total + month.count, 0),
    months,
  };
}

function totalOf(years: readonly TimelineYear[], undatedCount: number): number {
  return years.reduce((total, year) => total + year.count, 0) + undatedCount;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Drop photos from the timeline, and any day, month, or year left empty.
 *
 * An empty group is not a valid part of the page — a well-formed route for one
 * is a 404, not an empty grid — so a delete that empties a day has to take the
 * day with it.
 */
export function removePhotos(
  timeline: TimelineResponse,
  ids: Iterable<string>,
): TimelineResponse {
  const removed = new Set(ids);
  if (removed.size === 0) return timeline;

  const years = timeline.years
    .map((year) =>
      withMonths(
        year,
        year.months
          .map((month) =>
            withDays(
              month,
              month.days
                .map((day) => {
                  const photos = day.photos.filter((photo) => !removed.has(photo.id));
                  return photos.length === 0
                    ? null
                    : { day: day.day, count: photos.length, photos };
                })
                .filter(notNull),
            ),
          )
          .filter(notNull),
      ),
    )
    .filter(notNull);

  const undatedPhotos = timeline.undated.photos.filter(
    (photo) => !removed.has(photo.id),
  );

  return {
    title: timeline.title,
    years,
    undated: { count: undatedPhotos.length, photos: undatedPhotos },
    total: totalOf(years, undatedPhotos.length),
  };
}

/**
 * Put a photo where its metadata now says it belongs.
 *
 * It is removed from wherever it was first, so an edit that corrects a capture
 * date moves the photo rather than duplicating it, and creates or destroys a
 * day, month, or year as the move requires — in the newest-first order the
 * projection uses.
 *
 * Placement within a day is exact for a photo with a capture time, which sorts
 * in clock order. It cannot be exact for a date-only photo: those are ordered
 * by `(batchSeq, selectionIndex)`, and a `PublicPhoto` deliberately carries
 * neither — publishing them would say more about the library than a viewer
 * needs. Such a photo is appended after the day's timed photos, which is the
 * right region if not always the right position, and the background refetch
 * settles it.
 */
export function upsertPhoto(
  timeline: TimelineResponse,
  photo: PublicPhoto,
): TimelineResponse {
  const without = removePhotos(timeline, [photo.id]);

  if (photo.captureDate === null) {
    const photos = [...without.undated.photos, photo];
    return {
      ...without,
      undated: { count: photos.length, photos },
      total: totalOf(without.years, photos.length),
    };
  }

  const [year, month, day] = photo.captureDate.split('-').map(Number) as [
    number,
    number,
    number,
  ];

  const years = insertYear(without.years, year, month, day, photo);
  return {
    title: without.title,
    years,
    undated: without.undated,
    total: totalOf(years, without.undated.count),
  };
}

/** Insert into an existing year, or create one in newest-first position. */
function insertYear(
  years: readonly TimelineYear[],
  year: number,
  month: number,
  day: number,
  photo: PublicPhoto,
): TimelineYear[] {
  const existing = years.find((entry) => entry.year === year);
  if (existing) {
    const months = insertMonth(existing.months, month, day, photo);
    return years.map((entry) =>
      entry.year === year
        ? { year, count: months.reduce((n, m) => n + m.count, 0), months }
        : entry,
    );
  }

  const created: TimelineYear = {
    year,
    count: 1,
    months: [{ month, count: 1, days: [{ day, count: 1, photos: [photo] }] }],
  };
  return insertDescending([...years], created, (entry) => entry.year);
}

function insertMonth(
  months: readonly TimelineMonth[],
  month: number,
  day: number,
  photo: PublicPhoto,
): TimelineMonth[] {
  const existing = months.find((entry) => entry.month === month);
  if (existing) {
    const days = insertDay(existing.days, day, photo);
    return months.map((entry) =>
      entry.month === month
        ? { month, count: days.reduce((n, d) => n + d.count, 0), days }
        : entry,
    );
  }

  const created: TimelineMonth = {
    month,
    count: 1,
    days: [{ day, count: 1, photos: [photo] }],
  };
  return insertDescending([...months], created, (entry) => entry.month);
}

function insertDay(
  days: readonly TimelineDay[],
  day: number,
  photo: PublicPhoto,
): TimelineDay[] {
  const existing = days.find((entry) => entry.day === day);
  if (existing) {
    const photos = insertWithinDay(existing.photos, photo);
    return days.map((entry) =>
      entry.day === day ? { day, count: photos.length, photos } : entry,
    );
  }

  const created: TimelineDay = { day, count: 1, photos: [photo] };
  return insertDescending([...days], created, (entry) => entry.day);
}

/** Clock order among timed photos; date-only photos after all of them. */
function insertWithinDay(
  photos: readonly PublicPhoto[],
  photo: PublicPhoto,
): PublicPhoto[] {
  const key = timeSortKey(photo.captureTime);
  const at = photos.findIndex((other) => timeSortKey(other.captureTime) > key);
  const next = [...photos];
  if (at === -1) next.push(photo);
  else next.splice(at, 0, photo);
  return next;
}

/** Newest first, which is how every level of the projection is ordered. */
function insertDescending<T>(entries: T[], entry: T, keyOf: (entry: T) => number): T[] {
  const at = entries.findIndex((other) => keyOf(other) < keyOf(entry));
  if (at === -1) entries.push(entry);
  else entries.splice(at, 0, entry);
  return entries;
}
