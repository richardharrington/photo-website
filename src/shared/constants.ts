/**
 * Fixed limits and encoding settings from design.md.
 *
 * This module is imported by the browser apps, the Netlify functions, and the
 * Cloudflare Worker, so it must stay free of DOM, Node, and Workers globals.
 */

/** Source files larger than this are rejected before any decode. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/**
 * Source pixel cap. Checked against container/EXIF header dimensions *before*
 * full decode — an oversized file must not be able to exhaust memory before
 * the guard meant to prevent that can fire (decisions.md #21).
 */
export const MAX_SOURCE_PIXELS = 50_000_000;

export const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
] as const;

/** Lowercased extensions accepted at the picker and drop target. */
export const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.heif'] as const;

/**
 * The four artifacts stored per photo. `full` is the sanitized sRGB JPEG used
 * for original-size download; the rest are the responsive WebP derivatives.
 */
export const RENDITIONS = ['full', 'thumb', 'display-1280', 'display-2560'] as const;
export type Rendition = (typeof RENDITIONS)[number];

/**
 * Renditions the asset Worker will serve at an unsigned capability URL.
 *
 * `full` is deliberately excluded: the full-resolution JPEG is reachable only
 * through a short-lived HMAC-signed download URL, so it cannot be fetched by
 * knowing the photo ID alone.
 */
export const DISPLAY_RENDITIONS = [
  'thumb',
  'display-1280',
  'display-2560',
] as const satisfies readonly Rendition[];
export type DisplayRendition = (typeof DISPLAY_RENDITIONS)[number];

export interface RenditionSpec {
  /** Longest-edge target in pixels, or null for full resolution. */
  maxEdge: number | null;
  format: 'jpeg' | 'webp';
  quality: number;
  objectName: string;
  contentType: string;
}

export const RENDITION_SPECS: Record<Rendition, RenditionSpec> = {
  full: {
    maxEdge: null,
    format: 'jpeg',
    quality: 92,
    objectName: 'full.jpg',
    contentType: 'image/jpeg',
  },
  thumb: {
    maxEdge: 400,
    format: 'webp',
    quality: 82,
    objectName: 'thumb.webp',
    contentType: 'image/webp',
  },
  'display-1280': {
    maxEdge: 1280,
    format: 'webp',
    quality: 82,
    objectName: 'display-1280.webp',
    contentType: 'image/webp',
  },
  'display-2560': {
    maxEdge: 2560,
    format: 'webp',
    quality: 82,
    objectName: 'display-2560.webp',
    contentType: 'image/webp',
  },
};

/** Days a trashed photo is retained before the daily cron purges it. */
export const TRASH_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Emailed submissions
// ---------------------------------------------------------------------------

/**
 * Days an unreviewed emailed submission is kept before the daily maintenance
 * pass deletes it, parts and record alike.
 *
 * The same number as the trash, and for a stronger reason: an emailed original
 * is the sender's file exactly as they sent it, GPS and all, and the site
 * should not hold one indefinitely because nobody got round to looking at it.
 * An administrator away for a month loses those submissions, which is the
 * deliberate price.
 */
export const INBOX_RETENTION_DAYS = 30;

/**
 * The inbox's ceiling, counted from a `list` of the prefix when a message
 * arrives. Cheap, approximate, and enough to stop a compromised family mailbox
 * from filling the bucket; a sender over it gets a bounce, not silence.
 */
export const INBOX_MAX_PARTS = 200;
export const INBOX_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How long one tab's claim on a submission holds before another may take it
 * over. Adding is a browser-side job of seconds to minutes; this is generous
 * enough to cover a slow batch and short enough that a closed tab does not
 * strand a submission for the afternoon.
 */
export const INBOX_CLAIM_TTL_MINUTES = 15;

/**
 * Parts smaller than this start unticked in the Inbox.
 *
 * The aim is that a signature logo or an inline emoji starts unticked and a
 * photograph never does. It is a default, not a filter: every tick can be
 * flipped, and nothing is decided by it.
 */
export const INBOX_SMALL_PART_BYTES = 32 * 1024;

/**
 * The Recently Uploaded view's two numbers (design.md, "Display site").
 *
 * The window is how far back "recently" reaches; the gap decides where one
 * upload sitting ends and the next begins. There is deliberately no ceiling:
 * a photo inside the window pulls its whole batch in with it, so an upload is
 * never shown cut in half (decisions.md #64).
 */
export const RECENT_WINDOW_DAYS = 30;
export const RECENT_GAP_HOURS = 6;

/** Objects with no catalog record are swept only after this grace period. */
export const ORPHAN_GRACE_HOURS = 24;

/** Snapshots newer than this are kept in full; older ones thin to one per day. */
export const SNAPSHOT_FULL_RETENTION_DAYS = 30;

/** Lifetime of an HMAC-signed download or trash-thumbnail URL. */
export const SIGNED_URL_TTL_SECONDS = 5 * 60;

/** How long the Worker may serve a cached catalog before re-reading it. */
export const WORKER_CATALOG_CACHE_SECONDS = 60;

/** Concurrent *uploads*. Decode and encode stay strictly serial (decisions.md #21). */
export const UPLOAD_CONCURRENCY = 3;

export const R2_KEYS = {
  catalog: 'catalog/current.json',
  /**
   * Per-recipient notification state. Deliberately its own object rather than
   * a field on the catalog: every viewer request loads the catalog through the
   * Worker, and it should not carry a recipient list.
   */
  notifications: 'catalog/notifications.json',
  snapshotPrefix: 'catalog/snapshots/',
  auditPrefix: 'catalog/audit/',
  photoPrefix: 'photos/',
  /**
   * Emailed submissions awaiting review: one record and its raw parts per
   * message. Deliberately outside `photos/`, because the orphan sweep reaps
   * that prefix and an unreviewed submission has no catalog record by
   * definition. The retention purge is the inbox's only reaper.
   */
  inboxPrefix: 'inbox/',
} as const;

export function photoObjectKey(photoId: string, rendition: Rendition): string {
  return `${R2_KEYS.photoPrefix}${photoId}/${RENDITION_SPECS[rendition].objectName}`;
}

/** `inbox/<submissionId>/message.json` — the record for one message. */
export function submissionRecordKey(submissionId: string): string {
  return `${R2_KEYS.inboxPrefix}${submissionId}/message.json`;
}

/** `inbox/<submissionId>/parts/<n>` — one raw part, byte for byte as sent. */
export function submissionPartKey(submissionId: string, index: number): string {
  return `${R2_KEYS.inboxPrefix}${submissionId}/parts/${index}`;
}
