/**
 * The display API, which is the family's API (family-tier.md #1).
 *
 * It answers the read routes, `/download/<id>`, and the curation routes in
 * `lib/curation-routes.ts` — adding, editing, moving to the trash, restoring,
 * and deleting permanently what this browser added — and nothing else. Bulk
 * captions, the Inbox, Emails, and the export live only in `admin.ts`, and
 * nothing admin-only is imported here, so
 * a display-mode request for one of them is the plain 404 by construction.
 *
 * Thin on purpose: the projection from catalog to response lives in
 * src/shared/display-api.ts, and the mutations in the shared route module, so
 * production, the development fixture server, and the tests all answer with
 * the same code.
 */

import { getLivePhoto } from '../../src/shared/catalog.ts';
import { SIGNED_URL_TTL_SECONDS } from '../../src/shared/constants.ts';
import { isValidPhotoId } from '../../src/shared/ids.ts';
import { assetGrantPath, signAssetGrant } from '../../src/shared/signing.ts';
import { loadCatalog } from '../../src/shared/catalog-repository.ts';
import type { ObjectStore } from '../../src/shared/store.ts';
import { S3ObjectStore, s3Config } from './lib/s3-store.ts';
import { readRoute } from './lib/read-routes.ts';
import { curationRoute } from './lib/curation-routes.ts';
import {
  checkAccess,
  json,
  notFound,
  nowIso,
  nowMs,
  nowSeconds,
  requiredEnv,
  serverError,
  subPath,
} from './lib/http.ts';

const DOWNLOAD_ROUTE = /^\/download\/([0-9a-f]{32})$/;

/**
 * The handler, over whichever store it is given. Production binds it to R2
 * below; the whitelist test binds it to an in-memory store.
 */
export function createHandler(store: () => ObjectStore) {
  return async function handler(request: Request): Promise<Response> {
    const refusal = checkAccess(request, 'display');
    if (refusal) return refusal;

    const path = subPath(request, 'display');

    try {
      // Before the reads, only so a trash listing does not load the catalog
      // twice; the two route lists are disjoint.
      const curation = await curationRoute(request, path, 'display', store);
      if (curation) return curation;

      if (request.method !== 'GET') return notFound();

      const { catalog } = await loadCatalog(store(), nowIso);

      const read = readRoute(catalog, path, nowMs());
      if (read) return read;

      const download = DOWNLOAD_ROUTE.exec(path);
      if (download) return downloadLink(catalog, download[1]!);

      return notFound();
    } catch (error) {
      console.error('Display API failure', error);
      return serverError();
    }
  };
}

export default createHandler(() => new S3ObjectStore(s3Config()));

/**
 * Mint a short-lived signed URL for the full-resolution JPEG.
 *
 * Minted per request rather than embedded in the photo payload, so a
 * five-minute link cannot expire while someone is reading a caption. A trashed
 * photo gets a 404 here and would be refused by the Worker regardless.
 */
async function downloadLink(
  catalog: Parameters<typeof getLivePhoto>[0],
  photoId: string,
): Promise<Response> {
  if (!isValidPhotoId(photoId)) return notFound();

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
