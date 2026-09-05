/**
 * Local development fake: the display API, the admin API, and the asset
 * Worker, all in-process.
 *
 * No Netlify or Cloudflare account is required to run and exercise either app.
 * It runs the *real* projection and mutation functions over an in-memory
 * object store, so what is exercised locally is the real contract and the real
 * conditional-write logic — only the storage and the image bytes are fake.
 *
 * Development only. It is mounted by the Vite dev server and is never part of
 * a production build.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtureCatalog } from '../fixtures/catalog.ts';
import { InMemoryObjectStore } from '../fixtures/in-memory-store.ts';
import {
  photoResponse,
  timelineResponse,
  toPublicPhoto,
} from '../src/shared/display-api.ts';
import { getLivePhoto, trashedPhotos } from '../src/shared/catalog.ts';
import type { Catalog } from '../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../src/shared/catalog-repository.ts';
import {
  beginBatch,
  commitPhoto,
  editPhotoMetadata,
  permanentlyDeletePhotos,
  resolveSelection,
  resolveTrashedSelection,
  restorePhotos,
  trashPhotos,
} from '../src/shared/admin-operations.ts';
import type { SelectionQuery } from '../src/shared/admin-operations.ts';
import {
  R2_KEYS,
  RENDITION_SPECS,
  SIGNED_URL_TTL_SECONDS,
} from '../src/shared/constants.ts';
import type { Rendition } from '../src/shared/constants.ts';
import { encodeJson } from '../src/shared/store.ts';
import { generateAuditId, generatePhotoId } from '../src/shared/ids.ts';
import { downloadFilenameFor } from '../src/shared/filename.ts';
import { baseSecurityHeaders } from '../src/shared/headers.ts';

const store = new InMemoryObjectStore();
store.seed(R2_KEYS.catalog, encodeJson(fixtureCatalog()));

const now = () => new Date().toISOString();
const context = { now };

/** Uploaded artifact bytes, so a committed photo can be served back. */
const uploadedObjects = new Map<string, Uint8Array>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    ...baseSecurityHeaders(),
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Not Found');
}

function sendBadRequest(res: ServerResponse, error: string): void {
  sendJson(res, 400, { error });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function currentCatalog(): Promise<Catalog> {
  return (await loadCatalog(store, now)).catalog;
}

/**
 * A placeholder image standing in for a real derivative.
 *
 * SVG rather than a generated WebP: the point is to exercise layout, lazy
 * loading, and the trash's signed-thumbnail path, and encoding real bytes here
 * would add a codec dependency to the dev server for no benefit. The label
 * makes it obvious which rendition the browser actually requested.
 */
function placeholderSvg(width: number, height: number, label: string, hue: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="hsl(${hue} 45% 72%)"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        font-family="system-ui, sans-serif" font-size="${Math.round(Math.min(width, height) / 8)}"
        fill="hsl(${hue} 60% 22%)">${label}</text>
</svg>`;
}

function hueFor(photoId: string): number {
  let hash = 0;
  for (let i = 0; i < photoId.length; i += 1) {
    hash = (hash * 31 + photoId.charCodeAt(i)) % 360;
  }
  return hash;
}

function isRendition(value: string): value is Rendition {
  return Object.prototype.hasOwnProperty.call(RENDITION_SPECS, value);
}

// ---------------------------------------------------------------------------
// Asset Worker stand-in
// ---------------------------------------------------------------------------

async function serveAsset(
  res: ServerResponse,
  photoId: string,
  rendition: string,
  signed: boolean,
): Promise<boolean> {
  const catalog = await currentCatalog();
  if (!isRendition(rendition)) {
    sendNotFound(res);
    return true;
  }

  // The capability route refuses trashed photos and the full-resolution
  // original, exactly as the real Worker must; the signed route may serve a
  // trashed thumbnail, which the trash view needs.
  const photo = signed ? catalog.photos[photoId] : getLivePhoto(catalog, photoId);
  if (!photo || (!signed && rendition === 'full')) {
    sendNotFound(res);
    return true;
  }
  if (signed && photo.trashedAt !== null && rendition === 'full') {
    sendNotFound(res);
    return true;
  }

  const stored = uploadedObjects.get(`${photoId}/${rendition}`);
  if (stored) {
    res.writeHead(200, {
      ...baseSecurityHeaders(),
      'content-type': RENDITION_SPECS[rendition].contentType,
    });
    res.end(Buffer.from(stored));
    return true;
  }

  const descriptor = photo.derivatives[rendition];
  res.writeHead(200, {
    ...baseSecurityHeaders(),
    'content-type': 'image/svg+xml',
    'cache-control': signed
      ? 'private, no-store'
      : 'public, max-age=31536000, immutable',
  });
  res.end(
    placeholderSvg(descriptor.width, descriptor.height, rendition, hueFor(photoId)),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Display API
// ---------------------------------------------------------------------------

async function handleDisplay(route: string, res: ServerResponse): Promise<boolean> {
  const catalog = await currentCatalog();

  if (route === '/timeline') {
    sendJson(
      res,
      200,
      timelineResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos', Date.now()),
    );
    return true;
  }
  const photo = /^\/photo\/([0-9a-f]{32})$/.exec(route);
  if (photo) {
    const body = photoResponse(catalog, photo[1]!);
    if (body) sendJson(res, 200, body);
    else sendNotFound(res);
    return true;
  }

  const download = /^\/download\/([0-9a-f]{32})$/.exec(route);
  if (download) {
    const record = getLivePhoto(catalog, download[1]!);
    if (!record) {
      sendNotFound(res);
      return true;
    }
    sendJson(res, 200, {
      // Production returns an HMAC-signed Worker URL; locally the signed route
      // is unsigned, so the button is still exercisable.
      url: `/d/${record.id}/full`,
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      filename: record.downloadFilename,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

interface Body {
  [key: string]: unknown;
}

async function handleAdmin(
  route: string,
  method: string,
  body: Body,
  res: ServerResponse,
): Promise<boolean> {
  if (method === 'GET') {
    if (route === '/trash') {
      const catalog = await currentCatalog();
      const items = trashedPhotos(catalog)
        .map((photo) => ({
          photo: toPublicPhoto(photo),
          trashedAt: photo.trashedAt,
          // Production signs a grant per rendition; locally the signed route
          // is unsigned, so the trash's grid and photo view are exercisable.
          // Never `full`: a trashed photo must not be downloadable.
          thumbnailUrl: `/d/${photo.id}/thumb`,
          previewUrl: `/d/${photo.id}/display-1280`,
        }))
        .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
      sendJson(res, 200, {
        items,
        expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      });
      return true;
    }

    if (route === '/trash/count') {
      sendJson(res, 200, { count: trashedPhotos(await currentCatalog()).length });
      return true;
    }

    if (route === '/export') {
      const catalog = await currentCatalog();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="photo-catalog.json"',
      });
      res.end(JSON.stringify(catalog, null, 2));
      return true;
    }

    return handleDisplay(route, res);
  }

  if (method !== 'POST') return false;

  switch (route) {
    case '/begin-batch': {
      const batchSeq = await mutateCatalog(store, context, beginBatch, {
        snapshot: false,
      });
      sendJson(res, 200, { batchSeq });
      return true;
    }

    case '/prepare': {
      const hash = String(body['contentHash'] ?? '');
      const filename = String(body['originalFilename'] ?? '');
      const catalog = await currentCatalog();
      const existing = Object.values(catalog.photos).find(
        (photo) => photo.contentHash === hash,
      );
      if (existing) {
        sendJson(res, 200, { status: 'duplicate', existingId: existing.id });
        return true;
      }
      const photoId = generatePhotoId();
      sendJson(res, 200, {
        status: 'ready',
        photoId,
        downloadFilename: downloadFilenameFor(filename, photoId),
        // Local upload sink; production returns presigned R2 URLs.
        uploads: Object.fromEntries(
          (Object.keys(RENDITION_SPECS) as Rendition[]).map((rendition) => [
            rendition,
            `/__upload/${photoId}/${rendition}`,
          ]),
        ),
      });
      return true;
    }

    case '/commit': {
      const auditId = generateAuditId();
      const at = now();
      const outcome = await mutateCatalog(store, context, (catalog) =>
        commitPhoto(
          catalog,
          {
            id: String(body['photoId']),
            contentHash: String(body['contentHash']),
            originalFilename: String(body['originalFilename']),
            downloadFilename: downloadFilenameFor(
              String(body['originalFilename']),
              String(body['photoId']),
            ),
            sourceMimeType: String(body['sourceMimeType']),
            captureDate: (body['captureDate'] as string | null) ?? null,
            captureTime: (body['captureTime'] as string | null) ?? null,
            captureUtcOffset: (body['captureUtcOffset'] as string | null) ?? null,
            timestampSource: body['timestampSource'] as never,
            caption: (body['caption'] as string | null) ?? null,
            batchSeq: Number(body['batchSeq']),
            selectionIndex: Number(body['selectionIndex']),
            derivatives: body['derivatives'] as never,
          },
          at,
          auditId,
        ),
      );
      sendJson(
        res,
        200,
        outcome.status === 'duplicate'
          ? { status: 'duplicate', existingId: outcome.existingId }
          : { status: 'created', photo: toPublicPhoto(outcome.photo) },
      );
      return true;
    }

    case '/edit': {
      const outcome = await mutateCatalog(store, context, (catalog) =>
        editPhotoMetadata(
          catalog,
          String(body['photoId']),
          body as never,
          now(),
          generateAuditId(),
        ),
      );
      if (outcome.status === 'not-found') sendNotFound(res);
      else if (outcome.status === 'invalid') sendBadRequest(res, outcome.error);
      else sendJson(res, 200, { photo: toPublicPhoto(outcome.photo) });
      return true;
    }

    case '/trash/preview': {
      const catalog = await currentCatalog();
      const photoIds = resolveSelection(catalog, body['selection'] as SelectionQuery);
      sendJson(res, 200, {
        photoIds,
        count: photoIds.length,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        // Production signs an HMAC over the exact ID list; locally the list is
        // still what the confirm acts on, which is the behaviour under test.
        token: 'development-token',
      });
      return true;
    }

    case '/trash/confirm': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        trashPhotos(catalog, ids, now(), generateAuditId()),
      );
      sendJson(res, 200, { trashed: outcome.affected, count: outcome.affected.length });
      return true;
    }

    case '/restore': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        restorePhotos(catalog, ids, now(), generateAuditId()),
      );
      sendJson(res, 200, {
        restored: outcome.affected,
        count: outcome.affected.length,
      });
      return true;
    }

    case '/permanent-delete/preview': {
      const selection = body['selection'] as SelectionQuery;
      const ids =
        selection.kind === 'ids'
          ? resolveTrashedSelection(await currentCatalog(), selection.photoIds)
          : [];
      sendJson(res, 200, {
        photoIds: ids,
        count: ids.length,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        token: 'development-token',
      });
      return true;
    }

    case '/permanent-delete/confirm': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        permanentlyDeletePhotos(catalog, ids),
      );
      for (const id of outcome.affected) {
        for (const rendition of Object.keys(RENDITION_SPECS)) {
          uploadedObjects.delete(`${id}/${rendition}`);
        }
      }
      sendJson(res, 200, { deleted: outcome.affected, count: outcome.affected.length });
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Local stand-in for a presigned R2 PUT.
  const upload = /^\/__upload\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (upload && method === 'PUT') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    uploadedObjects.set(
      `${upload[1]}/${upload[2]}`,
      new Uint8Array(Buffer.concat(chunks)),
    );
    res.writeHead(200).end();
    return true;
  }

  const capability = /^\/p\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (capability) return serveAsset(res, capability[1]!, capability[2]!, false);

  const signed = /^\/d\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (signed) return serveAsset(res, signed[1]!, signed[2]!, true);

  const api = /^\/([^/]+)\/api(\/.*)?$/.exec(path);
  if (!api) return false;

  const base = api[1]!;
  const route = api[2] ?? '/';
  // Which app is asking is decided by the base path, exactly as the Edge
  // Function decides access mode in production.
  const isAdmin = base === (process.env.ADMIN_PATH || 'dev-admin-path');

  if (isAdmin) {
    return handleAdmin(route, method, (await readBody(req)) as Body, res);
  }
  if (method !== 'GET') {
    sendNotFound(res);
    return true;
  }
  if (await handleDisplay(route, res)) return true;

  sendNotFound(res);
  return true;
}

export function fixtureServer(): Plugin {
  return {
    name: 'photo-fixture-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          handle(req, url, res).then(
            (handled) => {
              if (!handled) next();
            },
            (error: unknown) => {
              console.error('Fixture server error', error);
              sendJson(res, 500, { error: 'Fixture server error' });
            },
          );
        },
      );
    },
  };
}
