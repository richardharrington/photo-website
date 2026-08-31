/**
 * The read-only display API.
 *
 * Thin on purpose: the projection from catalog to response lives in
 * src/shared/display-api.ts, so production, the development fixture server,
 * and the tests all answer with the same code.
 */

import {
  dayResponse,
  hierarchyResponse,
  photoResponse,
  undatedResponse,
} from '../../src/shared/display-api.ts';
import { getLivePhoto } from '../../src/shared/catalog.ts';
import { SIGNED_URL_TTL_SECONDS } from '../../src/shared/constants.ts';
import { isValidPhotoId } from '../../src/shared/ids.ts';
import { assetGrantPath, signAssetGrant } from '../../src/shared/signing.ts';
import { loadCatalog } from '../../src/shared/catalog-repository.ts';
import { S3ObjectStore } from './lib/s3-store.ts';
import {
  checkAccess,
  json,
  notFound,
  nowIso,
  nowSeconds,
  requiredEnv,
  serverError,
  subPath,
} from './lib/http.ts';

function store(): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: requiredEnv('R2_S3_ENDPOINT'),
    bucket: requiredEnv('R2_BUCKET'),
    accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  });
}

const DAY_ROUTE = /^\/day\/(\d{4})\/(\d{2})\/(\d{2})$/;
const PHOTO_ROUTE = /^\/photo\/([0-9a-f]{32})$/;
const DOWNLOAD_ROUTE = /^\/download\/([0-9a-f]{32})$/;

export default async function handler(request: Request): Promise<Response> {
  const refusal = checkAccess(request, 'display');
  if (refusal) return refusal;

  if (request.method !== 'GET') return notFound();

  const path = subPath(request, 'display');

  try {
    const { catalog } = await loadCatalog(store(), nowIso);

    if (path === '/hierarchy') {
      return json(
        hierarchyResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'),
      );
    }

    if (path === '/undated') return json(undatedResponse(catalog));

    const day = DAY_ROUTE.exec(path);
    if (day) {
      const [, year, month, dayOfMonth] = day as unknown as string[];
      const body = dayResponse(
        catalog,
        Number(year),
        Number(month),
        Number(dayOfMonth),
      );
      return body ? json(body) : notFound();
    }

    const photo = PHOTO_ROUTE.exec(path);
    if (photo) {
      const body = photoResponse(catalog, photo[1]!);
      return body ? json(body) : notFound();
    }

    const download = DOWNLOAD_ROUTE.exec(path);
    if (download) return downloadLink(catalog, download[1]!);

    return notFound();
  } catch (error) {
    console.error('Display API failure', error);
    return serverError();
  }
}

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
