/**
 * The read-only display API contract, and the pure functions that produce it
 * from a catalog.
 *
 * The projection lives here rather than in the Netlify function so the same
 * code answers requests in production, in the local development fixture
 * server, and in tests — and so there is exactly one place that decides what
 * a viewer is allowed to see.
 *
 * Two projections, and only two: the whole library, and one photo. Both apps
 * are a single scrolling page, so the level-by-level hierarchy, day, and
 * undated projections have nothing left to answer and are gone (decisions.md,
 * "The admin becomes the viewer").
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
 * The whole library in one response.
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

/**
 * Built from `liveHierarchy`, so trashed photos are excluded and every
 * ordering rule — newest-first years, months and days, time-of-day within a
 * day, upload order for undated — comes along unchanged rather than being
 * restated here.
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
