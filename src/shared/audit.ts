/**
 * The append-only audit log.
 *
 * Records what changed and when. It deliberately does not name a person:
 * administration is a shared URL secret, not an identity, so an "actor" field
 * would be a fabrication. Where an actor would normally go, this records the
 * surface the change came through.
 */

import { R2_KEYS } from './constants.ts';
import { generateAuditId } from './ids.ts';
import { encodeJson } from './store.ts';
import type { ObjectStore } from './store.ts';
import type { PhotoRecord } from './catalog.ts';

export type AuditAction =
  | 'upload'
  | 'metadata-change'
  | 'trash'
  | 'restore'
  | 'permanent-delete'
  | 'trash-purge'
  | 'orphan-sweep';

/** The metadata fields worth recording before and after a change. */
export interface AuditMetadata {
  captureDate: string | null;
  captureTime: string | null;
  caption: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction;
  photoIds: string[];
  /** How the change arrived. Not a claim about who made it. */
  via: 'admin-api' | 'scheduled-maintenance';
  before?: AuditMetadata;
  after?: AuditMetadata;
  note?: string;
}

export function auditMetadataOf(photo: PhotoRecord): AuditMetadata {
  return {
    captureDate: photo.captureDate,
    captureTime: photo.captureTime,
    caption: photo.caption,
  };
}

export function makeAuditEvent(
  action: AuditAction,
  photoIds: readonly string[],
  options: {
    at: string;
    via?: AuditEvent['via'];
    before?: AuditMetadata;
    after?: AuditMetadata;
    note?: string;
    id?: string;
  },
): AuditEvent {
  const event: AuditEvent = {
    id: options.id ?? generateAuditId(),
    at: options.at,
    action,
    photoIds: [...photoIds],
    via: options.via ?? 'admin-api',
  };
  if (options.before) event.before = options.before;
  if (options.after) event.after = options.after;
  if (options.note) event.note = options.note;
  return event;
}

/**
 * Audit keys are timestamp-then-random so they sort chronologically and two
 * events written in the same millisecond cannot overwrite each other. Each
 * event is its own object, which is what makes the log append-only: nothing
 * ever reads-modifies-writes it.
 */
export function auditKey(event: AuditEvent): string {
  return `${R2_KEYS.auditPrefix}${event.at.replace(/[:.]/g, '-')}-${event.id}.json`;
}

/**
 * Write one audit record.
 *
 * Audit records survive the photos they describe: a trash purge deletes the
 * objects and the catalog record, but its audit event stays.
 */
export async function writeAuditEvent(
  store: ObjectStore,
  event: AuditEvent,
): Promise<void> {
  await store.put(
    auditKey(event),
    encodeJson(event),
    'application/json; charset=utf-8',
  );
}
