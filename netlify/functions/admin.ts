/**
 * The admin API: catalog reads and mutations only.
 *
 * It never touches image bytes. The browser encodes the four artifacts and
 * PUTs them straight to R2 with the presigned URLs this issues; the server's
 * whole role is to hand out those URLs, verify the objects landed, and
 * maintain the catalog.
 */

import {
  INBOX_CLAIM_TTL_MINUTES,
  RENDITIONS,
  SIGNED_URL_TTL_SECONDS,
  photoObjectKey,
  submissionPartKey,
} from '../../src/shared/constants.ts';
import type { Rendition } from '../../src/shared/constants.ts';
import {
  findByContentHash,
  getLivePhoto,
  trashedPhotos,
} from '../../src/shared/catalog.ts';
import type { DerivativeDescriptor } from '../../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../../src/shared/catalog-repository.ts';
import {
  applyCaptions,
  beginBatch,
  commitPhoto,
  editPhotoMetadata,
  objectKeysFor,
  permanentlyDeletePhotos,
  resolveSelection,
  resolveTrashedSelection,
  restorePhotos,
  trashPhotos,
} from '../../src/shared/admin-operations.ts';
import type { SelectionQuery } from '../../src/shared/admin-operations.ts';
import {
  auditMetadataOf,
  makeAuditEvent,
  writeAuditEvent,
} from '../../src/shared/audit.ts';
import {
  generateAuditId,
  generatePhotoId,
  isValidPhotoId,
} from '../../src/shared/ids.ts';
import { downloadFilenameFor } from '../../src/shared/filename.ts';
import {
  NOTIFICATION_TEST_TTL_SECONDS,
  assetGrantPath,
  signAssetGrant,
  signConfirmation,
  signNotificationTest,
  verifyConfirmation,
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
import { S3ObjectStore } from './lib/s3-store.ts';
import { readRoute } from './lib/read-routes.ts';
import { presignedGetUrl, presignedUploadUrls } from './lib/presign.ts';
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

/** How long a preview's confirmation token stays valid. */
const CONFIRMATION_TTL_SECONDS = 10 * 60;

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

function s3Config() {
  return {
    endpoint: requiredEnv('R2_S3_ENDPOINT'),
    bucket: requiredEnv('R2_BUCKET'),
    accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  };
}

function store(): S3ObjectStore {
  return new S3ObjectStore(s3Config());
}

export default async function handler(request: Request): Promise<Response> {
  const refusal = checkAccess(request, 'admin');
  if (refusal) return refusal;

  const path = subPath(request, 'admin');
  const method = request.method;

  try {
    if (method === 'GET' && path === '/export') return exportCatalog();
    if (method === 'GET' && path === '/trash') return listTrash();
    if (method === 'GET' && path === '/trash/count') return trashCount();
    if (method === 'GET' && path === '/emails') return listEmails();
    if (method === 'GET' && path === '/inbox') return listInbox();
    if (method === 'GET' && path === '/inbox/count') return inboxCount();
    if (method === 'GET' && path === '/inbox/part-url') {
      return inboxPartUrl(new URL(request.url));
    }

    const download = /^\/download\/([0-9a-f]{32})$/.exec(path);
    if (method === 'GET' && download) return downloadLink(download[1]!);

    const attribution = /^\/attribution\/([0-9a-f]{32})$/.exec(path);
    if (method === 'GET' && attribution) return photoAttribution(attribution[1]!);

    // The admin app browses through the viewer's own projections; see
    // lib/read-routes.ts for why both functions must answer these.
    if (method === 'GET') {
      const { catalog } = await loadCatalog(store(), nowIso);
      const read = readRoute(catalog, path, nowMs());
      if (read) return read;
    }

    if (method !== 'POST') return notFound();

    switch (path) {
      case '/begin-batch':
        return await handleBeginBatch();
      case '/prepare':
        return await handlePrepare(request);
      case '/commit':
        return await handleCommit(request);
      case '/edit':
        return await handleEdit(request);
      case '/captions':
        return await handleCaptions(request);
      case '/trash/preview':
        return await handlePreview(request, 'trash');
      case '/trash/confirm':
        return await handleTrashConfirm(request);
      case '/restore':
        return await handleRestore(request);
      case '/permanent-delete/preview':
        return await handlePreview(request, 'permanent-delete');
      case '/permanent-delete/confirm':
        return await handlePermanentDeleteConfirm(request);
      case '/emails/add':
        return await handleAddRecipient(request);
      case '/emails/remove':
        return await handleRemoveRecipient(request);
      case '/emails/set-enabled':
        return await handleSetEnabled(request, 'enabled');
      case '/emails/set-submit':
        return await handleSetEnabled(request, 'canSubmit');
      case '/emails/set-reviews':
        return await handleSetEnabled(request, 'reviewsInbox');
      case '/inbox/claim':
        return await handleInboxClaim(request);
      case '/inbox/resolve':
        return await handleInboxResolve(request, 'accepted');
      case '/inbox/discard':
        return await handleInboxResolve(request, 'discarded');
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
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

async function handleBeginBatch(): Promise<Response> {
  const batchSeq = await mutateCatalog(store(), { now: nowIso }, beginBatch, {
    // The counter is bookkeeping, not curation; snapshotting every batch start
    // would fill the snapshot prefix with states nobody would restore.
    snapshot: false,
  });
  return json({ batchSeq });
}

interface PrepareBody {
  contentHash?: string;
  originalFilename?: string;
}

/**
 * Check for a duplicate and, if there is none, issue the four presigned PUTs.
 *
 * The duplicate answer here is advisory — it saves an upload nobody needs. The
 * *authoritative* check happens inside the commit's conditional write, which
 * is what closes the race between two concurrent uploads of the same file.
 */
async function handlePrepare(request: Request): Promise<Response> {
  const body = await readJson<PrepareBody>(request);
  if (!body?.contentHash || !body.originalFilename) {
    return badRequest('contentHash and originalFilename are required.');
  }
  if (!/^[0-9a-f]{64}$/.test(body.contentHash)) {
    return badRequest('contentHash must be a SHA-256 hex digest.');
  }

  const { catalog } = await loadCatalog(store(), nowIso);
  const existing = findByContentHash(catalog, body.contentHash);
  if (existing) {
    return json({
      status: 'duplicate',
      existingId: existing.id,
      existingTrashed: existing.trashedAt !== null,
    });
  }

  const photoId = generatePhotoId();
  const uploads = await presignedUploadUrls(s3Config(), photoId);

  return json({
    status: 'ready',
    photoId,
    downloadFilename: downloadFilenameFor(body.originalFilename, photoId),
    uploads,
  });
}

interface CommitBody {
  photoId?: string;
  contentHash?: string;
  originalFilename?: string;
  sourceMimeType?: string;
  captureDate?: string | null;
  captureTime?: string | null;
  captureUtcOffset?: string | null;
  timestampSource?: string;
  caption?: string | null;
  batchSeq?: number;
  selectionIndex?: number;
  derivatives?: Record<string, DerivativeDescriptor>;
  /** Set when this photograph came out of the Inbox; see below. */
  submissionId?: string;
  claimToken?: string;
}

const TIMESTAMP_SOURCES = new Set([
  'exif-datetimeoriginal',
  'exif-other',
  'filename',
  'manual',
  'none',
]);

async function handleCommit(request: Request): Promise<Response> {
  const body = await readJson<CommitBody>(request);
  if (!body?.photoId || !isValidPhotoId(body.photoId)) {
    return badRequest('A valid photoId is required.');
  }
  if (!body.contentHash || !/^[0-9a-f]{64}$/.test(body.contentHash)) {
    return badRequest('contentHash must be a SHA-256 hex digest.');
  }
  if (typeof body.batchSeq !== 'number' || typeof body.selectionIndex !== 'number') {
    return badRequest('batchSeq and selectionIndex are required.');
  }
  if (!body.originalFilename || !body.sourceMimeType) {
    return badRequest('originalFilename and sourceMimeType are required.');
  }
  if (!TIMESTAMP_SOURCES.has(body.timestampSource ?? '')) {
    return badRequest('timestampSource is not recognized.');
  }

  const derivatives = validateDerivatives(body.derivatives);
  if (!derivatives) return badRequest('derivatives are missing or malformed.');

  const objectStore = store();

  /*
   * Attribution, resolved here and never taken from the browser.
   *
   * The request names a submission and presents the claim it took on it; the
   * *sender* comes from the stored record. A tab cannot therefore attribute a
   * photograph to somebody who did not send it, and a tab whose claim was
   * taken over cannot commit against that submission at all — which is the
   * same uniform 404 every other refusal is.
   */
  let submittedBy: string | null = null;
  if (body.submissionId !== undefined) {
    if (!isValidSubmissionId(body.submissionId)) return notFound();
    const loaded = await loadSubmission(objectStore, body.submissionId);
    if (!loaded) return notFound();
    if (loaded.submission.claim?.token !== (body.claimToken ?? '')) return notFound();
    submittedBy = loaded.submission.submittedBy;
  }

  // Verify the objects actually landed before creating a record that promises
  // they exist. A record whose images 404 is worse than no record.
  for (const rendition of RENDITIONS) {
    const head = await objectStore.head(photoObjectKey(body.photoId, rendition));
    if (!head || head.size === 0) {
      return badRequest(`The ${rendition} artifact was not uploaded.`);
    }
  }

  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    commitPhoto(
      catalog,
      {
        id: body.photoId!,
        contentHash: body.contentHash!,
        originalFilename: body.originalFilename!,
        downloadFilename: downloadFilenameFor(body.originalFilename!, body.photoId!),
        sourceMimeType: body.sourceMimeType!,
        captureDate: body.captureDate ?? null,
        captureTime: body.captureTime ?? null,
        captureUtcOffset: body.captureUtcOffset ?? null,
        timestampSource: body.timestampSource as never,
        caption: body.caption ?? null,
        submittedBy,
        batchSeq: body.batchSeq!,
        selectionIndex: body.selectionIndex!,
        derivatives,
      },
      at,
      auditId,
    ),
  );

  if (outcome.status === 'duplicate') {
    return json({
      status: 'duplicate',
      existingId: outcome.existingId,
      existingTrashed: outcome.existingTrashed,
    });
  }

  await writeAuditEvent(
    objectStore,
    makeAuditEvent('upload', [outcome.photo.id], {
      at,
      id: auditId,
      after: auditMetadataOf(outcome.photo),
      note: outcome.photo.originalFilename,
    }),
  );

  return json({ status: 'created', photo: toPublicPhoto(outcome.photo) });
}

function validateDerivatives(
  input: Record<string, DerivativeDescriptor> | undefined,
): Record<Rendition, DerivativeDescriptor> | null {
  if (!input) return null;
  const out = {} as Record<Rendition, DerivativeDescriptor>;
  for (const rendition of RENDITIONS) {
    const descriptor = input[rendition];
    if (
      !descriptor ||
      !Number.isInteger(descriptor.width) ||
      !Number.isInteger(descriptor.height) ||
      !Number.isInteger(descriptor.bytes) ||
      descriptor.width <= 0 ||
      descriptor.height <= 0 ||
      descriptor.bytes <= 0
    ) {
      return null;
    }
    out[rendition] = {
      width: descriptor.width,
      height: descriptor.height,
      bytes: descriptor.bytes,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface EditBody {
  photoId?: string;
  date?: string | null;
  time?: string | null;
  caption?: string | null;
}

async function handleEdit(request: Request): Promise<Response> {
  const body = await readJson<EditBody>(request);
  if (!body?.photoId || !isValidPhotoId(body.photoId)) return notFound();

  const objectStore = store();
  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    editPhotoMetadata(catalog, body.photoId!, body, at, auditId),
  );

  if (outcome.status === 'not-found') return notFound();
  if (outcome.status === 'invalid') return badRequest(outcome.error);

  await writeAuditEvent(
    objectStore,
    makeAuditEvent('metadata-change', [outcome.photo.id], {
      at,
      id: auditId,
      before: auditMetadataOf(outcome.previous),
      after: auditMetadataOf(outcome.photo),
    }),
  );

  return json({ photo: toPublicPhoto(outcome.photo) });
}

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
async function handleCaptions(request: Request): Promise<Response> {
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
// Destructive actions: preview, then confirm against an explicit ID list
// ---------------------------------------------------------------------------

interface PreviewBody {
  selection?: SelectionQuery;
}

/**
 * Resolve a selection to explicit IDs and issue a token bound to that exact
 * list.
 *
 * The confirm step never re-runs the query, so a photo committed between
 * preview and confirm cannot be swept in unseen (decisions.md #12).
 */
async function handlePreview(
  request: Request,
  action: 'trash' | 'permanent-delete',
): Promise<Response> {
  const body = await readJson<PreviewBody>(request);
  if (!body?.selection) return badRequest('A selection is required.');

  // Permanent delete only ever acts on an explicit list from the trash view.
  // A group query would be a way to destroy photos nobody looked at.
  if (action === 'permanent-delete' && body.selection.kind !== 'ids') {
    return badRequest('Permanent deletion requires an explicit list of photo IDs.');
  }

  const { catalog } = await loadCatalog(store(), nowIso);

  const photoIds =
    body.selection.kind === 'ids' && action === 'permanent-delete'
      ? resolveTrashedSelection(catalog, body.selection.photoIds)
      : resolveSelection(catalog, body.selection);

  const expiresAt = nowSeconds() + CONFIRMATION_TTL_SECONDS;
  const token = await signConfirmation(requiredEnv('ASSET_SIGNING_KEY'), {
    action,
    photoIds,
    expiresAt,
  });

  return json({ photoIds, count: photoIds.length, expiresAt, token });
}

interface ConfirmBody {
  photoIds?: string[];
  expiresAt?: number;
  token?: string;
}

async function readConfirmation(
  request: Request,
  action: 'trash' | 'permanent-delete',
): Promise<{ photoIds: string[] } | Response> {
  const body = await readJson<ConfirmBody>(request);
  if (
    !body?.token ||
    typeof body.expiresAt !== 'number' ||
    !Array.isArray(body.photoIds)
  ) {
    return badRequest(
      'A confirmation token, its expiry, and its photo IDs are required.',
    );
  }
  if (!body.photoIds.every((id) => typeof id === 'string' && isValidPhotoId(id))) {
    return badRequest('photoIds contains a malformed ID.');
  }

  const verified = await verifyConfirmation(
    requiredEnv('ASSET_SIGNING_KEY'),
    { action, photoIds: body.photoIds, expiresAt: body.expiresAt },
    body.token,
    nowSeconds(),
  );

  if (!verified.ok) {
    return badRequest(
      verified.reason === 'expired'
        ? 'That confirmation has expired. Please review the selection again.'
        : 'That confirmation does not match the selection it was issued for.',
    );
  }

  return { photoIds: body.photoIds };
}

async function handleTrashConfirm(request: Request): Promise<Response> {
  const confirmation = await readConfirmation(request, 'trash');
  if (confirmation instanceof Response) return confirmation;

  const objectStore = store();
  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    trashPhotos(catalog, confirmation.photoIds, at, auditId),
  );

  if (outcome.affected.length > 0) {
    await writeAuditEvent(
      objectStore,
      makeAuditEvent('trash', outcome.affected, { at, id: auditId }),
    );
  }

  return json({ trashed: outcome.affected, count: outcome.affected.length });
}

interface RestoreBody {
  photoIds?: string[];
}

/**
 * Restore is not gated behind a confirmation: it is the *undo*, and it only
 * ever puts photos back.
 */
async function handleRestore(request: Request): Promise<Response> {
  const body = await readJson<RestoreBody>(request);
  if (!Array.isArray(body?.photoIds)) return badRequest('photoIds is required.');
  if (!body.photoIds.every((id) => typeof id === 'string' && isValidPhotoId(id))) {
    return badRequest('photoIds contains a malformed ID.');
  }

  const objectStore = store();
  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    restorePhotos(catalog, body.photoIds!, at, auditId),
  );

  if (outcome.affected.length > 0) {
    await writeAuditEvent(
      objectStore,
      makeAuditEvent('restore', outcome.affected, { at, id: auditId }),
    );
  }

  return json({ restored: outcome.affected, count: outcome.affected.length });
}

async function handlePermanentDeleteConfirm(request: Request): Promise<Response> {
  const confirmation = await readConfirmation(request, 'permanent-delete');
  if (confirmation instanceof Response) return confirmation;

  const objectStore = store();
  const auditId = generateAuditId();
  const at = nowIso();

  const outcome = await mutateCatalog(objectStore, { now: nowIso }, (catalog) =>
    permanentlyDeletePhotos(catalog, confirmation.photoIds),
  );

  // Objects are deleted only after the catalog write succeeds. The other order
  // would, on a lost race, leave a live record pointing at images that no
  // longer exist.
  if (outcome.affected.length > 0) {
    await objectStore.delete(outcome.affected.flatMap(objectKeysFor));
    await writeAuditEvent(
      objectStore,
      makeAuditEvent('permanent-delete', outcome.affected, { at, id: auditId }),
    );
  }

  return json({ deleted: outcome.affected, count: outcome.affected.length });
}

/**
 * A short-lived signed URL for the full-resolution JPEG.
 *
 * The admin needs its own copy of this rather than reaching into the display
 * function, because the two are reachable only through their own secret paths.
 * Trashed photos are refused here exactly as they are for a viewer.
 */
async function downloadLink(photoId: string): Promise<Response> {
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
// Trash listing and export
// ---------------------------------------------------------------------------

/**
 * The trash view.
 *
 * Both images come as signed URLs because the Worker refuses capability-URL
 * access to a trashed photo: the thumbnail for the grid, and a `display-1280`
 * preview so the trash's photo view has something to show. It never signs a
 * full-resolution URL for one — a trashed photo must not be downloadable.
 */
async function listTrash(): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  const key = requiredEnv('ASSET_SIGNING_KEY');
  const workerBase = requiredEnv('WORKER_BASE_URL').replace(/\/+$/, '');
  const expiresAt = nowSeconds() + SIGNED_URL_TTL_SECONDS;

  const signedUrl = async (photoId: string, rendition: string) => {
    const grant = { photoId, rendition, expiresAt };
    return `${workerBase}${assetGrantPath(grant, await signAssetGrant(key, grant))}`;
  };

  const items = await Promise.all(
    trashedPhotos(catalog).map(async (photo) => ({
      photo: toPublicPhoto(photo),
      trashedAt: photo.trashedAt,
      thumbnailUrl: await signedUrl(photo.id, 'thumb'),
      previewUrl: await signedUrl(photo.id, 'display-1280'),
    })),
  );

  items.sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
  return json({ items, expiresAt: new Date(expiresAt * 1000).toISOString() });
}

/**
 * Just the number, for the persistent Trash navigation link.
 *
 * Separate from listTrash so the header does not mint a signed thumbnail URL
 * per trashed photo on every page view.
 */
async function trashCount(): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  return json({ count: trashedPhotos(catalog).length });
}

/** The provider-independent curation export: the catalog exactly as stored. */
async function exportCatalog(): Promise<Response> {
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

async function listEmails(): Promise<Response> {
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
async function handleAddRecipient(request: Request): Promise<Response> {
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
        // Enabling starts the clock: `seenThrough` is now, so the first digest
        // never announces the library that was already there. The two
        // submission bits start off; each is a deliberate decision.
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
      enabled: true,
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
async function handleRemoveRecipient(request: Request): Promise<Response> {
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
    const existing: RecipientState =
      current.recipients[email] ?? newRecipient(at, false);
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
async function photoAttribution(photoId: string): Promise<Response> {
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

async function listInbox(): Promise<Response> {
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
async function inboxCount(): Promise<Response> {
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
async function inboxPartUrl(url: URL): Promise<Response> {
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
async function handleInboxClaim(request: Request): Promise<Response> {
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
