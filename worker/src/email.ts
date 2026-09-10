/**
 * Inbound mail: the `email()` handler and everything it decides.
 *
 * A family member the administrator has switched on emails photographs to the
 * submission address. Cloudflare Email Routing hands the message to this
 * Worker, which checks two independent proofs, stores the image parts **byte
 * for byte and without decoding any of them**, and mails a receipt. Nothing
 * reaches the library until an administrator has looked at it in the Inbox and
 * run it through the browser pipeline like any other file.
 *
 * The rule in CLAUDE.md that does not move: the server stores an emailed
 * original and **never decodes, transforms, or serves it to a viewer**.
 * Decoding, orienting, colour conversion, resizing, encoding, and the EXIF
 * strip all still happen in the administrator's browser.
 *
 * `postal-mime` is imported here and nowhere else. Nothing under
 * `src/shared/` may reach for it: the pure rules — the authentication-header
 * parser, the part sniff, the caption proposal — are compiled by all three
 * tsconfigs and cannot depend on a Worker-only parser.
 */

import PostalMime from 'postal-mime';
import type { Email } from 'postal-mime';
import {
  INBOX_MAX_BYTES,
  INBOX_MAX_PARTS,
  MAX_SOURCE_BYTES,
} from '../../src/shared/constants.ts';
import { generatePhotoId } from '../../src/shared/ids.ts';
import { normalizeEmail } from '../../src/shared/notifications.ts';
import { authenticatesFor } from '../../src/shared/email-auth.ts';
import {
  SUBMISSION_SCHEMA_VERSION,
  firstBodyLine,
  proposeCaption,
  selectImageParts,
} from '../../src/shared/submissions.ts';
import type { Submission } from '../../src/shared/submissions.ts';
import { inboxUsage, storeSubmission } from '../../src/shared/inbox-repository.ts';
import { makeAuditEvent, writeAuditEvent } from '../../src/shared/audit.ts';
import { cloudflareAddresses } from '../../src/shared/cloudflare-addresses.ts';
import { loadNotificationState } from '../../src/shared/notifications-repository.ts';
import type { ObjectStore } from '../../src/shared/store.ts';
import type { FetchLike } from '../../src/shared/cloudflare-addresses.ts';
import type { SendEmailLike } from './digest.ts';

/**
 * The minimum shape of Cloudflare's `EmailMessage`, declared structurally.
 *
 * `@cloudflare/workers-types` has the real one, but the Worker's unit tests
 * compile under the browser tsconfig — the same reason `R2Like` and
 * `SendEmailLike` exist. A test satisfies this with an object literal.
 */
export interface EmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly headers: { get(name: string): string | null } & {
    /** Present on the real Headers; used to read *every* Authentication-Results. */
    getAll?(name: string): string[];
  };
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/**
 * Everything the handler needs, already checked, in the shape `digestDeps`
 * assembles for the digest. The handler never reads `env`, so it cannot
 * half-run on half a deployment.
 */
export interface SubmissionDeps {
  store: ObjectStore;
  email: SendEmailLike;
  fetch: FetchLike;
  accountId: string;
  /** The **read-only** addresses token. Nothing here needs the write-capable
   *  one, and giving the Worker that would be the mistake decisions.md #70
   *  exists to prevent. */
  apiToken: string;
  from: string;
  siteTitle: string;
  /** The full `submit@<domain>`; a message addressed anywhere else is dropped. */
  submitAddress: string;
  now: () => Date;
}

/**
 * Why a message was refused. Logged with the From **domain** only — never the
 * full address and never the subject.
 */
export type DropReason =
  | 'wrong-recipient'
  | 'unknown-sender'
  | 'unverified-sender'
  | 'not-a-submitter'
  | 'not-authenticated'
  | 'unreadable';

export type SubmissionOutcome =
  | { status: 'accepted'; submissionId: string; parts: number }
  /** Silently dropped: the Worker returns normally and the message is gone. */
  | { status: 'dropped'; reason: DropReason }
  /** `setReject` was called; the sender's provider turns it into a bounce. */
  | { status: 'bounced'; reason: 'no-photos' | 'inbox-full' };

const NO_PHOTOS_BOUNCE =
  'No photos were found in your message. Only JPEG, PNG and HEIC images can be ' +
  'added; please attach the photos themselves rather than a link or a document.';

const INBOX_FULL_BOUNCE =
  'Thank you, but the site is not accepting photos just now. Please try again ' +
  'in a few days.';

/**
 * Every `Authentication-Results` header, in order.
 *
 * Order is the whole of the security here: Cloudflare prepends its own, so the
 * first is the only one Cloudflare wrote, and a sender may attach as many more
 * as they like. `getAll` is the accurate reading; the fallback splits the
 * comma-joined value the Headers API produces when it is absent.
 */
export function authenticationResultsHeaders(
  headers: EmailMessageLike['headers'],
): string[] {
  if (typeof headers.getAll === 'function') {
    return headers.getAll('authentication-results');
  }
  const joined = headers.get('authentication-results');
  return joined === null ? [] : [joined];
}

/** Everything after the `@`, for a log line that names no individual. */
function domainForLog(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : 'unknown';
}

function log(event: string, fields: Record<string, unknown>): void {
  // Structured, and captured by the Worker's existing observability.
  // eslint-disable-next-line no-console
  console.log(event, JSON.stringify(fields));
}

/**
 * Every part of the message that might be a photograph.
 *
 * Attachments and inline parts alike — `postal-mime` puts both in
 * `attachments`, with `disposition` telling them apart, and this deliberately
 * does not look at that. Nor at the declared MIME type: only the bytes are
 * believed, in `selectImageParts`.
 */
function candidatesOf(parsed: Email): { filename: string | null; bytes: Uint8Array }[] {
  const candidates: { filename: string | null; bytes: Uint8Array }[] = [];

  for (const attachment of parsed.attachments) {
    const content = attachment.content;
    if (typeof content === 'string') continue;
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    candidates.push({ filename: attachment.filename ?? null, bytes });
  }

  return candidates;
}

/**
 * Handle one inbound message.
 *
 * The order of the checks is cheapest first, and each refusal is the email
 * analogue of the site's uniform 404: a silent drop teaches a prober nothing.
 * A bounce is reserved for senders who have already passed both proofs, so its
 * wording is feedback to family and an oracle to nobody.
 */
export async function handleSubmission(
  deps: SubmissionDeps,
  message: EmailMessageLike,
): Promise<SubmissionOutcome> {
  const fromDomain = domainForLog(message.from);

  // 1. Addressed to the submission address, and not to a catch-all rule that
  //    happens to point here.
  if (normalizeEmail(message.to) !== normalizeEmail(deps.submitAddress)) {
    log('Submission dropped', { reason: 'wrong-recipient', fromDomain });
    return { status: 'dropped', reason: 'wrong-recipient' };
  }

  const from = normalizeEmail(message.from);

  // 2. An allowed, verified, switched-on sender. Both reads are the ones the
  //    digest already does; no new permission and no new secret.
  const client = cloudflareAddresses(deps.fetch, deps.accountId, deps.apiToken);
  const addresses = await client.list();
  const address = addresses.find((candidate) => candidate.email === from);

  if (!address) {
    log('Submission dropped', { reason: 'unknown-sender', fromDomain });
    return { status: 'dropped', reason: 'unknown-sender' };
  }
  if (!address.verified) {
    log('Submission dropped', { reason: 'unverified-sender', fromDomain });
    return { status: 'dropped', reason: 'unverified-sender' };
  }

  const { state } = await loadNotificationState(deps.store);
  if (!state.recipients[from]?.canSubmit) {
    log('Submission dropped', { reason: 'not-a-submitter', fromDomain });
    return { status: 'dropped', reason: 'not-a-submitter' };
  }

  // 3. The message authenticates for that address's domain. Only the first
  //    Authentication-Results header, with Cloudflare's own authserv-id.
  const auth = authenticatesFor(authenticationResultsHeaders(message.headers), from);
  if (!auth.ok) {
    log('Submission dropped', {
      reason: 'not-authenticated',
      detail: auth.reason,
      // Present only for `foreign-authserv`, and only ever Cloudflare's own
      // hostname — never anything about the sender. `CLOUDFLARE_AUTHSERV_ID`
      // was guessed rather than measured, and if it was guessed wrong this
      // line is the whole diagnosis: every submission drops silently until the
      // constant matches what is printed here.
      ...(auth.sawAuthservId ? { sawAuthservId: auth.sawAuthservId } : {}),
      fromDomain,
    });
    return { status: 'dropped', reason: 'not-authenticated' };
  }

  // 4. The inbox has room. Counted from one list of the prefix: cheap,
  //    approximate, and enough to stop a compromised mailbox filling a bucket.
  const usage = await inboxUsage(deps.store);
  if (usage.parts >= INBOX_MAX_PARTS || usage.bytes >= INBOX_MAX_BYTES) {
    log('Submission bounced', { reason: 'inbox-full', fromDomain, ...usage });
    message.setReject(INBOX_FULL_BOUNCE);
    return { status: 'bounced', reason: 'inbox-full' };
  }

  // 5. Parse the MIME message. `raw` is a stream and is consumed exactly once.
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (error) {
    console.error(
      'Submission could not be parsed',
      JSON.stringify({ fromDomain }),
      error,
    );
    return { status: 'dropped', reason: 'unreadable' };
  }

  // 6. Which parts are photographs — sniffed, never declared.
  const selected = selectImageParts(candidatesOf(parsed), MAX_SOURCE_BYTES);
  if (selected.length === 0) {
    log('Submission bounced', { reason: 'no-photos', fromDomain });
    message.setReject(NO_PHOTOS_BOUNCE);
    return { status: 'bounced', reason: 'no-photos' };
  }

  const receivedAt = deps.now().toISOString();
  const subject = parsed.subject?.trim() || null;
  const bodyText = parsed.text ?? null;

  const submission: Submission = {
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    // Random and hex, like a photo id, and never derived from the message.
    id: generatePhotoId(),
    receivedAt,
    // The address id, never the address: `inbox/` is read by the admin
    // function and by the maintenance cron, and neither needs to see one.
    submittedBy: address.id,
    subject,
    proposedCaption: proposeCaption(subject, bodyText),
    bodyLine: firstBodyLine(bodyText),
    parts: selected.map((part) => ({
      index: part.index,
      filename: part.filename,
      contentType: part.contentType,
      bytes: part.bytes.byteLength,
    })),
    claim: null,
  };

  // 7. Parts, then the record. See `storeSubmission` for why that order.
  await storeSubmission(deps.store, submission, selected);

  // 8. The audit event carries no address and no subject.
  await writeAuditEvent(
    deps.store,
    makeAuditEvent('submission-received', [], {
      at: receivedAt,
      via: 'email',
      note:
        `submission ${submission.id}, ${submission.parts.length} parts, ` +
        `from address ${address.id}`,
    }),
  );

  // 9. The receipt, last. A failed send is logged and does not undo anything:
  //    the photographs are safely stored and the sender can be told by other
  //    means, whereas rolling back would lose them.
  try {
    await sendReceipt(deps, from, submission);
  } catch (error) {
    console.error(
      'Submission receipt could not be sent',
      JSON.stringify({ fromDomain }),
      error,
    );
  }

  log('Submission accepted', {
    submissionId: submission.id,
    parts: submission.parts.length,
    fromDomain,
  });

  return {
    status: 'accepted',
    submissionId: submission.id,
    parts: submission.parts.length,
  };
}

/**
 * The receipt.
 *
 * Plain text, no HTML, no images, and no link back to the site: the sender
 * already holds the display URL, and a receipt is not a place to put a
 * capability. It goes to a verified destination address in the account, so it
 * is free and needs nothing new. It is sent whether or not the sender also
 * receives the digest.
 */
async function sendReceipt(
  deps: SubmissionDeps,
  to: string,
  submission: Submission,
): Promise<void> {
  const count = submission.parts.length;
  const described = submission.subject ?? '(no subject)';

  await deps.email.send({
    from: { name: deps.siteTitle, email: deps.from },
    to,
    subject: `Got your photos for ${deps.siteTitle}`,
    text: [
      `${count} photo${count === 1 ? '' : 's'} from your message "${described}" ` +
        `arrived and will appear on ${deps.siteTitle} once they have been`,
      'looked at.',
      '',
      'If some of what you attached is missing from that count, it was not a',
      'JPEG, PNG or HEIC image.',
      '',
    ].join('\n'),
  });
}
