/**
 * ObjectStore over the R2 S3-compatible API, for Netlify Functions.
 *
 * The important part is `putConditional`. On this surface a failed
 * precondition arrives as a *thrown* error carrying HTTP 412, not as a return
 * value — the opposite of the Workers binding, where it is a `null` return
 * with no throw (decisions.md #22). This adapter catches exactly that case and
 * turns it into `{ ok: false }`; every other error still propagates, because a
 * credentials failure or a network fault is not a lost race and must not be
 * retried as though the catalog had merely moved on.
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  ObjectStore,
  ObjectSummary,
  StoredObject,
  WriteCondition,
} from '../../../src/shared/store.ts';
import type { ConditionalWriteResult } from '../../../src/shared/store.ts';

export interface S3StoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores the region but the SDK requires one. */
  region?: string;
}

/** True for the "someone else wrote first" outcome, and nothing else. */
export function isPreconditionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.$metadata?.httpStatusCode === 412) return true;
  return (
    candidate.name === 'PreconditionFailed' ||
    // If-None-Match conflicts surface under this name on S3-compatible APIs.
    candidate.name === 'ConditionalRequestConflict'
  );
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof stream?.transformToByteArray === 'function') {
    return stream.transformToByteArray();
  }
  throw new Error('Unexpected S3 response body type.');
}

function isNoSuchKey(error: unknown): boolean {
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region ?? 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        body: await toBytes(response.Body),
        etag: response.ETag ?? '',
      };
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: response.ContentLength ?? 0, etag: response.ETag ?? '' };
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async putConditional(
    key: string,
    body: Uint8Array,
    condition: WriteCondition,
    contentType: string,
  ): Promise<ConditionalWriteResult> {
    const guard =
      'ifAbsent' in condition ? { IfNoneMatch: '*' } : { IfMatch: condition.ifMatch };

    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...guard,
        }),
      );
      return { ok: true, etag: response.ETag ?? '' };
    } catch (error) {
      // Only a precondition failure is a lost race. Anything else — bad
      // credentials, a network fault, a missing bucket — must propagate, or
      // the retry loop would spin on a fault it cannot resolve and eventually
      // report it as a write conflict.
      if (isPreconditionFailure(error)) return { ok: false };
      throw error;
    }
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    const summaries: ObjectSummary[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue;
        summaries.push({
          key: object.Key,
          size: object.Size ?? 0,
          uploadedAt: object.LastModified ?? new Date(0),
        });
      }
      // Paginate: a library of a few thousand photos exceeds one page.
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return summaries;
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    // DeleteObjects accepts at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }
}
