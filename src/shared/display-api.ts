/**
 * The read-only display API contract, and the pure functions that produce it
 * from a catalog.
 *
 * The projection lives here rather than in the Netlify function so the same
 * code answers requests in production, in the local development fixture
 * server, and in tests — and so there is exactly one place that decides what
 * a viewer is allowed to see.
 */

import type { Rendition } from './constants.ts';
import { getLivePhoto, livePhotos } from './catalog.ts';
import type { Catalog, DerivativeDescriptor, PhotoRecord } from './catalog.ts';
import { buildHierarchy, findDay, siblingsWithinGroup } from './ordering.ts';
import type { Hierarchy } from './ordering.ts';

/**
 * A photo as the viewer sees it.
 *
 * `contentHash` is deliberately absent: it is a hash of bytes the recipient
 * may already hold, so publishing it would let someone confirm whether a
 * particular file is in the library. `batchSeq` and `selectionIndex` are
 * absent because ordering is already applied server-side.
 */
export interface PublicPhoto {
  id: string;
  caption: string | null;
  captureDate: string | null;
  captureTime: string | null;
  captureUtcOffset: string | null;
  /** Shown in the photo information view, never in the grid. */
  originalFilename: string;
  derivatives: Record<Rendition, DerivativeDescriptor>;
}

export type GroupRef =
  { kind: 'day'; year: number; month: number; day: number } | { kind: 'undated' };

export interface DayCount {
  day: number;
  count: number;
}
export interface MonthCount {
  month: number;
  count: number;
  days: DayCount[];
}
export interface YearCount {
  year: number;
  count: number;
  months: MonthCount[];
}

/**
 * The whole navigation tree in one response: counts only, no photos.
 *
 * Group index pages show counts and never repeat photos as representative
 * thumbnails, so this stays small — a few kilobytes at the design's scale —
 * and one request answers every index page.
 */
export interface HierarchyResponse {
  title: string;
  years: YearCount[];
  undated: { count: number };
  total: number;
}

export interface TimelineDay {
  day: number;
  count: number;
  photos: PublicPhoto[];
}
export interface TimelineMonth {
  month: number;
  count: number;
  days: TimelineDay[];
}
export interface TimelineYear {
  year: number;
  count: number;
  months: TimelineMonth[];
}

/**
 * The whole library in one response: the same tree as `HierarchyResponse`, with
 * every photo included.
 *
 * The viewer is a single scrolling page, so it needs the entire structure
 * before it can lay itself out. Sending it all at once is what makes the
 * layout *final* at first paint — every rendition's pixel dimensions are here,
 * so nothing reflows as thumbnails arrive and an anchor scroll computed at load
 * time is still correct a second later. At the design's scale this is tens of
 * kilobytes now and a couple of megabytes after a decade; the images were
 * always the heavy part, and `loading="lazy"` keeps those proportional to
 * scrolling.
 */
export interface TimelineResponse {
  title: string;
  years: TimelineYear[];
  undated: { count: number; photos: PublicPhoto[] };
  total: number;
}

export interface GroupResponse {
  group: GroupRef;
  photos: PublicPhoto[];
}

export interface PhotoResponse {
  photo: PublicPhoto;
  group: GroupRef;
  /** Position within the group, for "3 of 24". */
  index: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
}

export function toPublicPhoto(photo: PhotoRecord): PublicPhoto {
  return {
    id: photo.id,
    caption: photo.caption,
    captureDate: photo.captureDate,
    captureTime: photo.captureTime,
    captureUtcOffset: photo.captureUtcOffset,
    originalFilename: photo.originalFilename,
    derivatives: photo.derivatives,
  };
}

/** Live photos only; a trashed photo is invisible to every display route. */
function liveHierarchy(catalog: Catalog): Hierarchy {
  return buildHierarchy(livePhotos(catalog));
}

export function hierarchyResponse(catalog: Catalog, title: string): HierarchyResponse {
  const hierarchy = liveHierarchy(catalog);
  return {
    title,
    years: hierarchy.years.map((year) => ({
      year: year.year,
      count: year.count,
      months: year.months.map((month) => ({
        month: month.month,
        count: month.count,
        days: month.days.map((day) => ({ day: day.day, count: day.count })),
      })),
    })),
    undated: { count: hierarchy.undated.count },
    total: hierarchy.total,
  };
}

/**
 * Built from the same `liveHierarchy` as `hierarchyResponse`, so trashed
 * photos are excluded and every ordering rule — newest-first years, months and
 * days, time-of-day within a day, upload order for undated — comes along
 * unchanged rather than being restated here.
 */
export function timelineResponse(catalog: Catalog, title: string): TimelineResponse {
  const hierarchy = liveHierarchy(catalog);
  return {
    title,
    years: hierarchy.years.map((year) => ({
      year: year.year,
      count: year.count,
      months: year.months.map((month) => ({
        month: month.month,
        count: month.count,
        days: month.days.map((day) => ({
          day: day.day,
          count: day.count,
          photos: day.photos.map(toPublicPhoto),
        })),
      })),
    })),
    undated: {
      count: hierarchy.undated.count,
      photos: hierarchy.undated.photos.map(toPublicPhoto),
    },
    total: hierarchy.total,
  };
}

export function dayResponse(
  catalog: Catalog,
  year: number,
  month: number,
  day: number,
): GroupResponse | null {
  const group = findDay(liveHierarchy(catalog), year, month, day);
  if (!group) return null;
  return {
    group: { kind: 'day', year, month, day },
    photos: group.photos.map(toPublicPhoto),
  };
}

/**
 * The Undated group. Unlike a day, an empty Undated group is a valid empty
 * response rather than a 404 — it is a fixed part of the navigation.
 */
export function undatedResponse(catalog: Catalog): GroupResponse {
  return {
    group: { kind: 'undated' },
    photos: liveHierarchy(catalog).undated.photos.map(toPublicPhoto),
  };
}

/** The ordered group a photo belongs to, used for prev/next navigation. */
function groupOf(
  catalog: Catalog,
  photo: PhotoRecord,
): { ref: GroupRef; photos: PhotoRecord[] } | null {
  const hierarchy = liveHierarchy(catalog);

  if (photo.captureDate === null) {
    return { ref: { kind: 'undated' }, photos: hierarchy.undated.photos };
  }

  const [y, m, d] = photo.captureDate.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const day = findDay(hierarchy, y, m, d);
  if (!day) return null;
  return {
    ref: { kind: 'day', year: y, month: m, day: d },
    photos: day.photos,
  };
}

export function photoResponse(catalog: Catalog, id: string): PhotoResponse | null {
  // Returns null for unknown and trashed alike, so both produce a generic 404.
  const photo = getLivePhoto(catalog, id);
  if (!photo) return null;

  const group = groupOf(catalog, photo);
  if (!group) return null;

  const siblings = siblingsWithinGroup(group.photos, id);
  if (!siblings) return null;

  return {
    photo: toPublicPhoto(photo),
    group: group.ref,
    index: siblings.index,
    total: siblings.total,
    previousId: siblings.previous?.id ?? null,
    nextId: siblings.next?.id ?? null,
  };
}
