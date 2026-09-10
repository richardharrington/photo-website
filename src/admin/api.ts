/**
 * Admin API client.
 *
 * The reads are the shared read client, unchanged: the admin renders the same
 * timeline and the same photo view the viewer does, so it asks for exactly
 * what the viewer asks for. What this module adds is the mutations, and the
 * error parsing they need — an admin acts on the library and has to be told
 * why something was refused, where a viewer only ever reads.
 *
 * Both halves live below this build's own opaque base.
 */

import { readApi, routes } from '../shared/ui/api.ts';
import { NotFoundError } from '../shared/ui/useResource.ts';
import type { PublicPhoto } from '../shared/display-api.ts';
import type { PhotoEdit } from '../shared/ui/curation.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';
import type { Rendition } from '../shared/constants.ts';
import type { DerivativeDescriptor } from '../shared/catalog.ts';

export { routes };

/** A rejection the API explains, as opposed to a bare failure. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(routes.api(path), {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
    credentials: 'omit',
  });

  if (response.status === 404) throw new NotFoundError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
}

export interface PrepareResult {
  status: 'duplicate' | 'ready';
  existingId?: string;
  /** Set with `existingId`: the duplicate is in the trash, not the library. */
  existingTrashed?: boolean;
  photoId?: string;
  downloadFilename?: string;
  uploads?: Record<Rendition, string>;
}

export interface CommitResult {
  status: 'created' | 'duplicate';
  existingId?: string;
  /** Set with `existingId`: the duplicate is in the trash, not the library. */
  existingTrashed?: boolean;
  photo?: PublicPhoto;
}

export interface PreviewResult {
  photoIds: string[];
  count: number;
  expiresAt: number;
  token: string;
}

export interface TrashItem {
  photo: PublicPhoto;
  trashedAt: string;
  /** Short-lived signed URLs: a trashed photo has no capability URL. */
  thumbnailUrl: string;
  previewUrl: string;
}

/**
 * One row of the Notifications page: Cloudflare's address merged with the R2
 * state file. `verified` is Cloudflare's answer alone; the rest is ours.
 */
export interface Recipient {
  id: string;
  email: string;
  verified: boolean;
  enabled: boolean;
  /** Mail from this address is accepted into the Inbox. */
  canSubmit: boolean;
  /** This administrator's digest reports a non-empty Inbox. */
  reviewsInbox: boolean;
  lastSent: { at: string; count: number } | null;
}

/** One part of an emailed message, as the Inbox lists it. */
export interface InboxPart {
  index: number;
  filename: string | null;
  /** Sniffed, not declared: what the bytes actually are. */
  contentType: string;
  bytes: number;
}

/** One card on the Inbox page: a message, its parts, and its claim. */
export interface InboxSubmission {
  id: string;
  receivedAt: string;
  /** Null when Cloudflare no longer holds the sender's address. */
  from: string | null;
  subject: string | null;
  proposedCaption: string | null;
  bodyLine: string | null;
  parts: InboxPart[];
  claimedAt: string | null;
  claimExpired: boolean;
}

export interface InboxListing {
  submissions: InboxSubmission[];
  claimTtlMinutes: number;
}

export type ClaimResult =
  | { status: 'claimed' }
  /** Another tab holds it; `claimedAt` is when they started. */
  | { status: 'held'; claimedAt: string | null; claimAgeMs: number | null }
  /** The record moved between the read and the write; reload and look again. */
  | { status: 'conflict' };

export interface InboxPartUrl {
  url: string;
  contentType: string;
  bytes: number;
  expiresAt: string;
}

export interface TrashListing {
  items: TrashItem[];
  /** When the signed URLs above stop working. */
  expiresAt: string;
}

export const adminApi = {
  // ---- Reads ------------------------------------------------------------
  // The viewer's own projections, verbatim.
  ...readApi,

  trash: (signal?: AbortSignal) =>
    request<TrashListing>('/trash', { signal: signal ?? null }),

  trashCount: (signal?: AbortSignal) =>
    request<{ count: number }>('/trash/count', { signal: signal ?? null }),

  // ---- Emails -----------------------------------------------------------
  // Every action refetches the whole list rather than patching a row: the
  // truth is Cloudflare's, the list is tiny, and a verification that landed
  // between two clicks should show up.

  emails: (signal?: AbortSignal) =>
    request<{ recipients: Recipient[] }>('/emails', { signal: signal ?? null }),

  addRecipient: (email: string) =>
    post<{ recipient: Recipient }>('/emails/add', { email }),

  removeRecipient: (id: string) => post<{ removed: string }>('/emails/remove', { id }),

  setRecipientEnabled: (email: string, enabled: boolean) =>
    post<{ recipient: Recipient }>('/emails/set-enabled', { email, enabled }),

  setRecipientCanSubmit: (email: string, canSubmit: boolean) =>
    post<{ recipient: Recipient }>('/emails/set-submit', { email, canSubmit }),

  setRecipientReviewsInbox: (email: string, reviewsInbox: boolean) =>
    post<{ recipient: Recipient }>('/emails/set-reviews', { email, reviewsInbox }),

  // ---- Inbox ------------------------------------------------------------
  // Emailed submissions waiting to be looked at. Every mutation refetches the
  // listing rather than patching a card: a claim taken in another tab should
  // show up the moment anything else is done here.

  inbox: (signal?: AbortSignal) =>
    request<InboxListing>('/inbox', { signal: signal ?? null }),

  inboxCount: (signal?: AbortSignal) =>
    request<{ count: number }>('/inbox/count', { signal: signal ?? null }),

  /** A five-minute presigned GET for one raw part, straight from R2. */
  inboxPartUrl: (submissionId: string, part: number) =>
    request<InboxPartUrl>(
      `/inbox/part-url?submission=${encodeURIComponent(submissionId)}&part=${part}`,
    ),

  claimSubmission: (submissionId: string, claimToken: string) =>
    post<ClaimResult>('/inbox/claim', { submissionId, claimToken }),

  /** Adding finished: delete the raw parts and the record, and audit what
   *  came out of it. */
  resolveSubmission: (submissionId: string, claimToken: string, photoIds: string[]) =>
    post<{ status: 'removed' }>('/inbox/resolve', {
      submissionId,
      claimToken,
      photoIds,
    }),

  discardSubmission: (submissionId: string, claimToken: string) =>
    post<{ status: 'removed' }>('/inbox/discard', { submissionId, claimToken }),

  /** Tonight's digest for one address, sent now and marked as a test. */
  sendTest: (email: string) => post<{ count: number }>('/emails/test', { email }),

  // ---- Upload flow ------------------------------------------------------
  beginBatch: () => post<{ batchSeq: number }>('/begin-batch', {}),

  prepare: (contentHash: string, originalFilename: string) =>
    post<PrepareResult>('/prepare', { contentHash, originalFilename }),

  commit: (body: {
    photoId: string;
    contentHash: string;
    originalFilename: string;
    sourceMimeType: string;
    captureDate: string | null;
    captureTime: string | null;
    captureUtcOffset: string | null;
    timestampSource: string;
    caption: string | null;
    batchSeq: number;
    selectionIndex: number;
    derivatives: Record<Rendition, DerivativeDescriptor>;
    /** Set for a photograph coming out of the Inbox. The server resolves the
     *  sender from the record; the browser never supplies one. */
    submissionId?: string;
    claimToken?: string;
  }) => post<CommitResult>('/commit', body),

  // ---- Curation ---------------------------------------------------------

  /**
   * The address that emailed a photograph in, or null.
   *
   * Its own request rather than a field on the timeline: it is wanted for one
   * photograph at a time, when the info panel is opened, and the projection
   * both apps read is a whitelist that must not grow a fact about senders.
   */
  attribution: async (photoId: string) =>
    (await request<{ email: string | null }>(`/attribution/${photoId}`)).email,

  edit: (photoId: string, edit: PhotoEdit) =>
    post<{ photo: PublicPhoto }>('/edit', { photoId, ...edit }),

  /**
   * Both halves of a destructive action. The preview resolves a selection to
   * an explicit ID list and returns a token bound to it; the confirm sends
   * that same list back. A photo committed in between is not in the list the
   * token covers (decisions.md #12).
   */
  previewTrash: (selection: SelectionQuery) =>
    post<PreviewResult>('/trash/preview', { selection }),

  confirmTrash: (preview: PreviewResult) =>
    post<{ trashed: string[]; count: number }>('/trash/confirm', {
      photoIds: preview.photoIds,
      expiresAt: preview.expiresAt,
      token: preview.token,
    }),

  previewPermanentDelete: (photoIds: string[]) =>
    post<PreviewResult>('/permanent-delete/preview', {
      selection: { kind: 'ids', photoIds },
    }),

  confirmPermanentDelete: (preview: PreviewResult) =>
    post<{ deleted: string[]; count: number }>('/permanent-delete/confirm', {
      photoIds: preview.photoIds,
      expiresAt: preview.expiresAt,
      token: preview.token,
    }),

  /** The Undo behind a just-completed trash action. */
  restore: (photoIds: string[]) =>
    post<{ restored: string[]; count: number }>('/restore', { photoIds }),

  exportUrl: () => routes.api('/export'),
};
