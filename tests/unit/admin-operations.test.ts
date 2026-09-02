import { describe, it, expect } from 'vitest';
import {
  beginBatch,
  commitPhoto,
  editPhotoMetadata,
  objectKeysFor,
  permanentlyDeletePhotos,
  resolveSelection,
  resolveTrashedSelection,
  restorePhotos,
  trashPhotos,
} from '../../src/shared/admin-operations.ts';
import type { CommitInput } from '../../src/shared/admin-operations.ts';
import { mutateCatalog } from '../../src/shared/catalog-repository.ts';
import type { Mutation } from '../../src/shared/catalog-repository.ts';
import { emptyCatalog, isTrashed } from '../../src/shared/catalog.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import { R2_KEYS } from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';
import { makeCatalog, makePhoto, testPhotoId } from '../../fixtures/photos.ts';

const NOW = '2026-09-01T10:00:00.000Z';
const AUDIT = 'audit123';

/** Runs a mutation directly, without a store, to check its pure result. */
function apply<T>(mutation: Mutation<T>): { catalog: Catalog | null; value: T } {
  return {
    catalog: mutation.kind === 'write' ? mutation.catalog : null,
    value: mutation.value,
  };
}

function commitInput(overrides: Partial<CommitInput> = {}): CommitInput {
  const photo = makePhoto({ id: testPhotoId('new') });
  return {
    id: photo.id,
    contentHash: 'a'.repeat(64),
    originalFilename: 'IMG_0100.HEIC',
    downloadFilename: 'IMG_0100.jpg',
    sourceMimeType: 'image/heic',
    captureDate: '2026-09-01',
    captureTime: '12:00:00',
    captureUtcOffset: null,
    timestampSource: 'exif-datetimeoriginal',
    caption: null,
    batchSeq: 7,
    selectionIndex: 0,
    derivatives: photo.derivatives,
    ...overrides,
  };
}

describe('beginBatch', () => {
  it('hands out increasing sequence numbers', () => {
    const first = apply(beginBatch(emptyCatalog(NOW)));
    expect(first.value).toBe(1);

    const second = apply(beginBatch(first.catalog!));
    expect(second.value).toBe(2);
  });

  it('is the only pre-commit write, and leaves only a gap if abandoned', async () => {
    const store = new InMemoryObjectStore();

    const a = await mutateCatalog(store, { now: () => NOW }, beginBatch);
    const b = await mutateCatalog(store, { now: () => NOW }, beginBatch);

    expect([a, b]).toEqual([1, 2]);
    // No photo records were created by reserving batch numbers.
    expect(store.readJson<Catalog>(R2_KEYS.catalog)?.photos).toEqual({});
  });
});

describe('commitPhoto', () => {
  it('creates a record for a fully uploaded photo', () => {
    const input = commitInput();
    const result = apply(commitPhoto(emptyCatalog(NOW), input, NOW, AUDIT));

    expect(result.value).toMatchObject({ status: 'created' });
    const stored = result.catalog!.photos[input.id]!;
    expect(stored.createdAt).toBe(NOW);
    expect(stored.trashedAt).toBeNull();
    expect(stored.createdAuditId).toBe(AUDIT);
  });

  it('reports an existing hash as a duplicate and writes nothing', () => {
    const existing = makePhoto({ id: testPhotoId('old'), contentHash: 'a'.repeat(64) });
    const catalog = makeCatalog([existing]);

    const result = apply(commitPhoto(catalog, commitInput(), NOW, AUDIT));

    expect(result.value).toEqual({ status: 'duplicate', existingId: existing.id });
    expect(result.catalog).toBeNull();
  });

  it('treats a trashed photo as a duplicate too', () => {
    // Re-uploading a file sitting in the trash should surface the existing
    // photo, not create a second copy of the same bytes.
    const trashed = makePhoto({
      id: testPhotoId('trashed'),
      contentHash: 'a'.repeat(64),
      trashedAt: NOW,
    });

    const result = apply(
      commitPhoto(makeCatalog([trashed]), commitInput(), NOW, AUDIT),
    );

    expect(result.value).toEqual({ status: 'duplicate', existingId: trashed.id });
  });

  it('does not overwrite a record when the same commit is retried', () => {
    const input = commitInput();
    const edited = makePhoto({
      id: input.id,
      contentHash: 'different-hash',
      caption: 'An edit made after the first commit',
    });

    const result = apply(commitPhoto(makeCatalog([edited]), input, NOW, AUDIT));

    expect(result.value).toEqual({ status: 'duplicate', existingId: input.id });
    expect(result.catalog).toBeNull();
  });

  /**
   * The race decisions.md #6 closes: two browsers uploading the same file both
   * pass the advisory prepare check, but hash uniqueness is enforced inside
   * the conditional write, so the loser's retry sees the winner's record.
   */
  it('lets only one of two concurrent uploads of the same file win', async () => {
    const store = new InMemoryObjectStore();
    store.seed(R2_KEYS.catalog, encodeJson(emptyCatalog(NOW)));

    const first = commitInput({ id: testPhotoId('first') });
    const second = commitInput({ id: testPhotoId('second') });
    let raced = false;

    // The competing writer commits between this one's read and its write.
    store.onBeforeConditionalWrite = () => {
      if (raced) return;
      raced = true;
      const current = store.readJson<Catalog>(R2_KEYS.catalog)!;
      const winner = commitPhoto(current, first, NOW, 'audit-first');
      if (winner.kind === 'write') {
        store.seed(R2_KEYS.catalog, encodeJson(winner.catalog));
      }
    };

    const outcome = await mutateCatalog(store, { now: () => NOW }, (catalog) =>
      commitPhoto(catalog, second, NOW, AUDIT),
    );

    expect(outcome).toEqual({ status: 'duplicate', existingId: first.id });
    const stored = store.readJson<Catalog>(R2_KEYS.catalog)!;
    expect(Object.keys(stored.photos)).toEqual([first.id]);
  });
});

describe('editPhotoMetadata', () => {
  const photo = makePhoto({
    id: testPhotoId('edit'),
    captureDate: '2026-08-02',
    captureTime: '17:48:50',
    caption: null,
  });
  const catalog = makeCatalog([photo]);

  it('applies a valid edit and records the previous values', () => {
    const result = apply(
      editPhotoMetadata(
        catalog,
        photo.id,
        { date: '2026-08-03', time: '09:15', caption: '  Corrected  ' },
        NOW,
        AUDIT,
      ),
    );

    expect(result.value).toMatchObject({ status: 'updated' });
    const updated = result.catalog!.photos[photo.id]!;
    expect(updated.captureDate).toBe('2026-08-03');
    expect(updated.captureTime).toBe('09:15:00');
    expect(updated.caption).toBe('Corrected');
    expect(updated.updatedAt).toBe(NOW);
  });

  it('marks a corrected timestamp as manual', () => {
    // So a later re-derivation cannot silently undo the correction.
    const result = apply(
      editPhotoMetadata(catalog, photo.id, { date: '2026-08-03' }, NOW, AUDIT),
    );

    expect(result.catalog!.photos[photo.id]!.timestampSource).toBe('manual');
  });

  it('leaves the timestamp source alone when only the caption changes', () => {
    const result = apply(
      editPhotoMetadata(
        catalog,
        photo.id,
        { date: '2026-08-02', time: '17:48:50', caption: 'Just a caption' },
        NOW,
        AUDIT,
      ),
    );

    expect(result.catalog!.photos[photo.id]!.timestampSource).toBe(
      'exif-datetimeoriginal',
    );
  });

  it('clears the time when the date is cleared', () => {
    const result = apply(
      editPhotoMetadata(catalog, photo.id, { date: '', time: '17:48' }, NOW, AUDIT),
    );

    const updated = result.catalog!.photos[photo.id]!;
    expect(updated.captureDate).toBeNull();
    expect(updated.captureTime).toBeNull();
  });

  it('re-validates on the server rather than trusting the client', () => {
    const result = apply(
      editPhotoMetadata(catalog, photo.id, { date: '2026-02-30' }, NOW, AUDIT),
    );

    expect(result.value).toMatchObject({ status: 'invalid' });
    expect(result.catalog).toBeNull();
  });

  it('refuses to edit an unknown or trashed photo', () => {
    expect(
      apply(editPhotoMetadata(catalog, testPhotoId('nope'), {}, NOW, AUDIT)).value,
    ).toEqual({ status: 'not-found' });

    const trashed = makeCatalog([makePhoto({ id: photo.id, trashedAt: NOW })]);
    expect(apply(editPhotoMetadata(trashed, photo.id, {}, NOW, AUDIT)).value).toEqual({
      status: 'not-found',
    });
  });
});

describe('trash, restore, and permanent delete', () => {
  const live = makePhoto({ id: testPhotoId('live') });
  const alreadyTrashed = makePhoto({
    id: testPhotoId('gone'),
    trashedAt: '2026-08-20T00:00:00.000Z',
  });
  const catalog = makeCatalog([live, alreadyTrashed]);

  it('marks photos trashed without moving any object', () => {
    const result = apply(trashPhotos(catalog, [live.id], NOW, AUDIT));

    expect(result.value.affected).toEqual([live.id]);
    const updated = result.catalog!.photos[live.id]!;
    expect(updated.trashedAt).toBe(NOW);
    // Derivative descriptors are untouched: the objects stay exactly where
    // they were, because trash is a catalog flag (decisions.md #9).
    expect(updated.derivatives).toEqual(live.derivatives);
  });

  it('skips unknown and already-trashed IDs, and aborts if nothing changes', () => {
    const result = apply(
      trashPhotos(catalog, [alreadyTrashed.id, testPhotoId('nope')], NOW, AUDIT),
    );

    expect(result.value.affected).toEqual([]);
    expect(result.catalog).toBeNull();
  });

  it('restores a trashed photo', () => {
    const result = apply(restorePhotos(catalog, [alreadyTrashed.id], NOW, AUDIT));

    expect(result.value.affected).toEqual([alreadyTrashed.id]);
    expect(result.catalog!.photos[alreadyTrashed.id]!.trashedAt).toBeNull();
  });

  it('does not restore a photo that is not trashed', () => {
    expect(apply(restorePhotos(catalog, [live.id], NOW, AUDIT)).value.affected).toEqual(
      [],
    );
  });

  it('permanently deletes only trashed photos', () => {
    const result = apply(
      permanentlyDeletePhotos(catalog, [live.id, alreadyTrashed.id]),
    );

    // There is deliberately no path from live to gone in one action.
    expect(result.value.affected).toEqual([alreadyTrashed.id]);
    expect(result.catalog!.photos[alreadyTrashed.id]).toBeUndefined();
    expect(result.catalog!.photos[live.id]).toBeDefined();
  });

  it('names all four objects for a deleted photo', () => {
    expect(objectKeysFor('abc')).toEqual([
      'photos/abc/full.jpg',
      'photos/abc/thumb.webp',
      'photos/abc/display-1280.webp',
      'photos/abc/display-2560.webp',
    ]);
  });
});

describe('resolveSelection', () => {
  const catalog = fixtureCatalog();

  it('resolves a day to its live photo IDs', () => {
    expect(
      resolveSelection(catalog, { kind: 'day', year: 2026, month: 8, day: 2 }),
    ).toHaveLength(6);

    // July 4th holds the trashed photo, which a day selection never covers.
    const july = resolveSelection(catalog, {
      kind: 'day',
      year: 2026,
      month: 7,
      day: 4,
    });
    expect(july).toHaveLength(3);
    expect(july).not.toContain(FIXTURE_PHOTO_IDS['deleted-0']);
  });

  it('resolves a month and a year', () => {
    expect(
      resolveSelection(catalog, { kind: 'month', year: 2026, month: 8 }),
    ).toHaveLength(7);
    expect(
      resolveSelection(catalog, { kind: 'month', year: 2026, month: 7 }),
    ).toHaveLength(6);
    expect(resolveSelection(catalog, { kind: 'year', year: 2026 })).toHaveLength(14);
  });

  it('resolves the undated group', () => {
    expect(resolveSelection(catalog, { kind: 'undated' })).toHaveLength(2);
  });

  it('resolves an explicit list, dropping unknown and trashed IDs', () => {
    const ids = resolveSelection(catalog, {
      kind: 'ids',
      photoIds: [
        FIXTURE_PHOTO_IDS['market']!,
        FIXTURE_PHOTO_IDS['deleted-0']!,
        testPhotoId('nope'),
      ],
    });

    expect(ids).toEqual([FIXTURE_PHOTO_IDS['market']]);
  });

  it('returns an empty list for a group that does not exist', () => {
    expect(resolveSelection(catalog, { kind: 'year', year: 1999 })).toEqual([]);
    expect(
      resolveSelection(catalog, { kind: 'day', year: 2026, month: 8, day: 9 }),
    ).toEqual([]);
  });

  /**
   * decisions.md #12: the confirm step acts on the resolved list, never on a
   * re-run of the query, so a photo committed in between cannot be swept in.
   */
  it('resolves to a list that a later commit cannot join', () => {
    const previewed = resolveSelection(catalog, {
      kind: 'day',
      year: 2026,
      month: 8,
      day: 15,
    });
    expect(previewed).toHaveLength(1);

    const latecomer = makePhoto({
      id: testPhotoId('latecomer'),
      captureDate: '2026-08-15',
      captureTime: '11:00:00',
    });
    const widened = {
      ...catalog,
      photos: { ...catalog.photos, [latecomer.id]: latecomer },
    };

    // Re-running the query would now return two; the token covers only one.
    expect(
      resolveSelection(widened, { kind: 'day', year: 2026, month: 8, day: 15 }),
    ).toHaveLength(2);

    const result = apply(trashPhotos(widened, previewed, NOW, AUDIT));
    expect(result.value.affected).toEqual(previewed);
    expect(isTrashed(result.catalog!.photos[latecomer.id]!)).toBe(false);
  });
});

describe('resolveTrashedSelection', () => {
  it('keeps only IDs that are actually in the trash', () => {
    const catalog = fixtureCatalog();
    const ids = resolveTrashedSelection(catalog, [
      FIXTURE_PHOTO_IDS['deleted-0']!,
      FIXTURE_PHOTO_IDS['market']!,
      testPhotoId('nope'),
    ]);

    expect(ids).toEqual([FIXTURE_PHOTO_IDS['deleted-0']]);
  });
});
