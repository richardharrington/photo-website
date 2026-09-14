/**
 * The curation routes: the mutations and listings both APIs answer.
 *
 * The display link is the family link (family-tier.md #1), so a display-mode
 * request may upload, edit, move to the trash, and restore, and the admin app
 * does all of the same through the same code. What neither Function may do is
 * answer these from two copies: the list below is the tier. `display.ts`
 * dispatches to this module and to nothing admin-only, `admin.ts` dispatches
 * here and then to its own routes, and `tests/unit/curation-routes.test.ts`
 * asserts both directions against `CURATION_ROUTES`.
 *
 * The same reason `read-routes.ts` exists applies, only more so: the
 * development fixture server has been more permissive than production before
 * and hid a missing route, so the fixture server's display branch answers
 * exactly this list and is tested against it.
 *
 * `mode` is threaded in for one purpose. Every audit event written here
 * records which link the act came through, `display-api` or `admin-api`
 * (family-tier.md #9); nothing relies on `makeAuditEvent`'s default. It is
 * never a second authorization check — `checkAccess` has already decided the
 * mode before either Function calls this.
 */

import {
  RENDITIONS,
  SIGNED_URL_TTL_SECONDS,
  photoObjectKey,
} from '../../../src/shared/constants.ts';
import type { Rendition } from '../../../src/shared/constants.ts';
import { findByContentHash, trashedPhotos } from '../../../src/shared/catalog.ts';
import type { DerivativeDescriptor } from '../../../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../../../src/shared/catalog-repository.ts';
import {
  beginBatch,
  commitPhoto,
  editPhotoMetadata,
  resolveSelection,
  restorePhotos,
  trashPhotos,
} from '../../../src/shared/admin-operations.ts';
import type { SelectionQuery } from '../../../src/shared/admin-operations.ts';
import {
  auditMetadataOf,
  makeAuditEvent,
  writeAuditEvent,
} from '../../../src/shared/audit.ts';
import type { AuditEvent } from '../../../src/shared/audit.ts';
import {
  generateAuditId,
  generatePhotoId,
  isValidPhotoId,
} from '../../../src/shared/ids.ts';
import { downloadFilenameFor } from '../../../src/shared/filename.ts';
import { assetGrantPath, signAssetGrant } from '../../../src/shared/signing.ts';
import { toPublicPhoto } from '../../../src/shared/display-api.ts';
import {
  isValidSubmissionId,
  loadSubmission,
} from '../../../src/shared/inbox-repository.ts';
import type { ObjectStore } from '../../../src/shared/store.ts';
import { s3Config } from './s3-store.ts';
import { presignedUploadUrls } from './presign.ts';
import { issueConfirmation, readConfirmation } from './confirmation.ts';
import {
  badRequest,
  json,
  notFound,
  nowIso,
  nowSeconds,
  readJson,
  requiredEnv,
} from './http.ts';
import type { AccessMode } from './http.ts';

interface CurationRequest {
  request: Request;
  store: () => ObjectStore;
  /** The link the request came through, for the audit log. */
  via: AuditEvent['via'];
}

interface Route {
  method: 'GET' | 'POST';
  path: string;
  handle: (context: CurationRequest) => Promise<Response>;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/trash', handle: listTrash },
  { method: 'GET', path: '/trash/count', handle: trashCount },
  { method: 'POST', path: '/begin-batch', handle: handleBeginBatch },
  { method: 'POST', path: '/prepare', handle: handlePrepare },
  { method: 'POST', path: '/commit', handle: handleCommit },
  { method: 'POST', path: '/edit', handle: handleEdit },
  { method: 'POST', path: '/trash/preview', handle: handleTrashPreview },
  { method: 'POST', path: '/trash/confirm', handle: handleTrashConfirm },
  { method: 'POST', path: '/restore', handle: handleRestore },
];

/** Every route this module answers, as data, for the whitelist test. */
export const CURATION_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[] =
  ROUTES.map(({ method, path }) => ({ method, path }));

/**
 * Answer a curation route, or return `null` when the request is not one.
 *
 * As with `readRoute`, `null` means "keep looking", while a 404 response means
 * "a curation route, and there is no such photo".
 */
export async function curationRoute(
  request: Request,
  path: string,
  mode: AccessMode,
  store: () => ObjectStore,
): Promise<Response | null> {
  const route = ROUTES.find(
    (candidate) => candidate.method === request.method && candidate.path === path,
  );
  if (!route) return null;

  return route.handle({
    request,
    store,
    via: mode === 'admin' ? 'admin-api' : 'display-api',
  });
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

async function handleBeginBatch({ store }: CurationRequest): Promise<Response> {
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
async function handlePrepare({ request, store }: CurationRequest): Promise<Response> {
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

async function handleCommit({
  request,
  store,
  via,
}: CurationRequest): Promise<Response> {
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
      via,
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

async function handleEdit({ request, store, via }: CurationRequest): Promise<Response> {
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
      via,
      before: auditMetadataOf(outcome.previous),
      after: auditMetadataOf(outcome.photo),
    }),
  );

  return json({ photo: toPublicPhoto(outcome.photo) });
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
async function handleTrashPreview({
  request,
  store,
}: CurationRequest): Promise<Response> {
  const body = await readJson<PreviewBody>(request);
  if (!body?.selection) return badRequest('A selection is required.');

  const { catalog } = await loadCatalog(store(), nowIso);
  return issueConfirmation('trash', resolveSelection(catalog, body.selection));
}

async function handleTrashConfirm({
  request,
  store,
  via,
}: CurationRequest): Promise<Response> {
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
      makeAuditEvent('trash', outcome.affected, { at, id: auditId, via }),
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
async function handleRestore({
  request,
  store,
  via,
}: CurationRequest): Promise<Response> {
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
      makeAuditEvent('restore', outcome.affected, { at, id: auditId, via }),
    );
  }

  return json({ restored: outcome.affected, count: outcome.affected.length });
}

// ---------------------------------------------------------------------------
// Trash listing
// ---------------------------------------------------------------------------

/**
 * The trash view.
 *
 * Both images come as signed URLs because the Worker refuses capability-URL
 * access to a trashed photo: the thumbnail for the grid, and a `display-1280`
 * preview so the trash's photo view has something to show. It never signs a
 * full-resolution URL for one — a trashed photo must not be downloadable.
 */
async function listTrash({ store }: CurationRequest): Promise<Response> {
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
async function trashCount({ store }: CurationRequest): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  return json({ count: trashedPhotos(catalog).length });
}
