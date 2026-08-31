/**
 * ObjectStore over the native R2 binding, for the Cloudflare Worker.
 *
 * The conflict shape here is the opposite of the S3 adapter's:
 * `put(key, value, { onlyIf: { etagMatches } })` signals a failed precondition
 * by **returning `null` without throwing** (decisions.md #22). A bare
 * `try`/`catch` on this surface therefore sees a successful-looking call and
 * would report a lost race as a completed write — silently discarding whatever
 * the other writer stored.
 *
 * So the null return is the check, and a thrown error still means a real
 * failure.
 */

import { normalizeEtag } from '../../src/shared/store.ts';
import type {
  ConditionalWriteResult,
  ObjectStore,
  ObjectSummary,
  StoredObject,
  WriteCondition,
} from '../../src/shared/store.ts';

/**
 * The subset of the R2 binding this adapter uses, declared structurally so the
 * adapter can be unit-tested against a fake without a Workers runtime.
 */
export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<R2ObjectLike | null>;
  list(options: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface R2ObjectLike {
  key: string;
  etag: string;
  size: number;
  uploaded: Date;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export class R2BindingStore implements ObjectStore {
  constructor(private readonly bucket: R2Like) {}

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object?.arrayBuffer) return null;
    return {
      body: new Uint8Array(await object.arrayBuffer()),
      etag: object.etag,
    };
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return { size: object.size, etag: object.etag };
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async putConditional(
    key: string,
    body: Uint8Array,
    condition: WriteCondition,
    contentType: string,
  ): Promise<ConditionalWriteResult> {
    const onlyIf =
      'ifAbsent' in condition
        ? // "Write only if absent" is expressed as "the ETag matches nothing
          // that exists"; `*` is the any-object wildcard.
          { etagDoesNotMatch: '*' }
        : { etagMatches: normalizeEtag(condition.ifMatch) };

    const result = await this.bucket.put(key, body, {
      httpMetadata: { contentType },
      onlyIf,
    });

    // A null return is the conflict. It is an ordinary return value here, not
    // an exception, which is precisely why this cannot be written as a
    // try/catch the way the S3 adapter is.
    if (result === null) return { ok: false };

    return { ok: true, etag: result.etag };
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    const summaries: ObjectSummary[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.bucket.list({ prefix, cursor });
      for (const object of page.objects) {
        summaries.push({
          key: object.key,
          size: object.size,
          uploadedAt: object.uploaded,
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return summaries;
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    // The binding accepts at most 1000 keys per delete call.
    for (let i = 0; i < keys.length; i += 1000) {
      await this.bucket.delete(keys.slice(i, i + 1000));
    }
  }
}
