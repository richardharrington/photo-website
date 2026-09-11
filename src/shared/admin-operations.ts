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
import { validateCaptionChanges, validatePhotoEdit } from './validation.ts';
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
  /**
   * The sender's Cloudflare address id, for a photograph that arrived by
   * email. Resolved server-side from the submission record — the browser
   * never supplies it — so a commit cannot attribute a photograph to
   * somebody who did not send it.
   */
  submittedBy?: string | null;
}

export type CommitOutcome =
  | { status: 'created'; photo: PhotoRecord }
  /**
   * The same source bytes are already in the catalog, trashed or not — and
   * which of the two it is decides what the administrator can be shown.
   * `/photo/<id>` is a 404 for a trashed photo by design, so the upload panel
   * has to point at the trash instead of offering a link that cannot work.
   */
  | { status: 'duplicate'; existingId: string; existingTrashed: boolean };

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
    return abortMutation({
      status: 'duplicate',
      existingId: duplicate.id,
      existingTrashed: duplicate.trashedAt !== null,
    });
  }

  const written = catalog.photos[input.id];
  if (written) {
    // A retried commit of a photo already written. Report it as the duplicate
    // it is rather than overwriting a record that may since have been edited.
    return abortMutation({
      status: 'duplicate',
      existingId: input.id,
      existingTrashed: written.trashedAt !== null,
    });
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
    submittedBy: input.submittedBy ?? null,
    batchSeq: input.batchSeq,
    selectionIndex: input.selectionIndex,
    // The commit instant, as for every photograph: it is when the photo became
    // visible, which is what Recently added groups by and what the digest
    // watermark compares against. Five emails from last week added in one
    // sitting are one sitting and one digest count, which is the truth of what
    // the family can see. The instant the mail arrived lives on the submission
    // record and in the audit trail, not here.
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

export type CaptionsOutcome =
  | {
      status: 'applied';
      /** The records as written, in request order. */
      updated: PhotoRecord[];
      /** The same photos as they were, index for index with `updated`. */
      previous: PhotoRecord[];
      /** Missing, trashed, or no longer carrying the caption `expected`. */
      skipped: string[];
    }
  | { status: 'invalid'; error: string };

/**
 * Replace several captions in one write, each only where the stored caption
 * is still the one the page showed.
 *
 * The `expected` check is what makes the bulk caption dialog honest: it lists
 * every caption that will be lost, and a caption changed in another tab since
 * cannot be lost without having been listed. It is also what lets Undo leave a
 * newer edit alone. Because `mutateCatalog` re-runs this against the fresh
 * catalog after a conflict, the checks are made again against whatever won.
 *
 * Captions only. The capture date, time, and `timestampSource` are untouched,
 * which is why this is not N calls to `editPhotoMetadata`.
 */
export function applyCaptions(
  catalog: Catalog,
  input: unknown,
  now: string,
  auditId: string,
): Mutation<CaptionsOutcome> {
  // Validated inside the mutation, as edits are, so no caller can skip it.
  const validated = validateCaptionChanges(input);
  if (!validated.ok) {
    return abortMutation({ status: 'invalid', error: validated.error });
  }

  const photos = { ...catalog.photos };
  const updated: PhotoRecord[] = [];
  const previous: PhotoRecord[] = [];
  const skipped: string[] = [];

  for (const { photoId, caption, expected } of validated.value) {
    const existing = photos[photoId];
    if (!existing || isTrashed(existing) || existing.caption !== expected) {
      skipped.push(photoId);
      continue;
    }
    // Already what was asked for: nothing to write, and nothing to report.
    if (existing.caption === caption) continue;

    const photo: PhotoRecord = {
      ...existing,
      caption,
      updatedAt: now,
      updatedAuditId: auditId,
    };
    photos[photoId] = photo;
    updated.push(photo);
    previous.push(existing);
  }

  const outcome: CaptionsOutcome = { status: 'applied', updated, previous, skipped };
  if (updated.length === 0) return abortMutation(outcome);
  return writeMutation({ ...catalog, photos }, outcome);
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
