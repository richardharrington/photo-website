import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { resetCatalogCache } from '../../worker/src/index.ts';
import type { Env } from '../../worker/src/index.ts';
import type { R2Like, R2ObjectLike } from '../../worker/src/binding-store.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';
import { R2_KEYS, photoObjectKey } from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import { assetGrantPath, signAssetGrant } from '../../src/shared/signing.ts';
import { ROBOTS_DIRECTIVE } from '../../src/shared/headers.ts';
import type { Catalog } from '../../src/shared/catalog.ts';

const KEY = 'worker-test-signing-key';
const LIVE = FIXTURE_PHOTO_IDS['market']!;
const TRASHED = FIXTURE_PHOTO_IDS['deleted-0']!;
const UNKNOWN = 'f'.repeat(32);

/**
 * An R2 binding backed by the in-memory store, so the Worker is exercised
 * through the same adapter it uses in production.
 */
function bindingFor(store: InMemoryObjectStore): R2Like {
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

function makeEnv(catalog: Catalog = fixtureCatalog()): {
  env: Env;
  store: InMemoryObjectStore;
} {
  const store = new InMemoryObjectStore();
  store.seed(R2_KEYS.catalog, encodeJson(catalog));

  // Give every photo in the catalog its four objects.
  for (const photo of Object.values(catalog.photos)) {
    for (const rendition of [
      'full',
      'thumb',
      'display-1280',
      'display-2560',
    ] as const) {
      store.seed(
        photoObjectKey(photo.id, rendition),
        new TextEncoder().encode(`${photo.id}:${rendition}`),
      );
    }
  }

  return { env: { PHOTOS: bindingFor(store), ASSET_SIGNING_KEY: KEY }, store };
}

function get(path: string): Request {
  return new Request(`https://photo-assets.test${path}`);
}

beforeEach(() => resetCatalogCache());
afterEach(() => vi.restoreAllMocks());

describe('capability URLs', () => {
  it('serves a display derivative for a live photo', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${LIVE}/thumb`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
  });

  it('caches derivatives immutably, since the URL never changes', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${LIVE}/display-1280`), env);

    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('carries the no-index and no-referrer headers on an image', async () => {
    // An image cannot hold a robots meta tag, which is the whole reason the
    // Worker exists rather than making the bucket public.
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${LIVE}/thumb`), env);

    expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS_DIRECTIVE);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('refuses a trashed photo', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${TRASHED}/thumb`), env);

    expect(response.status).toBe(404);
  });

  it('refuses an unknown photo identically', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${UNKNOWN}/thumb`), env);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  it('never serves the full-resolution original unsigned', async () => {
    // Knowing the photo ID must not be enough to download the original.
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${LIVE}/full`), env);

    expect(response.status).toBe(404);
  });

  it('refuses malformed IDs and unknown renditions', async () => {
    const { env } = makeEnv();
    for (const path of [
      `/p/not-an-id/thumb`,
      `/p/${LIVE}/enormous`,
      `/p/${LIVE}`,
      `/p/${LIVE}/thumb/extra`,
      `/`,
      `/catalog/current.json`,
    ]) {
      const response = await worker.fetch(get(path), env);
      expect(response.status, path).toBe(404);
    }
  });

  it('does not cache a 404, so a restore takes effect promptly', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(`/p/${TRASHED}/thumb`), env);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a write attempt', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request(`https://photo-assets.test/p/${LIVE}/thumb`, { method: 'PUT' }),
      env,
    );

    expect(response.status).toBe(404);
  });
});

describe('signed URLs', () => {
  async function signedPath(photoId: string, rendition: string, ttl = 300) {
    const grant = {
      photoId,
      rendition,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
    return assetGrantPath(grant, await signAssetGrant(KEY, grant));
  }

  it('serves the full-resolution original with a download filename', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(await signedPath(LIVE, 'full')), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="IMG_20260815_100500.jpg"',
    );
  });

  it('refuses every signed URL when the signing key is not set', async () => {
    // A missing secret is a deployment fault. Unguarded, Web Crypto rejects
    // the zero-length HMAC key with a DataError and Cloudflare turns that
    // into a 1101 error page — which happened in production. Fail closed and
    // say so in the log instead, the way the Netlify gate does.
    const path = await signedPath(LIVE, 'full');
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const key of ['', undefined as unknown as string]) {
      const { env } = makeEnv();
      const response = await worker.fetch(get(path), {
        ...env,
        ASSET_SIGNING_KEY: key,
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    }

    expect(console_).toHaveBeenCalledWith(
      'ASSET_SIGNING_KEY is not set; refusing every signed URL.',
    );
    console_.mockRestore();
  });

  it('keeps a signed response out of caches', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(await signedPath(LIVE, 'full')), env);

    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('serves a trashed photo thumbnail, which the trash view needs', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(await signedPath(TRASHED, 'thumb')), env);

    expect(response.status).toBe(200);
  });

  it('refuses the full-resolution original for a trashed photo', async () => {
    // A trashed photo must not be downloadable. The admin API never signs
    // this; the Worker refuses it regardless.
    const { env } = makeEnv();
    const response = await worker.fetch(get(await signedPath(TRASHED, 'full')), env);

    expect(response.status).toBe(404);
  });

  it('refuses an expired signature', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(get(await signedPath(LIVE, 'full', -10)), env);

    expect(response.status).toBe(404);
  });

  it('refuses a tampered signature, expiry, photo, or rendition', async () => {
    const { env } = makeEnv();
    const valid = await signedPath(LIVE, 'thumb');
    const [path, query] = valid.split('?') as [string, string];
    const params = new URLSearchParams(query);

    const tampered = [
      `${path}?exp=${params.get('exp')}&sig=${'0'.repeat(64)}`,
      `${path}?exp=${Number(params.get('exp')) + 86_400}&sig=${params.get('sig')}`,
      `/d/${UNKNOWN}/thumb?${query}`,
      `/d/${LIVE}/full?${query}`,
      `${path}?exp=${params.get('exp')}`,
      path,
    ];

    for (const attempt of tampered) {
      const response = await worker.fetch(get(attempt), env);
      expect(response.status, attempt).toBe(404);
    }
  });

  it('refuses a signature made with a different key', async () => {
    const { env } = makeEnv();
    const grant = {
      photoId: LIVE,
      rendition: 'full',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
    const wrong = await signAssetGrant('some-other-key', grant);

    const response = await worker.fetch(get(assetGrantPath(grant, wrong)), env);
    expect(response.status).toBe(404);
  });
});

describe('catalog caching', () => {
  it('does not read the catalog on every image request', async () => {
    const { env, store } = makeEnv();

    await worker.fetch(get(`/p/${LIVE}/thumb`), env);
    const afterFirst = store.calls.filter((c) => c === `get ${R2_KEYS.catalog}`).length;

    await worker.fetch(get(`/p/${LIVE}/display-1280`), env);
    await worker.fetch(get(`/p/${LIVE}/display-2560`), env);
    const afterThird = store.calls.filter((c) => c === `get ${R2_KEYS.catalog}`).length;

    expect(afterFirst).toBe(1);
    expect(afterThird).toBe(1);
  });

  it('re-reads once the cache window has passed', async () => {
    const { env, store } = makeEnv();
    const envShortTtl: Env = { ...env, CATALOG_CACHE_SECONDS: '0' };

    await worker.fetch(get(`/p/${LIVE}/thumb`), envShortTtl);
    await worker.fetch(get(`/p/${LIVE}/thumb`), envShortTtl);

    expect(
      store.calls.filter((c) => c === `get ${R2_KEYS.catalog}`).length,
    ).toBeGreaterThan(1);
  });
});
