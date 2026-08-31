/**
 * The admin API: catalog reads and mutations only.
 *
 * It never touches image bytes. The browser encodes the four artifacts and
 * PUTs them straight to R2 with the presigned URLs this issues; the server's
 * whole role is to hand out those URLs, verify the objects landed, and
 * maintain the catalog.
 */

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  RENDITIONS,
  RENDITION_SPECS,
  SIGNED_URL_TTL_SECONDS,
  photoObjectKey,
} from '../../src/shared/constants.ts';
import type { Rendition } from '../../src/shared/constants.ts';
import { findByContentHash, trashedPhotos } from '../../src/shared/catalog.ts';
import type { DerivativeDescriptor } from '../../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../../src/shared/catalog-repository.ts';
import {
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
  assetGrantPath,
  signAssetGrant,
  signConfirmation,
  verifyConfirmation,
} from '../../src/shared/signing.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import { S3ObjectStore } from './lib/s3-store.ts';
import {
  badRequest,
  checkAccess,
  json,
  notFound,
  nowIso,
  nowSeconds,
  readJson,
  requiredEnv,
  serverError,
  subPath,
} from './lib/http.ts';

/** How long a preview's confirmation token stays valid. */
const CONFIRMATION_TTL_SECONDS = 10 * 60;
/** Presigned PUT lifetime: long enough for a slow upload, short enough to matter. */
const UPLOAD_URL_TTL_SECONDS = 30 * 60;

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
      default:
        return notFound();
    }
  } catch (error) {
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
    return json({ status: 'duplicate', existingId: existing.id });
  }

  const photoId = generatePhotoId();
  const client = new S3Client({
    region: 'auto',
    endpoint: s3Config().endpoint,
    credentials: {
      accessKeyId: s3Config().accessKeyId,
      secretAccessKey: s3Config().secretAccessKey,
    },
  });

  // One URL per object, each scoped to exactly that key and content type, so
  // a leaked URL cannot be used to write anything else into the bucket.
  const uploads: Record<string, string> = {};
  for (const rendition of RENDITIONS) {
    uploads[rendition] = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: s3Config().bucket,
        Key: photoObjectKey(photoId, rendition),
        ContentType: RENDITION_SPECS[rendition].contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

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
        batchSeq: body.batchSeq!,
        selectionIndex: body.selectionIndex!,
        derivatives,
      },
      at,
      auditId,
    ),
  );

  if (outcome.status === 'duplicate') {
    return json({ status: 'duplicate', existingId: outcome.existingId });
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

// ---------------------------------------------------------------------------
// Trash listing and export
// ---------------------------------------------------------------------------

/**
 * The trash view.
 *
 * Thumbnails come as signed URLs because the Worker refuses capability-URL
 * access to a trashed photo. It never signs a full-resolution URL for one:
 * a trashed photo must not be downloadable.
 */
async function listTrash(): Promise<Response> {
  const { catalog } = await loadCatalog(store(), nowIso);
  const key = requiredEnv('ASSET_SIGNING_KEY');
  const workerBase = requiredEnv('WORKER_BASE_URL').replace(/\/+$/, '');
  const expiresAt = nowSeconds() + SIGNED_URL_TTL_SECONDS;

  const items = await Promise.all(
    trashedPhotos(catalog).map(async (photo) => {
      const grant = { photoId: photo.id, rendition: 'thumb', expiresAt };
      const signature = await signAssetGrant(key, grant);
      return {
        photo: toPublicPhoto(photo),
        trashedAt: photo.trashedAt,
        thumbnailUrl: `${workerBase}${assetGrantPath(grant, signature)}`,
      };
    }),
  );

  items.sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
  return json({ items, expiresAt: new Date(expiresAt * 1000).toISOString() });
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
