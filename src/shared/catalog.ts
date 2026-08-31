/**
 * The catalog: the single versioned JSON document in R2 that holds every
 * photo record.
 *
 * There is deliberately no processing state. A record exists only for a photo
 * whose four artifacts are fully uploaded and verified, so an interrupted
 * batch leaves nothing behind to reconcile (decisions.md #6).
 */

import type { Rendition } from './constants.ts';
import type { CaptureDate, CaptureTime } from './datetime.ts';

export const CATALOG_SCHEMA_VERSION = 1;

/**
 * Which source the stored capture timestamp came from. Recorded for
 * diagnostics and later correction — a date guessed from a filename deserves
 * less trust than one read from `DateTimeOriginal`.
 */
export type TimestampSource =
  'exif-datetimeoriginal' | 'exif-other' | 'filename' | 'manual' | 'none';

export interface DerivativeDescriptor {
  width: number;
  height: number;
  bytes: number;
}

export interface PhotoRecord {
  /** Cryptographically random. Appears in object paths and capability URLs. */
  id: string;
  /**
   * SHA-256 of the *source* bytes, used only for duplicate detection.
   * Internal: never placed in a URL, because a hash of a file someone already
   * has would let them confirm its presence.
   */
  contentHash: string;

  originalFilename: string;
  /** Sanitized basename plus `.jpg`; every stored original is a JPEG. */
  downloadFilename: string;
  sourceMimeType: string;

  /** Camera-local wall clock. See datetime.ts on why these stay strings. */
  captureDate: CaptureDate | null;
  captureTime: CaptureTime | null;
  /** Known UTC offset, recorded but never applied to shift the timestamp. */
  captureUtcOffset: string | null;
  timestampSource: TimestampSource;

  /** Plain text with line breaks. Never HTML or Markdown. */
  caption: string | null;

  /** Server-assigned, global, monotonic. Orders batches against each other. */
  batchSeq: number;
  /** Position within its batch's selection or drop order. */
  selectionIndex: number;

  /** Genuine instants, unlike the capture fields. ISO-8601 UTC. */
  createdAt: string;
  updatedAt: string;
  /** Non-null means trashed; the daily cron purges 30 days after this. */
  trashedAt: string | null;

  derivatives: Record<Rendition, DerivativeDescriptor>;

  /** Correlates this record with entries in the append-only audit log. */
  createdAuditId: string;
  updatedAuditId: string;
}

export interface Catalog {
  schemaVersion: number;
  /**
   * Monotonic batch counter. Incremented at begin-batch — the only
   * server-side write that happens before a commit, so an abandoned batch
   * leaves nothing but a harmless gap in the sequence.
   */
  batchCounter: number;
  updatedAt: string;
  photos: Record<string, PhotoRecord>;
}

export function emptyCatalog(now: string): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    batchCounter: 0,
    updatedAt: now,
    photos: {},
  };
}

export function isTrashed(photo: PhotoRecord): boolean {
  return photo.trashedAt !== null;
}

/** Photos visible in the display hierarchy: everything not trashed. */
export function livePhotos(catalog: Catalog): PhotoRecord[] {
  return Object.values(catalog.photos).filter((photo) => !isTrashed(photo));
}

export function trashedPhotos(catalog: Catalog): PhotoRecord[] {
  return Object.values(catalog.photos).filter(isTrashed);
}

/**
 * Duplicate detection. Trashed photos are included on purpose: re-uploading a
 * file that is sitting in the trash should be reported as the existing photo
 * rather than creating a second copy of the same bytes.
 */
export function findByContentHash(
  catalog: Catalog,
  contentHash: string,
): PhotoRecord | null {
  for (const photo of Object.values(catalog.photos)) {
    if (photo.contentHash === contentHash) return photo;
  }
  return null;
}

/**
 * Public lookup. Returns null for unknown *and* trashed IDs so callers cannot
 * distinguish them — both must yield a generic 404.
 */
export function getLivePhoto(catalog: Catalog, id: string): PhotoRecord | null {
  const photo = catalog.photos[id];
  if (!photo || isTrashed(photo)) return null;
  return photo;
}

/** Milliseconds since the record was trashed, or null if it is not trashed. */
export function trashedAgeMs(photo: PhotoRecord, nowMs: number): number | null {
  if (photo.trashedAt === null) return null;
  return nowMs - Date.parse(photo.trashedAt);
}
