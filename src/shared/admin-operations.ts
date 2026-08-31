/**
 * Admin mutations, as pure functions of the catalog.
 *
 * Each returns a `Mutation`, which `mutateCatalog` applies under a conditional
 * write and **re-runs from scratch on conflict**. Nothing here may have a side
 * effect: no I/O, no ID generation, no clock reads. Anything non-deterministic
 * is passed in by the caller so a retry produces the same record rather than a
 * second, differently-identified one.
 */

import { RENDITIONS, photoObjectKey } from './constants.ts';
import type { Rendition } from './constants.ts';
import { findByContentHash, isTrashed } from './catalog.ts';
import type { Catalog, DerivativeDescriptor, PhotoRecord } from './catalog.ts';
import type { TimestampSource } from './catalog.ts';
import { abortMutation, writeMutation } from './catalog-repository.ts';
import type { Mutation } from './catalog-repository.ts';
import { buildHierarchy } from './ordering.ts';
import { validatePhotoEdit } from './validation.ts';
import type { PhotoEditInput } from './validation.ts';

// ---------------------------------------------------------------------------
// Begin batch
// ---------------------------------------------------------------------------

/**
 * Reserve the next batch sequence number.
 *
 * This is the only server-side write that happens before a commit. An
 * abandoned batch therefore leaves nothing but a gap in the sequence, which is
 * harmless: the number is used for ordering, not counting.
 */
export function beginBatch(catalog: Catalog): Mutation<number> {
  const batchSeq = catalog.batchCounter + 1;
  return writeMutation({ ...catalog, batchCounter: batchSeq }, batchSeq);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitInput {
  id: string;
  contentHash: string;
  originalFilename: string;
  downloadFilename: string;
  sourceMimeType: string;
  captureDate: string | null;
  captureTime: string | null;
  captureUtcOffset: string | null;
  timestampSource: TimestampSource;
  caption: string | null;
  batchSeq: number;
  selectionIndex: number;
  derivatives: Record<Rendition, DerivativeDescriptor>;
}

export type CommitOutcome =
  | { status: 'created'; photo: PhotoRecord }
  /** The same source bytes are already in the catalog, trashed or not. */
  | { status: 'duplicate'; existingId: string };

/**
 * Create the record for a fully uploaded photo.
 *
 * Hash uniqueness is re-checked *inside* the conditional write rather than at
 * prepare time. That is what closes the duplicate race: two browsers uploading
 * the same file concurrently both pass the prepare check, but only one can win
 * the catalog write, and the loser's retry sees the winner's record
 * (decisions.md #6).
 */
export function commitPhoto(
  catalog: Catalog,
  input: CommitInput,
  now: string,
  auditId: string,
): Mutation<CommitOutcome> {
  const duplicate = findByContentHash(catalog, input.contentHash);
  if (duplicate) {
    return abortMutation({ status: 'duplicate', existingId: duplicate.id });
  }

  if (catalog.photos[input.id]) {
    // A retried commit of a photo already written. Report it as the duplicate
    // it is rather than overwriting a record that may since have been edited.
    return abortMutation({ status: 'duplicate', existingId: input.id });
  }

  const photo: PhotoRecord = {
    id: input.id,
    contentHash: input.contentHash,
    originalFilename: input.originalFilename,
    downloadFilename: input.downloadFilename,
    sourceMimeType: input.sourceMimeType,
    captureDate: input.captureDate,
    captureTime: input.captureTime,
    captureUtcOffset: input.captureUtcOffset,
    timestampSource: input.timestampSource,
    caption: input.caption,
    batchSeq: input.batchSeq,
    selectionIndex: input.selectionIndex,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    derivatives: input.derivatives,
    createdAuditId: auditId,
    updatedAuditId: auditId,
  };

  return writeMutation(
    { ...catalog, photos: { ...catalog.photos, [photo.id]: photo } },
    { status: 'created', photo },
  );
}

// ---------------------------------------------------------------------------
// Metadata edits
// ---------------------------------------------------------------------------

export type EditOutcome =
  | { status: 'updated'; photo: PhotoRecord; previous: PhotoRecord }
  | { status: 'not-found' }
  | { status: 'invalid'; error: string };

export function editPhotoMetadata(
  catalog: Catalog,
  photoId: string,
  edit: PhotoEditInput,
  now: string,
  auditId: string,
): Mutation<EditOutcome> {
  const existing = catalog.photos[photoId];
  // A trashed photo is not editable; restore it first.
  if (!existing || isTrashed(existing)) return abortMutation({ status: 'not-found' });

  // The same validator the admin form uses, run again here: shared code is not
  // a reason for the server to trust the client.
  const validated = validatePhotoEdit(edit);
  if (!validated.ok) {
    return abortMutation({ status: 'invalid', error: validated.error });
  }

  const photo: PhotoRecord = {
    ...existing,
    captureDate: validated.value.moment.date,
    captureTime: validated.value.moment.time,
    caption: validated.value.caption,
    // An administrator's correction outranks whatever was read at ingest, and
    // recording that keeps a later re-derivation from silently undoing it.
    timestampSource:
      validated.value.moment.date === existing.captureDate &&
      validated.value.moment.time === existing.captureTime
        ? existing.timestampSource
        : 'manual',
    updatedAt: now,
    updatedAuditId: auditId,
  };

  return writeMutation(
    { ...catalog, photos: { ...catalog.photos, [photoId]: photo } },
    { status: 'updated', photo, previous: existing },
  );
}

// ---------------------------------------------------------------------------
// Trash, restore, permanent delete
// ---------------------------------------------------------------------------

export interface BulkOutcome {
  /** IDs actually changed. Excludes unknown IDs and no-op changes. */
  affected: string[];
}

/**
 * Mark photos trashed. Objects do not move — trash is a catalog flag, because
 * R2 has no rename and a copy-then-delete per object has undefined
 * partial-failure states (decisions.md #9).
 */
export function trashPhotos(
  catalog: Catalog,
  photoIds: readonly string[],
  now: string,
  auditId: string,
): Mutation<BulkOutcome> {
  const photos = { ...catalog.photos };
  const affected: string[] = [];

  for (const id of photoIds) {
    const photo = photos[id];
    if (!photo || isTrashed(photo)) continue;
    photos[id] = { ...photo, trashedAt: now, updatedAt: now, updatedAuditId: auditId };
    affected.push(id);
  }

  if (affected.length === 0) return abortMutation({ affected });
  return writeMutation({ ...catalog, photos }, { affected });
}

export function restorePhotos(
  catalog: Catalog,
  photoIds: readonly string[],
  now: string,
  auditId: string,
): Mutation<BulkOutcome> {
  const photos = { ...catalog.photos };
  const affected: string[] = [];

  for (const id of photoIds) {
    const photo = photos[id];
    if (!photo || !isTrashed(photo)) continue;
    photos[id] = { ...photo, trashedAt: null, updatedAt: now, updatedAuditId: auditId };
    affected.push(id);
  }

  if (affected.length === 0) return abortMutation({ affected });
  return writeMutation({ ...catalog, photos }, { affected });
}

/**
 * Remove records permanently.
 *
 * Only trashed photos can be permanently deleted, so there is no path from a
 * live photo to gone in a single action. The caller deletes the R2 objects
 * *after* this write succeeds — doing it first would orphan a record whose
 * images no longer exist if the catalog write then lost its race.
 */
export function permanentlyDeletePhotos(
  catalog: Catalog,
  photoIds: readonly string[],
): Mutation<BulkOutcome> {
  const photos = { ...catalog.photos };
  const affected: string[] = [];

  for (const id of photoIds) {
    const photo = photos[id];
    if (!photo || !isTrashed(photo)) continue;
    delete photos[id];
    affected.push(id);
  }

  if (affected.length === 0) return abortMutation({ affected });
  return writeMutation({ ...catalog, photos }, { affected });
}

// ---------------------------------------------------------------------------
// Resolving a selection to explicit IDs
// ---------------------------------------------------------------------------

export type SelectionQuery =
  | { kind: 'ids'; photoIds: readonly string[] }
  | { kind: 'day'; year: number; month: number; day: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  | { kind: 'undated' };

/**
 * Turn a selection into the explicit list of live photo IDs it covers.
 *
 * Every destructive action resolves to a list here, at preview time, and the
 * confirmation token is bound to that list. The confirm step never re-runs the
 * query, so a photo committed in between cannot be swept in (decisions.md #12).
 */
export function resolveSelection(catalog: Catalog, query: SelectionQuery): string[] {
  if (query.kind === 'ids') {
    return query.photoIds.filter((id) => {
      const photo = catalog.photos[id];
      return photo !== undefined && !isTrashed(photo);
    });
  }

  const hierarchy = buildHierarchy(
    Object.values(catalog.photos).filter((photo) => !isTrashed(photo)),
  );

  if (query.kind === 'undated') {
    return hierarchy.undated.photos.map((photo) => photo.id);
  }

  const year = hierarchy.years.find((entry) => entry.year === query.year);
  if (!year) return [];
  if (query.kind === 'year') {
    return year.months.flatMap((month) =>
      month.days.flatMap((day) => day.photos.map((photo) => photo.id)),
    );
  }

  const month = year.months.find((entry) => entry.month === query.month);
  if (!month) return [];
  if (query.kind === 'month') {
    return month.days.flatMap((day) => day.photos.map((photo) => photo.id));
  }

  const day = month.days.find((entry) => entry.day === query.day);
  return day ? day.photos.map((photo) => photo.id) : [];
}

/** Trashed IDs, for a permanent-delete selection. */
export function resolveTrashedSelection(
  catalog: Catalog,
  photoIds: readonly string[],
): string[] {
  return photoIds.filter((id) => {
    const photo = catalog.photos[id];
    return photo !== undefined && isTrashed(photo);
  });
}

/** Every R2 object belonging to a photo. */
export function objectKeysFor(photoId: string): string[] {
  return RENDITIONS.map((rendition) => photoObjectKey(photoId, rendition));
}
