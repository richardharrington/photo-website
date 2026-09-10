/**
 * Reading, claiming, and removing emailed submissions in R2.
 *
 * The same shape as `catalog-repository.ts` and `notifications-repository.ts`:
 * every read is a plain `get`, and the one contended write — the claim — is an
 * ETag-guarded conditional write **through the store seam**. That matters more
 * here than anywhere else, because the two adapters disagree about what a lost
 * race looks like (the S3 path throws 412, the binding returns null), and a
 * try/catch around the claim would be right on one runtime and wrong on the
 * other.
 *
 * Compiled into all three targets, so no DOM, Node, or Workers globals.
 */

import { R2_KEYS, submissionPartKey, submissionRecordKey } from './constants.ts';
import { SUBMISSION_SCHEMA_VERSION, claimMatches, isClaimLive } from './submissions.ts';
import type { Submission, SubmissionPart } from './submissions.ts';
import { decodeJson, encodeJson } from './store.ts';
import type { ObjectStore } from './store.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The submission id a key under `inbox/` belongs to, or null. */
export function submissionIdFromKey(key: string): string | null {
  if (!key.startsWith(R2_KEYS.inboxPrefix)) return null;
  const rest = key.slice(R2_KEYS.inboxPrefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * 32 lowercase hex characters, like a photo id. Used to reject a malformed id
 * before any I/O, so nothing shaped like a path can reach a key.
 */
const SUBMISSION_ID_RE = /^[0-9a-f]{32}$/;

export function isValidSubmissionId(value: string): boolean {
  return SUBMISSION_ID_RE.test(value);
}

export interface LoadedSubmission {
  submission: Submission;
  etag: string;
}

/**
 * One submission, or null when there is no record.
 *
 * A record whose schema version is newer than this build understands is a hard
 * failure, as it is for the catalog and the notification state: acting on a
 * shape you cannot read is how a rollback destroys data.
 */
export async function loadSubmission(
  store: ObjectStore,
  submissionId: string,
): Promise<LoadedSubmission | null> {
  if (!isValidSubmissionId(submissionId)) return null;

  const stored = await store.get(submissionRecordKey(submissionId));
  if (!stored) return null;

  const submission = decodeJson<Submission>(stored.body);
  if (submission.schemaVersion > SUBMISSION_SCHEMA_VERSION) {
    throw new Error(
      `Submission schema version ${submission.schemaVersion} is not supported ` +
        `by this build (expected ${SUBMISSION_SCHEMA_VERSION}).`,
    );
  }

  return { submission, etag: stored.etag };
}

/**
 * Every submission waiting, newest first.
 *
 * The list is small by construction — the Worker bounces once the inbox is
 * over its cap, and the maintenance pass purges what nobody looked at — so
 * loading each record is a handful of reads rather than a scan.
 *
 * A part with no record is skipped silently: the Worker writes the parts
 * before the record, so that pair is a message caught mid-write, and the
 * retention purge is what eventually removes it.
 */
export async function listSubmissions(store: ObjectStore): Promise<Submission[]> {
  const objects = await store.list(R2_KEYS.inboxPrefix);

  const ids = new Set<string>();
  for (const object of objects) {
    if (!object.key.endsWith('/message.json')) continue;
    const id = submissionIdFromKey(object.key);
    if (id) ids.add(id);
  }

  const submissions: Submission[] = [];
  for (const id of ids) {
    const loaded = await loadSubmission(store, id);
    if (loaded) submissions.push(loaded.submission);
  }

  return submissions.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

/** Parts and record together, which is every object a submission owns. */
export function submissionObjectKeys(submission: Submission): string[] {
  return [
    ...submission.parts.map((part) => submissionPartKey(submission.id, part.index)),
    submissionRecordKey(submission.id),
  ];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Store one message: **parts first, then the record**.
 *
 * The order is the point. A record whose parts are missing is a card the Inbox
 * cannot render and cannot recover from; parts with no record are invisible
 * bytes the retention purge removes. Given that one of the two must be the
 * risk, it is the harmless one.
 *
 * The record is written with `ifAbsent`, and the id is freshly generated, so a
 * conflict here is a bug rather than a race — it is reported as one.
 */
export async function storeSubmission(
  store: ObjectStore,
  submission: Submission,
  parts: readonly { index: number; bytes: Uint8Array; contentType: string }[],
): Promise<void> {
  for (const part of parts) {
    await store.put(
      submissionPartKey(submission.id, part.index),
      part.bytes,
      part.contentType,
    );
  }

  const result = await store.putConditional(
    submissionRecordKey(submission.id),
    encodeJson(submission),
    { ifAbsent: true },
    JSON_CONTENT_TYPE,
  );

  if (!result.ok) {
    throw new Error(`Submission ${submission.id} already exists.`);
  }
}

export type ClaimOutcome =
  | { status: 'claimed'; submission: Submission }
  /** Another tab holds it and its claim has not expired. */
  | { status: 'held'; submission: Submission }
  /** The record moved under us; the caller reloads and decides again. */
  | { status: 'conflict' }
  | { status: 'not-found' };

/**
 * Take the claim on a submission, unless another tab still holds it.
 *
 * The conditional write is what makes this a claim rather than a hope: two
 * tabs reading the same unclaimed record both decide to take it, and only one
 * can win the write. The loser sees `conflict`, reloads, and finds the
 * winner's claim.
 *
 * Deliberately **not** wrapped in a try/catch, and deliberately reading
 * `result.ok` rather than "did it throw": that difference is the entire reason
 * the store seam exists (decisions.md #22).
 */
export async function claimSubmission(
  store: ObjectStore,
  submissionId: string,
  token: string,
  nowIso: string,
): Promise<ClaimOutcome> {
  const loaded = await loadSubmission(store, submissionId);
  if (!loaded) return { status: 'not-found' };

  const { submission, etag } = loaded;

  // An expired claim is overwritable — that is what Take over acts on — but a
  // live one belongs to whoever is working right now.
  if (
    isClaimLive(submission, Date.parse(nowIso)) &&
    submission.claim?.token !== token
  ) {
    return { status: 'held', submission };
  }

  const claimed: Submission = { ...submission, claim: { token, at: nowIso } };

  const result = await store.putConditional(
    submissionRecordKey(submissionId),
    encodeJson(claimed),
    { ifMatch: etag },
    JSON_CONTENT_TYPE,
  );

  if (!result.ok) return { status: 'conflict' };
  return { status: 'claimed', submission: claimed };
}

export type ResolveOutcome =
  | { status: 'removed'; submission: Submission }
  /** No such submission, or the token does not match the stored claim. Both
   *  are the uniform 404 above this. */
  | { status: 'refused' };

/**
 * Delete a submission's parts and its record.
 *
 * Used by both Add (once every ticked part has reached an outcome) and
 * Discard. The token is checked against the stored claim first, so a tab whose
 * claim was taken over cannot delete the work another tab is doing.
 */
export async function removeSubmission(
  store: ObjectStore,
  submissionId: string,
  token: string,
): Promise<ResolveOutcome> {
  const loaded = await loadSubmission(store, submissionId);
  if (!loaded) return { status: 'refused' };
  if (!claimMatches(loaded.submission, token)) return { status: 'refused' };

  await store.delete(submissionObjectKeys(loaded.submission));
  return { status: 'removed', submission: loaded.submission };
}

/** How many parts and bytes the inbox is holding right now. */
export interface InboxUsage {
  parts: number;
  bytes: number;
  messages: number;
}

/**
 * The inbox's size, from one `list` of the prefix.
 *
 * Approximate on purpose: it is a ceiling to stop a compromised mailbox
 * filling the bucket, not an accounting record, and paying a read per record
 * to sharpen it would cost more than the number is worth.
 */
export async function inboxUsage(store: ObjectStore): Promise<InboxUsage> {
  const objects = await store.list(R2_KEYS.inboxPrefix);

  let parts = 0;
  let bytes = 0;
  let messages = 0;

  for (const object of objects) {
    if (object.key.endsWith('/message.json')) {
      messages += 1;
      continue;
    }
    parts += 1;
    bytes += object.size;
  }

  return { parts, bytes, messages };
}

/** A part's stored size, for a record being rebuilt from stored objects. */
export function partDescriptors(
  parts: readonly {
    index: number;
    filename: string | null;
    contentType: string;
    bytes: Uint8Array;
  }[],
): SubmissionPart[] {
  return parts.map((part) => ({
    index: part.index,
    filename: part.filename,
    contentType: part.contentType,
    bytes: part.bytes.byteLength,
  }));
}
