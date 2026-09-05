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

import { RECENT_GAP_HOURS, RECENT_WINDOW_DAYS } from './constants.ts';
import type { Rendition } from './constants.ts';
import { getLivePhoto, livePhotos } from './catalog.ts';
import type { Catalog, DerivativeDescriptor, PhotoRecord } from './catalog.ts';
import {
  buildHierarchy,
  comparePhotosByCapture,
  findDay,
  siblingsWithinGroup,
} from './ordering.ts';
import type { Hierarchy } from './ordering.ts';
import type { CaptureDate } from './datetime.ts';

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
  /**
   * The Recently Uploaded view, newest group first. Empty whenever nothing
   * has arrived within the recency window, which is an ordinary state rather
   * than an edge case.
   *
   * The photographs are not repeated here — the groups carry ids, which the
   * client resolves against the map it already builds from `years` and
   * `undated`. Two copies of a photo in one response are two things that can
   * disagree.
   */
  recent: RecentGroup[];
}

/**
 * One upload sitting, as the Recently Uploaded view shows it.
 *
 * The server names no calendar day. `createdAt` is a genuine instant, and an
 * instant has no day until you choose a place to stand — the viewers of this
 * site are scattered and none of them is the uploader, so the browser does
 * that with its own zone (decisions.md, "The server groups without a
 * calendar").
 */
export interface RecentGroup {
  /**
   * ISO-8601 UTC instant: the newest `createdAt` in the group — the moment
   * after which the sitting was complete, which keeps "Added today" true for
   * one that began at 11:50pm the night before.
   */
  uploadedAt: string;
  count: number;
  /** Capture span of the dated photographs. Null when all are undated. */
  captureRange: { earliest: CaptureDate; latest: CaptureDate } | null;
  undatedCount: number;
  /** The group's photo IDs, in display order: capture order, newest first. */
  photoIds: string[];
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Arrival order, newest first. Total, so the set and the groups are reproducible. */
function compareByArrival(a: PhotoRecord, b: PhotoRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  // `createdAt` is stamped per commit from that request's own clock, so a tie
  // is near-impossible; the tiebreak is here so tests and rendering cannot
  // depend on `Object.values` order.
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Which live photographs count as recently uploaded, at `nowMs`.
 *
 * A window and batch closure, and nothing else (design.md, "Display site"):
 * everything uploaded in the last `RECENT_WINDOW_DAYS`, plus the rest of any
 * upload one of those lands in, so an upload is never shown cut in half.
 * Trashed photographs are excluded at every stage, including from the
 * closure: a batch's trashed members do not come back.
 *
 * There was once a floor as well — the 50 newest, whatever their age, union'd
 * with the window. It went because a view whose contents cannot be described
 * in one sentence is a view nobody trusts, and "the 50 newest, or the last
 * month, whichever is more" is two sentences pretending to be one. It also
 * meant the view routinely showed photographs that were not recent by any
 * reading (decisions.md #64). Losing it makes the empty view an ordinary
 * state rather than an impossible one.
 *
 * One closure pass is enough, because sharing a `batchSeq` is an equivalence
 * relation and the result is therefore already closed. There is no ceiling:
 * an 800-photograph import inside the window appears whole.
 */
function recentSet(live: readonly PhotoRecord[], nowMs: number): PhotoRecord[] {
  const byArrival = [...live].sort(compareByArrival);
  const windowMs = RECENT_WINDOW_DAYS * DAY_MS;

  const batches = new Set<number>();
  for (const photo of byArrival) {
    if (nowMs - Date.parse(photo.createdAt) < windowMs) batches.add(photo.batchSeq);
  }

  return byArrival.filter((photo) => batches.has(photo.batchSeq));
}

/**
 * Split arrival-ordered photographs wherever more than `RECENT_GAP_HOURS`
 * passes between two of them.
 *
 * `batchSeq` is deliberately not the key. A batch is one admin page session,
 * so it spans days if the tab is left open and splits if the page is
 * reloaded mid-sitting; neither boundary is visible or meaningful to the
 * family. It keeps its job in the closure rule above and nowhere else.
 */
function splitIntoSittings(byArrival: readonly PhotoRecord[]): PhotoRecord[][] {
  const gapMs = RECENT_GAP_HOURS * 60 * 60 * 1000;
  const sittings: PhotoRecord[][] = [];
  let current: PhotoRecord[] = [];
  let previousMs = 0;

  for (const photo of byArrival) {
    const ms = Date.parse(photo.createdAt);
    // Ordered newest first, so the earlier reading is the larger one.
    if (current.length > 0 && previousMs - ms > gapMs) {
      sittings.push(current);
      current = [];
    }
    current.push(photo);
    previousMs = ms;
  }
  if (current.length > 0) sittings.push(current);
  return sittings;
}

/** The span of the dated photographs in a sitting, or null when none are dated. */
function captureRangeOf(
  photos: readonly PhotoRecord[],
): { earliest: CaptureDate; latest: CaptureDate } | null {
  let earliest: CaptureDate | null = null;
  let latest: CaptureDate | null = null;
  for (const photo of photos) {
    const date = photo.captureDate;
    // Canonical `YYYY-MM-DD`, so min and max are string comparisons; parsing
    // them into a `Date` is what datetime.ts exists to forbid.
    if (date === null) continue;
    if (earliest === null || date < earliest) earliest = date;
    if (latest === null || date > latest) latest = date;
  }
  return earliest !== null && latest !== null ? { earliest, latest } : null;
}

/**
 * The Recently Uploaded projection: which photographs arrived lately, split
 * into upload sittings, each in the site's own capture order.
 *
 * `nowMs` is an argument rather than a clock reading, so the same catalog
 * always produces the same answer in a test and the rule is never judged by a
 * viewer's own clock.
 */
export function recentGroups(catalog: Catalog, nowMs: number): RecentGroup[] {
  return splitIntoSittings(recentSet(livePhotos(catalog), nowMs)).map((sitting) => ({
    // The newest is first: the sitting is ordered by arrival, newest first.
    uploadedAt: sitting[0]!.createdAt,
    count: sitting.length,
    captureRange: captureRangeOf(sitting),
    undatedCount: sitting.filter((photo) => photo.captureDate === null).length,
    photoIds: [...sitting].sort(comparePhotosByCapture).map((photo) => photo.id),
  }));
}

/**
 * Built from `liveHierarchy`, so trashed photos are excluded and every
 * ordering rule — newest-first years, months and days, time-of-day within a
 * day, upload order for undated — comes along unchanged rather than being
 * restated here.
 *
 * `nowMs` is threaded in for the recency window rather than read from the
 * clock here, exactly as `now` is threaded through the mutation path: a
 * projection that reads the clock cannot be tested against a fixture and
 * cannot be reasoned about twice.
 */
export function timelineResponse(
  catalog: Catalog,
  title: string,
  nowMs: number,
): TimelineResponse {
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
    recent: recentGroups(catalog, nowMs),
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
