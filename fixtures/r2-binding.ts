/**
 * An R2 binding backed by the in-memory store.
 *
 * The Worker is exercised through the same adapter it uses in production, so
 * the conditional-write semantics under test are `InMemoryObjectStore`'s
 * explicitly asserted ones and not an emulator's (decisions.md #22).
 */

import type { InMemoryObjectStore } from './in-memory-store.ts';
import type { R2Like, R2ObjectLike } from '../worker/src/binding-store.ts';

export function bindingFor(store: InMemoryObjectStore): R2Like {
  const toObject = (key: string, body: Uint8Array): R2ObjectLike => ({
    key,
    etag: store.etagOf(key) ?? '',
    size: body.byteLength,
    uploaded: new Date('2026-08-31T00:00:00.000Z'),
    body: new Blob([body as BlobPart]).stream(),
    arrayBuffer: async () => body.buffer.slice(0) as ArrayBuffer,
  });

  return {
    async get(key) {
      const found = await store.get(key);
      return found ? toObject(key, found.body) : null;
    },
    async head(key) {
      const found = await store.head(key);
      return found
        ? {
            key,
            etag: found.etag,
            size: found.size,
            uploaded: new Date('2026-08-31T00:00:00.000Z'),
          }
        : null;
    },
    async put(key, value, options) {
      const result = await store.putConditional(
        key,
        value,
        options?.onlyIf?.etagDoesNotMatch === '*'
          ? { ifAbsent: true }
          : { ifMatch: options?.onlyIf?.etagMatches ?? '' },
        options?.httpMetadata?.contentType ?? 'application/octet-stream',
      );
      if (!options?.onlyIf) {
        await store.put(
          key,
          value,
          options?.httpMetadata?.contentType ?? 'application/octet-stream',
        );
        return toObject(key, value);
      }
      // The binding's conflict shape: null, without throwing.
      return result.ok ? toObject(key, value) : null;
    },
    async list({ prefix }) {
      const objects = await store.list(prefix ?? '');
      return {
        objects: objects.map((entry) => ({
          key: entry.key,
          etag: store.etagOf(entry.key) ?? '',
          size: entry.size,
          uploaded: entry.uploadedAt,
        })),
        truncated: false,
      };
    },
    async delete(keys) {
      await store.delete(typeof keys === 'string' ? [keys] : keys);
    },
  };
}
