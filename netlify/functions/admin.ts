/**
 * The admin API: catalog reads and mutations only.
 *
 * It answers everything the display API does — the read routes and the
 * curation routes in `lib/curation-routes.ts`, through the same code — plus
 * what only the administrator may do: bulk captions, the catalog export,
 * attribution, the Emails page, and the Inbox. Permanent deletion is a
 * curation route now, which the family link reaches for what its own browser
 * added (family-own-trash.md 15). Those are
 * handled in this file and nowhere else, which is what keeps them out of
 * display mode (family-tier.md #2, #4).
 *
 * It never touches image bytes. The browser encodes the four artifacts and
 * PUTs them straight to R2 with the presigned URLs this issues; the server's
 * whole role is to hand out those URLs, verify the objects landed, and
 * maintain the catalog.
 */

import {
  INBOX_CLAIM_TTL_MINUTES,
  SIGNED_URL_TTL_SECONDS,
  submissionPartKey,
} from '../../src/shared/constants.ts';
import { getLivePhoto } from '../../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../../src/shared/catalog-repository.ts';
import { applyCaptions } from '../../src/shared/admin-operations.ts';
import { makeAuditEvent, writeAuditEvent } from '../../src/shared/audit.ts';
import { generateAuditId, isValidPhotoId } from '../../src/shared/ids.ts';
import {
  NOTIFICATION_TEST_TTL_SECONDS,
  assetGrantPath,
  signAssetGrant,
  signNotificationTest,
} from '../../src/shared/signing.ts';
import {
  cloudflareAddresses,
  CloudflareApiError,
} from '../../src/shared/cloudflare-addresses.ts';
import type { FetchLike } from '../../src/shared/cloudflare-addresses.ts';
import {
  isValidEmailAddress,
  newRecipient,
  normalizeEmail,
} from '../../src/shared/notifications.ts';
import type {
  DestinationAddress,
  NotificationState,
  RecipientState,
} from '../../src/shared/notifications.ts';
import {
  loadNotificationState,
  mutateNotificationState,
} from '../../src/shared/notifications-repository.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import {
  claimSubmission,
  isValidSubmissionId,
  listSubmissions,
  loadSubmission,
  removeSubmission,
} from '../../src/shared/inbox-repository.ts';
import { claimAgeMs, isClaimLive } from '../../src/shared/submissions.ts';
import type { Submission } from '../../src/shared/submissions.ts';
import type { ObjectStore } from '../../src/shared/store.ts';
import { S3ObjectStore, s3Config } from './lib/s3-store.ts';
import { readRoute } from './lib/read-routes.ts';
import { curationRoute } from './lib/curation-routes.ts';
import { presignedGetUrl } from './lib/presign.ts';
import {
  badRequest,
  checkAccess,
  json,
  notFound,
  nowIso,
  nowMs,
  nowSeconds,
  readJson,
  requiredEnv,
  serverError,
  subPath,
} from './lib/http.ts';

/**
 * How long to wait on the Worker for a test send.
 *
 * Netlify gives a synchronous function ten seconds, so this cannot simply be
 * unbounded — but it has to cover the Worker's whole round trip: Cloudflare's
 * address list, two R2 reads, and then handing the message to the recipient's
 * mail servers, which is the slow and variable part. Five seconds was not
 * enough for every destination, and the failure was the worst shape available:
 * the mail arrived and the page said it had not.
 */
const TEST_SEND_TIMEOUT_MS = 8_000;

/**
 * The handler, over whichever store it is given. Production binds it to R2
 * below; the whitelist test binds it to an in-memory store.
 */
export function createHandler(store: () => ObjectStore) {
  return async function handler(request: Request): Promise<Response> {
    const refusal = checkAccess(request, 'admin');
    if (refusal) return refusal;

    const path = subPath(request, 'admin');
    const method = request.method;

    try {
      if (method === 'GET' && path === '/export') return exportCatalog(store);
      if (method === 'GET' && path === '/emails') return listEmails(store);
      if (method === 'GET' && path === '/inbox') return listInbox(store);
      if (method === 'GET' && path === '/inbox/count') return inboxCount(store);
      if (method === 'GET' && path === '/inbox/part-url') {
        return inboxPartUrl(new URL(request.url), store);
      }

      const download = /^\/download\/([0-9a-f]{32})$/.exec(path);
      if (method === 'GET' && download) return downloadLink(download[1]!, store);

      const attribution = /^\/attribution\/([0-9a-f]{32})$/.exec(path);
      if (method === 'GET' && attribution) {
        return photoAttribution(attribution[1]!, store);
      }

      // Everything the family link may do, answered by the same module the
      // display function uses. Before the reads only so a trash listing does not
      // load the catalog twice; the route lists are disjoint.
      const curation = await curationRoute(request, path, 'admin', store);
      if (curation) return curation;

      // The admin app browses through the viewer's own projections; see
      // lib/read-routes.ts for why both functions must answer these.
      if (method === 'GET') {
        const { catalog } = await loadCatalog(store(), nowIso);
        const read = readRoute(catalog, path, nowMs());
        if (read) return read;
      }

      if (method !== 'POST') return notFound();

      switch (path) {
        case '/captions':
          return await handleCaptions(request, store);
        case '/emails/add':
          return await handleAddRecipient(request, store);
        case '/emails/remove':
          return await handleRemoveRecipient(request, store);
        case '/emails/set-enabled':
          return await handleSetEnabled(request, 'enabled', store);
        case '/emails/set-submit':
          return await handleSetEnabled(request, 'canSubmit', store);
        case '/emails/set-reviews':
          return await handleSetEnabled(request, 'reviewsInbox', store);
        case '/inbox/claim':
          return await handleInboxClaim(request, store);
        case '/inbox/resolve':
          return await handleInboxResolve(request, 'accepted', store);
        case '/inbox/discard':
          return await handleInboxResolve(request, 'discarded', store);
        case '/emails/test':
          return await handleSendTest(request);
        default:
          return notFound();
      }
    } catch (error) {
      // Cloudflare knows why it refused an address and this code does not, so
      // its wording reaches the administrator rather than a generic failure.
      if (error instanceof CloudflareApiError) return badRequest(error.message);
      console.error('Admin API failure', error);
      return serverError();
    }
  };
}

export default createHandler(() => new S3ObjectStore(s3Config()));

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

interface CaptionsBody {
  changes?: unknown;
  undo?: unknown;
}

/**
 * Several captions in one catalog write, each applied only where the stored
 * caption is still the one the page showed (decisions.md #89). A photo that
 * fails that check is reported back rather than overwritten.
 *
 * One audit event for the request however many photos it touched, written
 * after the catalog write for the same reason `handleEdit`'s is: an event for
 * a write that lost its race would record something that never happened.
 */
async function handleCaptions(
  request: Request,
  store: () => ObjectStore,
): Promise<Response> {
  const body = await readJson<CaptionsBody>(request);
  if (!body) return badRequest('A list of caption changes is required.');

  const objectStore = store();
  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    applyCaptions(catalog, body.changes, at, auditId),
  );

  if (outcome.status === 'invalid') return badRequest(outcome.error);

  if (outcome.updated.length > 0) {
    await writeAuditEvent(
      objectStore,
      makeAuditEvent(
        'caption-change',
        outcome.updated.map((photo) => photo.id),
        {
          at,
          id: auditId,
          changes: outcome.updated.map((photo, index) => ({
            photoId: photo.id,
            before: outcome.previous[index]!.caption,
            after: photo.caption,
          })),
          note: body.undo === true ? 'undo' : undefined,
        },
      ),
    );
  }

  return json({
    updated: outcome.updated.map(toPublicPhoto),
    skipped: outcome.skipped,
  });
}

// ---------------------------------------------------------------------------
// Permanent deletion: preview, then confirm against an explicit ID list
// ---------------------------------------------------------------------------

/**
 * A short-lived signed URL for the full-resolution JPEG.
 *
 * The admin needs its own copy of this rather than reaching into the display
 * function, because the two are reachable only through their own secret paths.
 * Trashed photos are refused here exactly as they are for a viewer.
 */
async function downloadLink(
  photoId: string,
  store: () => ObjectStore,
): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  const photo = getLivePhoto(catalog, photoId);
  if (!photo) return notFound();

  const grant = {
    photoId: photo.id,
    rendition: 'full',
    expiresAt: nowSeconds() + SIGNED_URL_TTL_SECONDS,
  };
  const signature = await signAssetGrant(requiredEnv('ASSET_SIGNING_KEY'), grant);
  const workerBase = requiredEnv('WORKER_BASE_URL').replace(/\/+$/, '');

  return json({
    url: `${workerBase}${assetGrantPath(grant, signature)}`,
    expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
    filename: photo.downloadFilename,
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The provider-independent curation export: the catalog exactly as stored. */
async function exportCatalog(store: () => ObjectStore): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  return new Response(JSON.stringify(catalog, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="photo-catalog-${catalog.updatedAt.slice(0, 10)}.json"`,
      'cache-control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// ---------------------------------------------------------------------------
// Emails: the recipient list, the three switches, and the test send
// ---------------------------------------------------------------------------

/**
 * The recipient list is Cloudflare's, not ours.
 *
 * The account's destination-address list *is* the list, and whether an address
 * has verified is Cloudflare's answer alone. R2 holds only what Cloudflare
 * cannot: whether the digest goes to an address, and how far it has been told
 * about (decisions.md, "Notifications").
 *
 * `R2_ACCOUNT_ID` is reused rather than joined by a second name for the same
 * value: the addresses live in the account that holds the bucket.
 */
function addressClient() {
  return cloudflareAddresses(
    // The global is read here, at the runtime edge, and passed down — nothing
    // under src/shared/ reaches for it.
    globalThis.fetch as unknown as FetchLike,
    requiredEnv('R2_ACCOUNT_ID'),
    requiredEnv('CLOUDFLARE_ADDRESSES_WRITE_TOKEN'),
  );
}

interface RecipientRow {
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

/**
 * One row of the Notifications page.
 *
 * A verified address with no state entry is shown as switched off rather than
 * hidden. That is what makes the write order in `add` safe: if the R2 write
 * fails after the Cloudflare one, the address still appears, and the cron
 * reads the same missing entry the same way.
 */
function recipientRow(
  address: DestinationAddress,
  state: NotificationState,
): RecipientRow {
  const recipient = state.recipients[address.email];
  return {
    id: address.id,
    email: address.email,
    verified: address.verified,
    enabled: recipient?.enabled ?? false,
    canSubmit: recipient?.canSubmit ?? false,
    reviewsInbox: recipient?.reviewsInbox ?? false,
    lastSent: recipient?.lastSent ?? null,
  };
}

async function listEmails(store: () => ObjectStore): Promise<Response> {
  const [addresses, { state }] = await Promise.all([
    addressClient().list(),
    loadNotificationState(store()),
  ]);

  // Deliberately read-only: an entry whose address Cloudflare no longer holds
  // is already invisible here, and pruning it is the next write's business.
  return json({
    recipients: addresses.map((address) => recipientRow(address, state)),
  });
}

/** One address, lowercased, or the refusal to send back. */
function readEmail(value: unknown): string | Response {
  if (typeof value !== 'string') return badRequest('An email address is required.');
  const email = normalizeEmail(value);
  if (!isValidEmailAddress(email)) return badRequest('That is not an email address.');
  return email;
}

interface AddBody {
  email?: unknown;
}

/**
 * Add an address: Cloudflare first, then R2.
 *
 * Creating it at Cloudflare is what sends the verification email — there is no
 * separate "invite" step, and nothing is sent to the address until its owner
 * clicks that link. The order matters: if the second write fails the state is
 * at worst missing an entry, which reads as switched off. The other order
 * would leave a state entry for an address that does not exist.
 */
async function handleAddRecipient(
  request: Request,
  store: () => ObjectStore,
): Promise<Response> {
  const body = await readJson<AddBody>(request);
  const email = readEmail(body?.email);
  if (email instanceof Response) return email;

  const address = await addressClient().create(email);
  const at = nowIso();

  await mutateNotificationState(store(), (state) => ({
    state: {
      ...state,
      recipients: {
        ...state.recipients,
        // Every switch starts off, the digest included; each is a deliberate
        // decision on the Emails page, and verifying the address changes
        // none of them. Turning the digest on later restarts the clock, so the
        // first digest never announces the library that was already there.
        [address.email]: newRecipient(at),
      },
    },
    value: undefined,
  }));

  return json({
    recipient: {
      id: address.id,
      email: address.email,
      verified: address.verified,
      enabled: false,
      canSubmit: false,
      reviewsInbox: false,
      lastSent: null,
    } satisfies RecipientRow,
  });
}

interface RemoveBody {
  id?: unknown;
}

/**
 * Remove an address. A POST rather than a DELETE because this function accepts
 * only GET and POST.
 *
 * The state entry goes with it and is not kept: an address deleted and re-added
 * gets a new Cloudflare id, and its old watermark should not survive that.
 */
async function handleRemoveRecipient(
  request: Request,
  store: () => ObjectStore,
): Promise<Response> {
  const body = await readJson<RemoveBody>(request);
  if (typeof body?.id !== 'string' || body.id === '') {
    return badRequest('An address id is required.');
  }

  const client = addressClient();
  const address = (await client.list()).find((candidate) => candidate.id === body.id);
  if (!address) return notFound();

  await client.remove(address.id);

  await mutateNotificationState(store(), (state) => {
    if (!state.recipients[address.email]) return { state, value: undefined };
    const recipients = { ...state.recipients };
    delete recipients[address.email];
    return { state: { ...state, recipients }, value: undefined };
  });

  return json({ removed: address.email });
}

interface SetSwitchBody {
  email?: unknown;
  enabled?: unknown;
  canSubmit?: unknown;
  reviewsInbox?: unknown;
}

/** Which of the three switches a row's endpoint sets. */
type SwitchName = 'enabled' | 'canSubmit' | 'reviewsInbox';

/**
 * Switch one of the three bits on or off for one address.
 *
 * The three are independent in every combination: digest on and cannot submit,
 * submit on and no digest, both, neither. One handler because the validation,
 * the refusal for an address Cloudflare does not hold, and the reply are the
 * same for all three; only the field and the watermark rule differ.
 *
 * For `enabled`, going off→on sets `seenThrough` to now, always. Turning an
 * address off and on again never backfills: the switch means "from here on",
 * not "catch me up". The other two never touch the watermark.
 *
 * Switching `canSubmit` off does **not** remove submissions already waiting in
 * the Inbox. They were accepted in good standing, and the administrator
 * decides them there.
 */
async function handleSetEnabled(
  request: Request,
  which: SwitchName,
  store: () => ObjectStore,
): Promise<Response> {
  const body = await readJson<SetSwitchBody>(request);
  const email = readEmail(body?.email);
  if (email instanceof Response) return email;

  const value = body?.[which];
  if (typeof value !== 'boolean') return badRequest(`${which} must be a boolean.`);

  const at = nowIso();

  const addresses = await addressClient().list();
  const address = addresses.find((candidate) => candidate.email === email);
  if (!address) return notFound();
  // The same rule as the digest's: the switch is inert until Cloudflare has
  // the confirmation, so an unverified address cannot be given either new
  // capability through a request that skipped the page.
  if (!address.verified) return notFound();

  const state = await mutateNotificationState(store(), (current) => {
    const existing: RecipientState = current.recipients[email] ?? newRecipient(at);
    const startingDigest = which === 'enabled' && value && !existing.enabled;

    const next: RecipientState = {
      ...existing,
      [which]: value,
      // Only when the digest's clock actually starts. Switching off, setting
      // on to on, or touching either of the other two, leaves the watermark
      // exactly where it was.
      seenThrough: startingDigest ? at : existing.seenThrough,
    };
    const updated: NotificationState = {
      ...current,
      recipients: { ...current.recipients, [email]: next },
    };
    return { state: updated, value: updated };
  });

  return json({ recipient: recipientRow(address, state) });
}

interface TestBody {
  email?: unknown;
}

/**
 * "Send test": ask the Worker to send tonight's digest for one address now.
 *
 * Only the Worker holds the send binding, and it has no authentication of its
 * own, so this signs a sixty-second grant over the address and posts it. The
 * Worker answers 404 to anything it will not do, which is deliberate — but it
 * makes a hung Worker indistinguishable from a slow one, so the fetch carries
 * its own deadline well inside Netlify's ten seconds.
 */
async function handleSendTest(request: Request): Promise<Response> {
  const body = await readJson<TestBody>(request);
  const email = readEmail(body?.email);
  if (email instanceof Response) return email;

  const expiresAt = nowSeconds() + NOTIFICATION_TEST_TTL_SECONDS;
  const sig = await signNotificationTest(requiredEnv('ASSET_SIGNING_KEY'), {
    email,
    expiresAt,
  });
  const workerBase = requiredEnv('WORKER_BASE_URL').replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetch(`${workerBase}/notify/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, exp: expiresAt, sig }),
      signal: AbortSignal.timeout(TEST_SEND_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('Test send could not reach the Worker', error);

    // A timeout and a refused connection are different facts and the
    // difference matters here: on a timeout the Worker may well have sent the
    // message, so telling the administrator it failed invites a second one.
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return serverError(
        `The mail Worker did not answer within ${TEST_SEND_TIMEOUT_MS / 1000} ` +
          'seconds. It may still have sent — check the inbox before trying again.',
      );
    }

    return serverError('The test could not be sent. The mail Worker did not answer.');
  }

  if (!response.ok) {
    // The Worker refuses with a plain 404 whether the address is unverified,
    // the grant is stale, or notifications are unconfigured — so this is the
    // most it can honestly say.
    return serverError(
      'The test could not be sent. Check that the address is verified and ' +
        'that the mail Worker is configured.',
    );
  }

  const result = (await response.json().catch(() => null)) as {
    count?: unknown;
  } | null;
  return json({ count: typeof result?.count === 'number' ? result.count : 0 });
}

/**
 * Who emailed this photograph in, as an address.
 *
 * The catalog holds a Cloudflare address **id**, and the resolution happens
 * here rather than in the browser so no id reaches it either. A photograph
 * that was dropped, one whose sender Cloudflare no longer holds, and one that
 * does not exist all answer `null`: the admin's photo view has one line to
 * show or none, and there is nothing useful to say about the difference.
 *
 * Deliberately its own route rather than a field on the projection. The
 * projection is a whitelist the viewer receives, and this is a fact about how
 * a photograph arrived, which is none of a viewer's business.
 */
async function photoAttribution(
  photoId: string,
  store: () => ObjectStore,
): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  const submittedBy = catalog.photos[photoId]?.submittedBy ?? null;
  if (!submittedBy) return json({ email: null });

  const addresses = await addressClient().list();
  const address = addresses.find((candidate) => candidate.id === submittedBy);
  return json({ email: address?.email ?? null });
}

// ---------------------------------------------------------------------------
// The Inbox
// ---------------------------------------------------------------------------

/**
 * One card on the Inbox page.
 *
 * The sender is resolved here, from the address list Cloudflare holds, because
 * the record carries only an address **id** — `inbox/` is read by this
 * function and by the maintenance cron, and neither should have to see an
 * email address to do its job. A sender since removed from Cloudflare has no
 * address to resolve to, and the page says so rather than showing an id.
 *
 * The From display name is never used for anything here: it is
 * sender-controlled text that never left the message.
 */
interface InboxRow {
  id: string;
  receivedAt: string;
  /** The sender's address, or null when Cloudflare no longer holds it. */
  from: string | null;
  subject: string | null;
  proposedCaption: string | null;
  bodyLine: string | null;
  parts: {
    index: number;
    filename: string | null;
    contentType: string;
    bytes: number;
  }[];
  /** Another tab is adding this right now; its controls stand down. */
  claimedAt: string | null;
  /** That claim has expired, so this card offers Take over. */
  claimExpired: boolean;
}

function inboxRow(
  submission: Submission,
  addressesById: ReadonlyMap<string, DestinationAddress>,
  atMs: number,
): InboxRow {
  const live = isClaimLive(submission, atMs);
  return {
    id: submission.id,
    receivedAt: submission.receivedAt,
    from: addressesById.get(submission.submittedBy)?.email ?? null,
    subject: submission.subject,
    proposedCaption: submission.proposedCaption,
    bodyLine: submission.bodyLine,
    parts: submission.parts,
    claimedAt: submission.claim?.at ?? null,
    claimExpired: submission.claim !== null && !live,
  };
}

async function listInbox(store: () => ObjectStore): Promise<Response> {
  const [submissions, addresses] = await Promise.all([
    listSubmissions(store()),
    addressClient().list(),
  ]);

  const byId = new Map(addresses.map((address) => [address.id, address]));
  const at = nowMs();

  return json({
    submissions: submissions.map((submission) => inboxRow(submission, byId, at)),
    claimTtlMinutes: INBOX_CLAIM_TTL_MINUTES,
  });
}

/**
 * Just the number, for the header's Inbox link.
 *
 * Separate from `listInbox` so a page view does not also fetch Cloudflare's
 * address list, exactly as `trashCount` is separate from `listTrash`.
 */
async function inboxCount(store: () => ObjectStore): Promise<Response> {
  const submissions = await listSubmissions(store());
  return json({ count: submissions.length });
}

/**
 * A short-lived presigned GET for one raw part.
 *
 * The browser fetches it directly, twice: a `Range: bytes=0-…` request for the
 * embedded EXIF thumbnail, and a full fetch on Add. The part is never decoded
 * here or served through the Worker — the server stores an emailed original
 * and does nothing else with it.
 *
 * Every refusal is the uniform 404, including an index that names no stored
 * part: a URL must not be signable for a key that does not exist.
 */
async function inboxPartUrl(url: URL, store: () => ObjectStore): Promise<Response> {
  const submissionId = url.searchParams.get('submission') ?? '';
  const index = Number(url.searchParams.get('part'));
  if (!isValidSubmissionId(submissionId)) return notFound();
  if (!Number.isInteger(index) || index < 0) return notFound();

  const loaded = await loadSubmission(store(), submissionId);
  if (!loaded) return notFound();
  const part = loaded.submission.parts.find((candidate) => candidate.index === index);
  if (!part) return notFound();

  const signed = await presignedGetUrl(
    s3Config(),
    submissionPartKey(submissionId, index),
    SIGNED_URL_TTL_SECONDS,
  );

  return json({
    url: signed,
    contentType: part.contentType,
    bytes: part.bytes,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  });
}

interface ClaimBody {
  submissionId?: unknown;
  claimToken?: unknown;
}

function readClaim(body: ClaimBody | null): { id: string; token: string } | null {
  const id = typeof body?.submissionId === 'string' ? body.submissionId : '';
  const token = typeof body?.claimToken === 'string' ? body.claimToken : '';
  if (!isValidSubmissionId(id)) return null;
  // A token is opaque to this tier; it only has to be present and bounded.
  if (token.length < 8 || token.length > 128) return null;
  return { id, token };
}

/**
 * Take the claim on a submission before adding it.
 *
 * The tab mints its own token and presents it; the conditional write inside
 * `claimSubmission` decides who gets it. A live claim held by another tab is
 * reported as `held` with its age, which is what lets the page say "being
 * added in another tab, started 3 minutes ago" rather than simply failing.
 */
async function handleInboxClaim(
  request: Request,
  store: () => ObjectStore,
): Promise<Response> {
  const claim = readClaim(await readJson<ClaimBody>(request));
  if (!claim) return notFound();

  const outcome = await claimSubmission(store(), claim.id, claim.token, nowIso());

  if (outcome.status === 'not-found') return notFound();
  if (outcome.status === 'conflict') {
    // Someone wrote between the read and the write. The page reloads the
    // listing and finds whatever is actually there now.
    return json({ status: 'conflict' });
  }
  if (outcome.status === 'held') {
    return json({
      status: 'held',
      claimedAt: outcome.submission.claim?.at ?? null,
      claimAgeMs: claimAgeMs(outcome.submission, nowMs()),
    });
  }

  return json({ status: 'claimed' });
}

interface ResolveBody extends ClaimBody {
  photoIds?: unknown;
}

/**
 * Remove a submission: its raw parts and its record.
 *
 * The same work either way, and the audit event is the difference. `accepted`
 * carries the photo ids that were committed out of it; `discarded` carries
 * none, because nothing was. Neither carries the address or the subject.
 *
 * Discarding is immediate and permanent: the trash is for photographs, and
 * these never were.
 */
async function handleInboxResolve(
  request: Request,
  kind: 'accepted' | 'discarded',
  store: () => ObjectStore,
): Promise<Response> {
  const body = await readJson<ResolveBody>(request);
  const claim = readClaim(body);
  if (!claim) return notFound();

  const photoIds =
    kind === 'accepted' && Array.isArray(body?.photoIds)
      ? body.photoIds.filter(
          (id): id is string => typeof id === 'string' && isValidPhotoId(id),
        )
      : [];

  const objectStore = store();
  const outcome = await removeSubmission(objectStore, claim.id, claim.token);
  // A submission that is gone, and one whose claim was taken over, are the
  // same plain 404 — as every other refusal on this site is.
  if (outcome.status === 'refused') return notFound();

  await writeAuditEvent(
    objectStore,
    makeAuditEvent(
      kind === 'accepted' ? 'submission-accepted' : 'submission-discarded',
      photoIds,
      {
        at: nowIso(),
        // `via` records the surface a change came through, and this one came
        // through the admin API like every other curation act. Only the
        // Worker's own `submission-received` is `email`.
        via: 'admin-api',
        note:
          `submission ${outcome.submission.id}, ` +
          `${outcome.submission.parts.length} parts`,
      },
    ),
  );

  return json({ status: 'removed' });
}
