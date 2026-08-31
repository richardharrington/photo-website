/**
 * Presigned upload URLs for the browser.
 *
 * `forcePathStyle` is the load-bearing option here, and it is not a
 * stylistic preference. The AWS SDK defaults to virtual-hosted addressing,
 * which signs URLs at `https://<bucket>.<account>.r2.cloudflarestorage.com`
 * — a *different origin* from the `R2_S3_ENDPOINT` the edge gate puts in the
 * admin app's CSP `connect-src`. The browser then refuses the upload before
 * it leaves, surfacing as a bare "Failed to fetch" with no request on the
 * wire and nothing logged on either side.
 *
 * Path style keeps the signed URL on the same origin the CSP already names,
 * which is also the form Cloudflare documents for R2. `presignedUploadUrls`
 * and the CSP therefore have to agree, and `tests/unit/presign.test.ts`
 * asserts exactly that.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  RENDITIONS,
  RENDITION_SPECS,
  photoObjectKey,
} from '../../../src/shared/constants.ts';
import type { Rendition } from '../../../src/shared/constants.ts';

/** How long a browser has to PUT its artifacts before the URLs go stale. */
export const UPLOAD_URL_TTL_SECONDS = 30 * 60;

export interface PresignConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function uploadClient(config: PresignConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    // See the note above: this must stay true, or uploads fail in the browser.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * One URL per stored artifact, each scoped to exactly that key and content
 * type, so a leaked URL cannot be used to write anything else into the
 * bucket.
 */
export async function presignedUploadUrls(
  config: PresignConfig,
  photoId: string,
): Promise<Record<Rendition, string>> {
  const client = uploadClient(config);
  const uploads = {} as Record<Rendition, string>;

  for (const rendition of RENDITIONS) {
    uploads[rendition] = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: photoObjectKey(photoId, rendition),
        ContentType: RENDITION_SPECS[rendition].contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

  return uploads;
}
