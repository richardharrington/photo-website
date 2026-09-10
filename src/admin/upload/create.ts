/**
 * Building an upload queue out of the real pipeline and the real API.
 *
 * Two places add photographs — the drop target, and the Inbox once an
 * administrator has ticked what to keep out of an emailed message — and they
 * must go in through *exactly* the same path: the same serial decode, the same
 * orientation decision, the same EXIF strip, the same duplicate check. A
 * second loop for emailed files would be a second pipeline to keep in
 * agreement with the first.
 *
 * So there is one factory, and the Inbox overrides one dependency: its commit
 * names the submission and the claim it holds, which is how the server
 * attributes the photograph to its sender.
 */

import { processFile, readSourceMetadata } from '../../pipeline/index.ts';
import { UploadQueue } from './queue.ts';
import type { QueueDependencies } from './queue.ts';
import { adminApi } from '../api.ts';

/**
 * PUT one artifact straight to R2 with its presigned URL.
 *
 * A cors-mode fetch, so the browser sends a real Origin header even under
 * `Referrer-Policy: no-referrer` — which is what the bucket's CORS rule keys
 * on.
 */
export async function uploadArtifact(
  url: string,
  artifact: { bytes: Uint8Array; contentType: string },
): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': artifact.contentType },
    body: artifact.bytes as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}).`);
  }
}

export function createQueue(overrides: Partial<QueueDependencies> = {}): UploadQueue {
  return new UploadQueue({
    processFile: (file, options) =>
      processFile(file, {
        // Encoding dominates; report progress as each artifact lands.
        onArtifact: () => options.onProgress(0.5),
        // Already read, so the date on the tile and the date committed are
        // the same value rather than two parses expected to agree.
        metadata: options.metadata,
      }),
    readMetadata: (file) => readSourceMetadata(file, file.name),
    editPhoto: async (photoId, edit) => (await adminApi.edit(photoId, edit)).photo,
    beginBatch: () => adminApi.beginBatch(),
    prepare: (hash, filename) => adminApi.prepare(hash, filename),
    uploadArtifact,
    commit: (body) => adminApi.commit(body),
    ...overrides,
  });
}
