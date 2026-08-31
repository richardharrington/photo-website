/**
 * The two R2 client surfaces report a failed conditional write in
 * structurally different ways, and getting either one wrong loses data
 * silently (decisions.md #22):
 *
 *   - S3 API: **throws** an error carrying HTTP 412.
 *   - Workers binding: **returns null without throwing**.
 *
 * So a bare try/catch is wrong on the binding path — a lost race would look
 * like a completed write — and a "did it return something?" check is wrong on
 * the S3 path. These tests pin each adapter's translation to the normalized
 * `{ ok: false }` that the retry loop above them expects.
 */

import { describe, it, expect, vi } from 'vitest';
import { isPreconditionFailure } from '../../netlify/functions/lib/s3-store.ts';
import { R2BindingStore } from '../../worker/src/binding-store.ts';
import type { R2Like, R2ObjectLike } from '../../worker/src/binding-store.ts';

const BODY = new TextEncoder().encode('{}');

// ---------------------------------------------------------------------------
// S3 API surface
// ---------------------------------------------------------------------------

describe('S3 precondition detection', () => {
  it('recognizes a 412 from the response metadata', () => {
    expect(isPreconditionFailure({ $metadata: { httpStatusCode: 412 } })).toBe(true);
  });

  it('recognizes the named precondition errors', () => {
    expect(isPreconditionFailure({ name: 'PreconditionFailed' })).toBe(true);
    expect(isPreconditionFailure({ name: 'ConditionalRequestConflict' })).toBe(true);
  });

  it('does not mistake other failures for a lost race', () => {
    // These must propagate. Treating a credentials or network failure as a
    // conflict would make the retry loop spin on a fault it cannot resolve and
    // then report it as a write conflict.
    for (const error of [
      { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } },
      { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
      { name: 'InternalError', $metadata: { httpStatusCode: 500 } },
      new Error('socket hang up'),
      null,
      undefined,
      'a string',
    ]) {
      expect(isPreconditionFailure(error), JSON.stringify(error)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Workers binding surface
// ---------------------------------------------------------------------------

function r2Object(overrides: Partial<R2ObjectLike> = {}): R2ObjectLike {
  return {
    key: 'catalog/current.json',
    etag: 'etag-1',
    size: 2,
    uploaded: new Date('2026-08-31T00:00:00.000Z'),
    arrayBuffer: async () => new ArrayBuffer(2),
    ...overrides,
  };
}

/** A binding fake with the documented null-on-conflict behaviour. */
function fakeBucket(overrides: Partial<R2Like> = {}): R2Like {
  return {
    get: vi.fn(async () => r2Object()),
    head: vi.fn(async () => r2Object()),
    put: vi.fn(async () => r2Object()),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    delete: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('R2BindingStore.putConditional', () => {
  it('reports a null return as a conflict, not a success', async () => {
    // The defect this guards against: `await bucket.put(...)` inside a
    // try/catch does not throw here, so a naive adapter would return ok and
    // the caller would believe it had written.
    const bucket = fakeBucket({ put: vi.fn(async () => null) });
    const store = new R2BindingStore(bucket);

    const result = await store.putConditional(
      'catalog/current.json',
      BODY,
      { ifMatch: '"etag-1"' },
      'application/json',
    );

    expect(result).toEqual({ ok: false });
  });

  it('reports a returned object as a success, with its new ETag', async () => {
    const bucket = fakeBucket({
      put: vi.fn(async () => r2Object({ etag: 'etag-2' })),
    });
    const store = new R2BindingStore(bucket);

    const result = await store.putConditional(
      'catalog/current.json',
      BODY,
      { ifMatch: '"etag-1"' },
      'application/json',
    );

    expect(result).toEqual({ ok: true, etag: 'etag-2' });
  });

  it('strips quoting before handing an ETag to the binding', async () => {
    // The S3 surface hands back quoted ETags; the binding compares raw ones.
    // Passing a quoted value through would never match, turning every write
    // into a conflict and every mutation into a CatalogConflictError.
    const put = vi.fn(async () => r2Object());
    const store = new R2BindingStore(fakeBucket({ put }));

    await store.putConditional(
      'catalog/current.json',
      BODY,
      { ifMatch: 'W/"etag-1"' },
      'application/json',
    );

    expect(put).toHaveBeenCalledWith(
      'catalog/current.json',
      BODY,
      expect.objectContaining({ onlyIf: { etagMatches: 'etag-1' } }),
    );
  });

  it('expresses ifAbsent as the any-object wildcard', async () => {
    const put = vi.fn(async () => r2Object());
    const store = new R2BindingStore(fakeBucket({ put }));

    await store.putConditional(
      'catalog/current.json',
      BODY,
      { ifAbsent: true },
      'application/json',
    );

    expect(put).toHaveBeenCalledWith(
      'catalog/current.json',
      BODY,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    );
  });

  it('still propagates a genuine failure', async () => {
    const bucket = fakeBucket({
      put: vi.fn(async () => {
        throw new Error('R2 unavailable');
      }),
    });
    const store = new R2BindingStore(bucket);

    await expect(
      store.putConditional('k', BODY, { ifAbsent: true }, 'application/json'),
    ).rejects.toThrow('R2 unavailable');
  });
});

describe('R2BindingStore listing and deleting', () => {
  it('follows the list cursor to the end', async () => {
    const pages = [
      {
        objects: [r2Object({ key: 'a' })],
        truncated: true as const,
        cursor: 'next',
      },
      { objects: [r2Object({ key: 'b' })], truncated: false as const },
    ];
    let call = 0;
    const list = vi.fn(async () => pages[call++]!);
    const store = new R2BindingStore(fakeBucket({ list }));

    const result = await store.list('photos/');

    // A single-page read would silently miss every object past the first page,
    // which for the orphan sweep would mean never cleaning up most of them.
    expect(result.map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('batches deletes to the binding limit', async () => {
    const del = vi.fn(async (_keys: string | string[]) => {});
    const store = new R2BindingStore(fakeBucket({ delete: del }));
    const keys = Array.from({ length: 2300 }, (_, i) => `photos/${i}`);

    await store.delete(keys);

    expect(del).toHaveBeenCalledTimes(3);
    const batches = del.mock.calls.map(([keys]) => (keys as string[]).length);
    expect(batches).toEqual([1000, 1000, 300]);
  });

  it('does not call the binding for an empty delete', async () => {
    const del = vi.fn(async (_keys: string | string[]) => {});
    const store = new R2BindingStore(fakeBucket({ delete: del }));

    await store.delete([]);

    expect(del).not.toHaveBeenCalled();
  });

  it('returns null for a missing object rather than throwing', async () => {
    const store = new R2BindingStore(fakeBucket({ get: vi.fn(async () => null) }));
    expect(await store.get('missing')).toBeNull();
  });
});
