/**
 * Admin API client.
 *
 * Three layers, each below this build's own opaque base. The reads are the
 * shared read client, unchanged: the admin renders the same timeline and the
 * same photo view the family does. The curation — uploading, editing, moving
 * to the trash, restoring — is the shared curation client, also unchanged,
 * because the family link does all of that through the same routes
 * (family-tier.md #3). What this module adds is only what the administrator
 * alone may do: bulk captions, the export, attribution, the Emails page, and
 * the Inbox. Permanent deletion is in the shared client, because the family
 * link deletes permanently what its own browser added (family-own-trash.md
 * 15).
 */

import { readApi, routes } from '../shared/ui/api.ts';
import { curationApi, post, request } from '../shared/ui/curation-api.ts';
import type { PublicPhoto } from '../shared/display-api.ts';
import type { CaptionChange } from '../shared/validation.ts';

export { routes };
export { ApiError } from '../shared/ui/curation-api.ts';
export type {
  CommitResult,
  PrepareResult,
  PreviewResult,
  TrashItem,
  TrashListing,
} from '../shared/ui/curation-api.ts';

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

export const adminApi = {
  // ---- Reads ------------------------------------------------------------
  // The viewer's own projections, verbatim.
  ...readApi,

  // ---- Curation ---------------------------------------------------------
  // Everything the family link may do too, through the same client.
  ...curationApi,

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

  // ---- Administrator-only curation --------------------------------------

  /**
   * The address that emailed a photograph in, or null.
   *
   * Its own request rather than a field on the timeline: it is wanted for one
   * photograph at a time, when the info panel is opened, and the projection
   * both apps read is a whitelist that must not grow a fact about senders.
   */
  attribution: async (photoId: string) =>
    (await request<{ email: string | null }>(`/attribution/${photoId}`)).email,

  /**
   * Several captions in one catalog write, each applied only where the stored
   * caption is still `expected`. The rest come back in `skipped`. `undo` only
   * labels the audit event; the server treats the changes the same either way.
   */
  captions: (changes: CaptionChange[], options: { undo?: boolean } = {}) =>
    post<{ updated: PublicPhoto[]; skipped: string[] }>('/captions', {
      changes,
      ...(options.undo ? { undo: true } : {}),
    }),

  exportUrl: () => routes.api('/export'),
};
