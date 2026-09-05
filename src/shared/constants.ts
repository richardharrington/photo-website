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
  snapshotPrefix: 'catalog/snapshots/',
  auditPrefix: 'catalog/audit/',
  photoPrefix: 'photos/',
} as const;

export function photoObjectKey(photoId: string, rendition: Rendition): string {
  return `${R2_KEYS.photoPrefix}${photoId}/${RENDITION_SPECS[rendition].objectName}`;
}
