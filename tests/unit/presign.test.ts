import { describe, expect, it } from 'vitest';
import { presignedUploadUrls } from '../../netlify/functions/lib/presign.ts';
import { originOf } from '../../src/shared/headers.ts';
import { RENDITIONS, photoObjectKey } from '../../src/shared/constants.ts';

/**
 * The presigned upload URLs must stay on the endpoint's own origin.
 *
 * The admin app's CSP allows `connect-src` from `originOf(R2_S3_ENDPOINT)`
 * and nothing else, so a signed URL on any other origin is refused by the
 * browser before the request leaves — a bare "Failed to fetch" with no
 * request on the wire and no server-side trace. That is what the AWS SDK's
 * default virtual-hosted addressing produces, signing against
 * `<bucket>.<account>.r2.cloudflarestorage.com`, so `presign.ts` sets
 * `forcePathStyle`. This test is what keeps that from being quietly undone.
 */

const CONFIG = {
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  bucket: 'family-photos',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
};

const PHOTO_ID = 'a'.repeat(32);

describe('presignedUploadUrls', () => {
  it('signs every rendition on the endpoint origin the CSP allows', async () => {
    const uploads = await presignedUploadUrls(CONFIG, PHOTO_ID);
    const allowed = originOf(CONFIG.endpoint);

    for (const rendition of RENDITIONS) {
      expect(new URL(uploads[rendition]).origin).toBe(allowed);
    }
  });

  it('never puts the bucket in the hostname', async () => {
    const uploads = await presignedUploadUrls(CONFIG, PHOTO_ID);

    for (const rendition of RENDITIONS) {
      expect(new URL(uploads[rendition]).hostname).not.toContain(CONFIG.bucket);
    }
  });

  it('scopes each URL to its own object key', async () => {
    const uploads = await presignedUploadUrls(CONFIG, PHOTO_ID);

    for (const rendition of RENDITIONS) {
      const { pathname } = new URL(uploads[rendition]);
      expect(pathname).toBe(`/${CONFIG.bucket}/${photoObjectKey(PHOTO_ID, rendition)}`);
    }
  });

  it('produces a signature that expires', async () => {
    const uploads = await presignedUploadUrls(CONFIG, PHOTO_ID);
    const params = new URL(uploads.thumb).searchParams;

    expect(params.get('X-Amz-Expires')).toBe(String(30 * 60));
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]+$/);
  });
});
