/**
 * The R2 asset gateway.
 *
 * Not an application: a small door onto a private bucket. It exists so R2
 * itself stays private and so image responses — which cannot carry a robots
 * meta tag — can carry the no-index header (implementation-plan.md, "Why the
 * Cloudflare Worker exists").
 *
 * There is deliberately no Origin or Referer check. Under
 * `Referrer-Policy: no-referrer` an image load carries neither header, so such
 * a check could never work as access control; the capability URLs and the
 * signed URLs are the access model (decisions.md #15).
 */

import {
  DISPLAY_RENDITIONS,
  RENDITION_SPECS,
  WORKER_CATALOG_CACHE_SECONDS,
  photoObjectKey,
} from '../../src/shared/constants.ts';
import type { Rendition } from '../../src/shared/constants.ts';
import { getLivePhoto } from '../../src/shared/catalog.ts';
import type { Catalog, PhotoRecord } from '../../src/shared/catalog.ts';
import { loadCatalog } from '../../src/shared/catalog-repository.ts';
import { baseSecurityHeaders } from '../../src/shared/headers.ts';
import { isValidPhotoId } from '../../src/shared/ids.ts';
import { verifyAssetGrant } from '../../src/shared/signing.ts';
import { R2BindingStore } from './binding-store.ts';
import type { R2Like } from './binding-store.ts';
import { runMaintenance } from './maintenance.ts';

export interface Env {
  PHOTOS: R2Like;
  ASSET_SIGNING_KEY: string;
  CATALOG_CACHE_SECONDS?: string;
}

const CAPABILITY_ROUTE = /^\/p\/([0-9a-f]{32})\/([a-z0-9-]+)$/;
const SIGNED_ROUTE = /^\/d\/([0-9a-f]{32})\/([a-z0-9-]+)$/;

/**
 * Every refusal is the same: unknown photo, trashed photo, wrong rendition,
 * bad signature, expired signature. Nothing distinguishes them.
 */
function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      ...baseSecurityHeaders(),
      'content-type': 'text/plain; charset=utf-8',
      // Never let a 404 be cached: a photo restored from the trash must
      // become reachable again promptly.
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

let cachedCatalog: { catalog: Catalog; loadedAtMs: number } | null = null;

/**
 * The catalog, cached for about a minute.
 *
 * Without this the Worker would pay a catalog read per image request. The
 * cost is that a trashed photo's URLs may keep working for up to that minute —
 * accepted by the design, since images already viewed sit in browser caches
 * anyway and every recipient is trusted (decisions.md #9).
 */
async function readCatalog(env: Env, nowMs: number): Promise<Catalog> {
  const ttlMs =
    Number(env.CATALOG_CACHE_SECONDS ?? WORKER_CATALOG_CACHE_SECONDS) * 1000;

  if (cachedCatalog && nowMs - cachedCatalog.loadedAtMs < ttlMs) {
    return cachedCatalog.catalog;
  }

  const store = new R2BindingStore(env.PHOTOS);
  const { catalog } = await loadCatalog(store, () => new Date(nowMs).toISOString());
  cachedCatalog = { catalog, loadedAtMs: nowMs };
  return catalog;
}

/** Test seam: drops the cache so a test does not have to wait out the TTL. */
export function resetCatalogCache(): void {
  cachedCatalog = null;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

function isRendition(value: string): value is Rendition {
  return Object.prototype.hasOwnProperty.call(RENDITION_SPECS, value);
}

function isDisplayRendition(value: string): boolean {
  return (DISPLAY_RENDITIONS as readonly string[]).includes(value);
}

async function serveObject(
  env: Env,
  photo: PhotoRecord,
  rendition: Rendition,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const object = await env.PHOTOS.get(photoObjectKey(photo.id, rendition));
  if (!object) return notFound();

  return new Response(object.body ?? null, {
    status: 200,
    headers: {
      ...baseSecurityHeaders(),
      'content-type': RENDITION_SPECS[rendition].contentType,
      'content-length': String(object.size),
      etag: object.etag,
      ...extraHeaders,
    },
  });
}

/**
 * Unsigned capability URL for a display derivative.
 *
 * The 128-bit random photo ID *is* the secret, which is what makes these
 * cacheable forever: no signature to expire, so a browser reuses a thumbnail
 * across visits instead of re-fetching it behind a fresh link
 * (decisions.md #8).
 */
async function handleCapability(
  env: Env,
  photoId: string,
  rendition: string,
  nowMs: number,
): Promise<Response> {
  // `full` is excluded here on purpose: the full-resolution JPEG is reachable
  // only through a signed download URL, never by knowing the photo ID.
  if (!isDisplayRendition(rendition) || !isRendition(rendition)) return notFound();

  const catalog = await readCatalog(env, nowMs);
  const photo = getLivePhoto(catalog, photoId);
  if (!photo) return notFound();

  return serveObject(env, photo, rendition, {
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

/**
 * Signed URL: full-resolution downloads, and trash-view thumbnails.
 *
 * The trash view needs thumbnails for photos the capability route refuses, so
 * this route may serve a trashed photo — but only its thumbnail. A trashed
 * photo must never be downloadable, so `full` is refused for one here even if
 * a valid signature somehow existed for it.
 */
async function handleSigned(
  env: Env,
  url: URL,
  photoId: string,
  rendition: string,
  nowMs: number,
): Promise<Response> {
  if (!isRendition(rendition)) return notFound();

  // Fail closed, the way the Netlify gate does for its own shared secret. An
  // unset key is a deployment fault, not a request fault: without it no
  // signature can be verified, so nothing may be served. Left unguarded it is
  // worse than useless — Web Crypto rejects a zero-length HMAC key with a
  // DataError, which reaches the visitor as a Cloudflare 1101 page and tells
  // the operator nothing at all.
  if (!env.ASSET_SIGNING_KEY) {
    // eslint-disable-next-line no-console
    console.error('ASSET_SIGNING_KEY is not set; refusing every signed URL.');
    return notFound();
  }

  const expiresAt = Number(url.searchParams.get('exp'));
  const signature = url.searchParams.get('sig') ?? '';
  if (!Number.isFinite(expiresAt) || signature === '') return notFound();

  const verified = await verifyAssetGrant(
    env.ASSET_SIGNING_KEY,
    { photoId, rendition, expiresAt },
    signature,
    Math.floor(nowMs / 1000),
  );
  if (!verified.ok) return notFound();

  const catalog = await readCatalog(env, nowMs);
  const photo = catalog.photos[photoId];
  if (!photo) return notFound();

  if (photo.trashedAt !== null && rendition === 'full') {
    // Defence in depth: the admin API never signs this, and the Worker
    // refuses it anyway.
    return notFound();
  }

  const headers: Record<string, string> = {
    // Signed URLs are short-lived and per-request; a shared cache must not
    // hold one, and a private cache should not outlive the grant.
    'cache-control': 'private, no-store',
  };

  if (rendition === 'full') {
    headers['content-disposition'] =
      `attachment; filename="${sanitizeForHeader(photo.downloadFilename)}"`;
  }

  return serveObject(env, photo, rendition, headers);
}

/**
 * Filenames are already sanitized when the record is created; this is the
 * belt-and-braces pass that keeps a quote or newline out of the header.
 */
function sanitizeForHeader(filename: string): string {
  // eslint-disable-next-line no-control-regex
  return filename.replace(new RegExp('[\\u0000-\\u001f"\\\\]', 'g'), '');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    const url = new URL(request.url);
    const nowMs = Date.now();

    const capability = CAPABILITY_ROUTE.exec(url.pathname);
    if (capability) {
      const [, photoId, rendition] = capability as unknown as string[];
      if (!isValidPhotoId(photoId!)) return notFound();
      return handleCapability(env, photoId!, rendition!, nowMs);
    }

    const signed = SIGNED_ROUTE.exec(url.pathname);
    if (signed) {
      const [, photoId, rendition] = signed as unknown as string[];
      if (!isValidPhotoId(photoId!)) return notFound();
      return handleSigned(env, url, photoId!, rendition!, nowMs);
    }

    return notFound();
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const store = new R2BindingStore(env.PHOTOS);
    const report = await runMaintenance(store, () => new Date());
    // The cron just changed the catalog; the next request must not serve a
    // cached copy that still contains purged photos.
    resetCatalogCache();
    // Operational summary; visible in `wrangler tail` and the Cloudflare log.
    // eslint-disable-next-line no-console
    console.log('Maintenance complete', JSON.stringify(report));
  },
};
