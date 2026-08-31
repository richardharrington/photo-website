import { describe, it, expect, vi } from 'vitest';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import {
  CatalogConflictError,
  CatalogSchemaError,
  abortMutation,
  loadCatalog,
  mutateCatalog,
  snapshotsToPrune,
  writeMutation,
} from '../../src/shared/catalog-repository.ts';
import { CATALOG_SCHEMA_VERSION, emptyCatalog } from '../../src/shared/catalog.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import { R2_KEYS } from '../../src/shared/constants.ts';
import { encodeJson, etagsMatch, normalizeEtag } from '../../src/shared/store.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

const NOW = '2026-08-31T12:00:00.000Z';
const context = { now: () => NOW };

function storeWithCatalog(catalog: Catalog): InMemoryObjectStore {
  const store = new InMemoryObjectStore();
  store.seed(R2_KEYS.catalog, encodeJson(catalog));
  return store;
}

describe('etag normalization', () => {
  it('ignores quoting and weak validators', () => {
    // A store hands back a quoted ETag; a comparison that missed this would
    // see every conditional write as a conflict against its own value.
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(etagsMatch('"abc"', 'abc')).toBe(true);
    expect(etagsMatch('W/"abc"', '"abc"')).toBe(true);
    expect(etagsMatch('"abc"', '"abd"')).toBe(false);
  });
});

/**
 * The semantics implementation-plan.md requires be asserted explicitly rather
 * than inherited from an emulator. Miniflare's R2 `onlyIf` handling has been
 * reported inverted, so a backwards implementation could pass against it.
 */
describe('in-memory store conditional-write semantics', () => {
  const body = encodeJson({ hello: 'world' });

  it('ifAbsent succeeds only when nothing is stored', async () => {
    const store = new InMemoryObjectStore();

    const first = await store.putConditional(
      'k',
      body,
      { ifAbsent: true },
      'application/json',
    );
    expect(first.ok).toBe(true);

    const second = await store.putConditional(
      'k',
      body,
      { ifAbsent: true },
      'application/json',
    );
    expect(second.ok).toBe(false);
  });

  it('ifMatch succeeds only against the current ETag', async () => {
    const store = new InMemoryObjectStore();
    const created = await store.putConditional(
      'k',
      body,
      { ifAbsent: true },
      'application/json',
    );
    expect(created.ok).toBe(true);
    const etag = created.ok ? created.etag : '';

    const stale = await store.putConditional(
      'k',
      body,
      { ifMatch: '"nope"' },
      'application/json',
    );
    expect(stale.ok).toBe(false);

    const current = await store.putConditional(
      'k',
      body,
      { ifMatch: etag },
      'application/json',
    );
    expect(current.ok).toBe(true);
  });

  it('ifMatch fails when the object does not exist', async () => {
    const store = new InMemoryObjectStore();
    const result = await store.putConditional(
      'k',
      body,
      { ifMatch: '"x"' },
      'application/json',
    );
    expect(result.ok).toBe(false);
  });

  it('a failed precondition writes nothing and does not throw', async () => {
    const store = new InMemoryObjectStore();
    await store.putConditional(
      'k',
      encodeJson({ v: 1 }),
      { ifAbsent: true },
      'application/json',
    );

    const result = await store.putConditional(
      'k',
      encodeJson({ v: 2 }),
      { ifMatch: '"stale"' },
      'application/json',
    );

    expect(result.ok).toBe(false);
    expect(store.readJson('k')).toEqual({ v: 1 });
  });

  it('issues a fresh ETag on every successful write', async () => {
    const store = new InMemoryObjectStore();
    await store.putConditional('k', body, { ifAbsent: true }, 'application/json');
    const first = store.etagOf('k');
    await store.putConditional('k', body, { ifMatch: first! }, 'application/json');

    expect(store.etagOf('k')).not.toBe(first);
    // ...so the previous ETag is now detectably stale.
    const replay = await store.putConditional(
      'k',
      body,
      { ifMatch: first! },
      'application/json',
    );
    expect(replay.ok).toBe(false);
  });
});

describe('loadCatalog', () => {
  it('returns an empty catalog and a null ETag for a new bucket', async () => {
    const store = new InMemoryObjectStore();
    const loaded = await loadCatalog(store, () => NOW);

    expect(loaded.etag).toBeNull();
    expect(loaded.catalog).toEqual(emptyCatalog(NOW));
  });

  it('returns the stored catalog with its ETag', async () => {
    const catalog = emptyCatalog('2026-01-01T00:00:00.000Z');
    const store = storeWithCatalog(catalog);
    const loaded = await loadCatalog(store, () => NOW);

    expect(loaded.catalog).toEqual(catalog);
    expect(loaded.etag).toBe(store.etagOf(R2_KEYS.catalog));
  });

  it('refuses a catalog written by a newer schema', async () => {
    // Reading it as though it were the current shape and writing it back is
    // how a rollback quietly destroys data.
    const store = storeWithCatalog({
      ...emptyCatalog(NOW),
      schemaVersion: CATALOG_SCHEMA_VERSION + 1,
    });

    await expect(loadCatalog(store, () => NOW)).rejects.toThrow(CatalogSchemaError);
  });
});

describe('mutateCatalog', () => {
  it('creates the first catalog with an ifAbsent write', async () => {
    const store = new InMemoryObjectStore();

    const result = await mutateCatalog(store, context, (catalog) =>
      writeMutation({ ...catalog, batchCounter: 1 }, 'done'),
    );

    expect(result).toBe('done');
    expect(store.readJson<Catalog>(R2_KEYS.catalog)?.batchCounter).toBe(1);
  });

  it('stamps updatedAt from the caller clock', async () => {
    const store = new InMemoryObjectStore();
    await mutateCatalog(store, context, (catalog) => writeMutation(catalog, null));

    expect(store.readJson<Catalog>(R2_KEYS.catalog)?.updatedAt).toBe(NOW);
  });

  it('writes a snapshot alongside the catalog', async () => {
    const store = new InMemoryObjectStore();
    await mutateCatalog(store, context, (catalog) => writeMutation(catalog, null));

    const snapshots = store.keys().filter((k) => k.startsWith(R2_KEYS.snapshotPrefix));
    expect(snapshots).toHaveLength(1);
    expect(store.readJson<Catalog>(snapshots[0]!)?.updatedAt).toBe(NOW);
  });

  it('does not write, or snapshot, when the mutation aborts', async () => {
    const store = storeWithCatalog(emptyCatalog(NOW));
    const before = store.etagOf(R2_KEYS.catalog);

    const result = await mutateCatalog(store, context, () =>
      abortMutation('already-present'),
    );

    expect(result).toBe('already-present');
    expect(store.etagOf(R2_KEYS.catalog)).toBe(before);
    expect(store.keys().filter((k) => k.startsWith(R2_KEYS.snapshotPrefix))).toEqual(
      [],
    );
  });

  it('retries against the winner rather than overwriting it', async () => {
    const store = storeWithCatalog(emptyCatalog(NOW));
    let attempts = 0;

    // A competing writer lands between this writer's read and its write —
    // exactly the race the conditional write exists to catch.
    store.onBeforeConditionalWrite = async () => {
      if (attempts !== 1) return;
      const current = store.readJson<Catalog>(R2_KEYS.catalog)!;
      store.seed(
        R2_KEYS.catalog,
        encodeJson({
          ...current,
          photos: { ...current.photos, [other.id]: other },
        }),
      );
    };

    const other = makePhoto({ id: testPhotoId('other') });
    const mine = makePhoto({ id: testPhotoId('mine') });

    await mutateCatalog(store, context, (catalog) => {
      attempts += 1;
      return writeMutation(
        { ...catalog, photos: { ...catalog.photos, [mine.id]: mine } },
        null,
      );
    });

    expect(attempts).toBe(2);
    const stored = store.readJson<Catalog>(R2_KEYS.catalog)!;
    // Both writers' photos survive: the retry re-applied against the winner.
    expect(Object.keys(stored.photos).sort()).toEqual([mine.id, other.id].sort());
  });

  it('re-runs the mutation on the reloaded catalog, not the stale one', async () => {
    const store = storeWithCatalog({ ...emptyCatalog(NOW), batchCounter: 5 });
    const seen: number[] = [];
    let raced = false;

    store.onBeforeConditionalWrite = () => {
      if (raced) return;
      raced = true;
      const current = store.readJson<Catalog>(R2_KEYS.catalog)!;
      store.seed(R2_KEYS.catalog, encodeJson({ ...current, batchCounter: 9 }));
    };

    const assigned = await mutateCatalog(store, context, (catalog) => {
      seen.push(catalog.batchCounter);
      const next = catalog.batchCounter + 1;
      return writeMutation({ ...catalog, batchCounter: next }, next);
    });

    // The second run saw 9, not the stale 5, so the counter cannot regress.
    expect(seen).toEqual([5, 9]);
    expect(assigned).toBe(10);
    expect(store.readJson<Catalog>(R2_KEYS.catalog)?.batchCounter).toBe(10);
  });

  it('gives up after the attempt limit rather than looping forever', async () => {
    const store = storeWithCatalog(emptyCatalog(NOW));
    // A writer that always loses.
    store.onBeforeConditionalWrite = () => {
      const current = store.readJson<Catalog>(R2_KEYS.catalog)!;
      store.seed(R2_KEYS.catalog, encodeJson({ ...current }));
    };

    await expect(
      mutateCatalog(store, context, (catalog) => writeMutation(catalog, null), {
        maxAttempts: 3,
      }),
    ).rejects.toThrow(CatalogConflictError);
  });

  it('does not fail the mutation when the snapshot write fails', async () => {
    // The catalog change is the thing that matters; a lost snapshot is
    // recoverable, an aborted mutation that already succeeded is not.
    const store = new InMemoryObjectStore();
    const realPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, body, type) => {
      if (key.startsWith(R2_KEYS.snapshotPrefix)) throw new Error('snapshot failed');
      return realPut(key, body, type);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await mutateCatalog(store, context, (catalog) =>
      writeMutation({ ...catalog, batchCounter: 3 }, 'ok'),
    );

    expect(result).toBe('ok');
    expect(store.readJson<Catalog>(R2_KEYS.catalog)?.batchCounter).toBe(3);
    expect(errorSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('can skip the snapshot when the caller asks', async () => {
    const store = new InMemoryObjectStore();
    await mutateCatalog(store, context, (catalog) => writeMutation(catalog, null), {
      snapshot: false,
    });

    expect(store.keys().filter((k) => k.startsWith(R2_KEYS.snapshotPrefix))).toEqual(
      [],
    );
  });
});

describe('snapshotsToPrune', () => {
  const nowMs = Date.parse('2026-08-31T00:00:00.000Z');
  const daysAgo = (days: number, hour = 0) =>
    new Date(nowMs - days * 86_400_000 + hour * 3_600_000);

  it('keeps everything inside the full-retention window', () => {
    const snapshots = [
      { key: 'a', uploadedAt: daysAgo(1) },
      { key: 'b', uploadedAt: daysAgo(1, 5) },
      { key: 'c', uploadedAt: daysAgo(29) },
    ];

    expect(snapshotsToPrune(snapshots, nowMs)).toEqual([]);
  });

  it('thins older snapshots to one per calendar day', () => {
    const snapshots = [
      { key: 'old-morning', uploadedAt: daysAgo(60, 1) },
      { key: 'old-noon', uploadedAt: daysAgo(60, 12) },
      { key: 'old-evening', uploadedAt: daysAgo(60, 22) },
      { key: 'other-day', uploadedAt: daysAgo(61, 3) },
    ];

    const doomed = snapshotsToPrune(snapshots, nowMs);

    // The newest snapshot of each old day survives.
    expect(doomed.sort()).toEqual(['old-morning', 'old-noon']);
  });

  it('keeps a single old snapshot for its day', () => {
    expect(
      snapshotsToPrune([{ key: 'lonely', uploadedAt: daysAgo(90) }], nowMs),
    ).toEqual([]);
  });

  it('handles an empty list', () => {
    expect(snapshotsToPrune([], nowMs)).toEqual([]);
  });
});
