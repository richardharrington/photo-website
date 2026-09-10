import { describe, it, expect } from 'vitest';
import {
  expiredSubmissions,
  expiredTrashIds,
  orphanedKeys,
  photoIdFromKey,
  runMaintenance,
} from '../../worker/src/maintenance.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { makeCatalog, makePhoto, testPhotoId } from '../../fixtures/photos.ts';
import {
  R2_KEYS,
  photoObjectKey,
  submissionPartKey,
  submissionRecordKey,
} from '../../src/shared/constants.ts';
import { storeSubmission } from '../../src/shared/inbox-repository.ts';
import type { Submission } from '../../src/shared/submissions.ts';
import { encodeJson } from '../../src/shared/store.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import { objectKeysFor } from '../../src/shared/admin-operations.ts';
import type { ObjectSummary } from '../../src/shared/store.ts';

const NOW = new Date('2026-09-30T03:00:00.000Z');
const NOW_MS = NOW.getTime();
const daysAgo = (days: number) => new Date(NOW_MS - days * 86_400_000).toISOString();

describe('expiredTrashIds', () => {
  it('selects photos past the 30-day retention window', () => {
    const old = makePhoto({ id: testPhotoId('old'), trashedAt: daysAgo(31) });
    const recent = makePhoto({ id: testPhotoId('recent'), trashedAt: daysAgo(3) });
    const live = makePhoto({ id: testPhotoId('live') });

    expect(expiredTrashIds(makeCatalog([old, recent, live]), NOW_MS)).toEqual([old.id]);
  });

  it('purges exactly at the boundary, not a day late', () => {
    const boundary = makePhoto({ id: testPhotoId('b'), trashedAt: daysAgo(30) });
    expect(expiredTrashIds(makeCatalog([boundary]), NOW_MS)).toEqual([boundary.id]);
  });

  it('keeps a photo one day short of the window', () => {
    const almost = makePhoto({ id: testPhotoId('a'), trashedAt: daysAgo(29) });
    expect(expiredTrashIds(makeCatalog([almost]), NOW_MS)).toEqual([]);
  });
});

describe('photoIdFromKey', () => {
  it('extracts the photo ID from an object key', () => {
    expect(photoIdFromKey('photos/abc123/thumb.webp')).toBe('abc123');
  });

  it('returns null for anything outside the photo prefix', () => {
    for (const key of [
      'catalog/current.json',
      'catalog/snapshots/x.json',
      'photos/',
      'photos/loose-file',
      'other/abc/thumb.webp',
    ]) {
      expect(photoIdFromKey(key), key).toBeNull();
    }
  });
});

describe('orphanedKeys', () => {
  const hoursAgo = (hours: number) => new Date(NOW_MS - hours * 3_600_000);

  function objects(photoId: string, uploaded: Date): ObjectSummary[] {
    return objectKeysFor(photoId).map((key) => ({
      key,
      size: 10,
      uploadedAt: uploaded,
    }));
  }

  it('sweeps objects with no catalog record once the grace period passes', () => {
    const orphan = testPhotoId('orphan');
    const doomed = orphanedKeys(makeCatalog([]), objects(orphan, hoursAgo(25)), NOW_MS);

    expect(doomed).toEqual(objectKeysFor(orphan).sort());
  });

  it('leaves a recent upload alone', () => {
    // The grace period is what makes this safe to run alongside uploads: a
    // photo whose artifacts have landed but whose commit has not yet happened
    // has no catalog record for a few seconds.
    const inFlight = testPhotoId('in-flight');
    expect(
      orphanedKeys(makeCatalog([]), objects(inFlight, hoursAgo(1)), NOW_MS),
    ).toEqual([]);
  });

  it('never touches an object belonging to a catalog record', () => {
    const photo = makePhoto({ id: testPhotoId('kept') });
    const catalog = makeCatalog([photo]);

    expect(orphanedKeys(catalog, objects(photo.id, hoursAgo(500)), NOW_MS)).toEqual([]);
  });

  it('keeps a trashed photo, whose objects deliberately stay in place', () => {
    // Trash is a catalog flag; the nightly mirror is supposed to include the
    // full 30-day trash.
    const trashed = makePhoto({ id: testPhotoId('trashed'), trashedAt: daysAgo(5) });

    expect(
      orphanedKeys(makeCatalog([trashed]), objects(trashed.id, hoursAgo(500)), NOW_MS),
    ).toEqual([]);
  });

  it('does not half-delete a photo still being uploaded', () => {
    // One object is old, another has just landed. Sweeping the old one would
    // leave a photo that can never commit successfully.
    const partial = testPhotoId('partial');
    const keys = objectKeysFor(partial);
    const mixed: ObjectSummary[] = [
      { key: keys[0]!, size: 10, uploadedAt: hoursAgo(30) },
      { key: keys[1]!, size: 10, uploadedAt: hoursAgo(30) },
      { key: keys[2]!, size: 10, uploadedAt: hoursAgo(30) },
      { key: keys[3]!, size: 10, uploadedAt: hoursAgo(1) },
    ];

    expect(orphanedKeys(makeCatalog([]), mixed, NOW_MS)).toEqual([]);
  });

  it('ignores catalog and snapshot objects entirely', () => {
    const unrelated: ObjectSummary[] = [
      { key: R2_KEYS.catalog, size: 10, uploadedAt: hoursAgo(500) },
      {
        key: `${R2_KEYS.snapshotPrefix}old.json`,
        size: 10,
        uploadedAt: hoursAgo(500),
      },
    ];

    expect(orphanedKeys(makeCatalog([]), unrelated, NOW_MS)).toEqual([]);
  });
});

describe('runMaintenance', () => {
  function setUp(catalog: Catalog, uploaded = new Date(NOW_MS - 86_400_000 * 2)) {
    const store = new InMemoryObjectStore();
    store.seed(R2_KEYS.catalog, encodeJson(catalog));
    for (const photo of Object.values(catalog.photos)) {
      for (const key of objectKeysFor(photo.id)) {
        store.seed(key, new TextEncoder().encode('x'), uploaded);
      }
    }
    return store;
  }

  it('purges expired trash: objects gone, record gone, audit kept', () => {
    return (async () => {
      const expired = makePhoto({ id: testPhotoId('expired'), trashedAt: daysAgo(45) });
      const store = setUp(makeCatalog([expired]));

      const report = await runMaintenance(store, () => NOW);

      expect(report.purgedPhotoIds).toEqual([expired.id]);
      expect(store.readJson<Catalog>(R2_KEYS.catalog)?.photos).toEqual({});
      for (const key of objectKeysFor(expired.id)) {
        expect(store.has(key), key).toBe(false);
      }
      // The audit record survives the photo it describes.
      const audits = store.keys().filter((k) => k.startsWith(R2_KEYS.auditPrefix));
      expect(audits).toHaveLength(1);
    })();
  });

  it('leaves trash inside the retention window completely alone', async () => {
    const recent = makePhoto({ id: testPhotoId('recent'), trashedAt: daysAgo(10) });
    const store = setUp(makeCatalog([recent]));

    const report = await runMaintenance(store, () => NOW);

    expect(report.purgedPhotoIds).toEqual([]);
    expect(store.has(photoObjectKey(recent.id, 'thumb'))).toBe(true);
  });

  it('sweeps orphaned objects', async () => {
    const store = setUp(makeCatalog([]));
    const orphan = testPhotoId('orphan');
    for (const key of objectKeysFor(orphan)) {
      store.seed(key, new TextEncoder().encode('x'), new Date(NOW_MS - 86_400_000 * 3));
    }

    const report = await runMaintenance(store, () => NOW);

    expect(report.orphanKeysDeleted).toBe(4);
    expect(store.has(photoObjectKey(orphan, 'thumb'))).toBe(false);
  });

  it('does not sweep the objects of a photo it just purged twice over', async () => {
    // The purge deletes the objects; the sweep must then find nothing rather
    // than reporting the same keys again.
    const expired = makePhoto({ id: testPhotoId('expired'), trashedAt: daysAgo(45) });
    const store = setUp(makeCatalog([expired]));

    const report = await runMaintenance(store, () => NOW);

    expect(report.purgedPhotoIds).toEqual([expired.id]);
    expect(report.orphanKeysDeleted).toBe(0);
  });

  it('thins old snapshots to one per day and keeps recent ones', async () => {
    const store = setUp(makeCatalog([]));
    const body = encodeJson({ schemaVersion: 1 });

    // Three snapshots on one old day, one on another, one recent.
    store.seed(
      `${R2_KEYS.snapshotPrefix}a.json`,
      body,
      new Date(NOW_MS - 60 * 86_400_000),
    );
    store.seed(
      `${R2_KEYS.snapshotPrefix}b.json`,
      body,
      new Date(NOW_MS - 60 * 86_400_000 + 3_600_000),
    );
    store.seed(
      `${R2_KEYS.snapshotPrefix}c.json`,
      body,
      new Date(NOW_MS - 60 * 86_400_000 + 7_200_000),
    );
    store.seed(
      `${R2_KEYS.snapshotPrefix}d.json`,
      body,
      new Date(NOW_MS - 61 * 86_400_000),
    );
    store.seed(
      `${R2_KEYS.snapshotPrefix}recent.json`,
      body,
      new Date(NOW_MS - 86_400_000),
    );

    const report = await runMaintenance(store, () => NOW);

    // Two of the three same-day snapshots go; the other day and the recent
    // one are kept. runMaintenance also writes a snapshot of its own purge,
    // which is inside the retention window.
    expect(report.snapshotsPruned).toBe(2);
    expect(store.has(`${R2_KEYS.snapshotPrefix}c.json`)).toBe(true);
    expect(store.has(`${R2_KEYS.snapshotPrefix}d.json`)).toBe(true);
    expect(store.has(`${R2_KEYS.snapshotPrefix}recent.json`)).toBe(true);
  });

  it('is a no-op on an empty bucket', async () => {
    const store = setUp(makeCatalog([]));

    const report = await runMaintenance(store, () => NOW);

    expect(report).toEqual({
      purgedPhotoIds: [],
      purgedSubmissionIds: [],
      orphanKeysDeleted: 0,
      snapshotsPruned: 0,
    });
  });

  it('is safe to run twice', async () => {
    const expired = makePhoto({ id: testPhotoId('expired'), trashedAt: daysAgo(45) });
    const store = setUp(makeCatalog([expired]));

    await runMaintenance(store, () => NOW);
    const second = await runMaintenance(store, () => NOW);

    expect(second.purgedPhotoIds).toEqual([]);
    expect(second.orphanKeysDeleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The inbox retention purge
// ---------------------------------------------------------------------------

function submissionRecord(id: string, receivedAt: string): Submission {
  return {
    schemaVersion: 1,
    id,
    receivedAt,
    submittedBy: 'cf-1',
    subject: 'Beach day',
    proposedCaption: 'Beach day',
    bodyLine: null,
    parts: [
      { index: 0, filename: 'a.jpg', contentType: 'image/jpeg', bytes: 10 },
      { index: 1, filename: 'b.jpg', contentType: 'image/jpeg', bytes: 10 },
    ],
    claim: null,
  };
}

async function seedSubmission(
  store: InMemoryObjectStore,
  record: Submission,
): Promise<void> {
  await storeSubmission(
    store,
    record,
    record.parts.map((part) => ({
      index: part.index,
      bytes: new Uint8Array(part.bytes),
      contentType: part.contentType,
    })),
  );
}

describe('expiredSubmissions', () => {
  it('selects messages past the 30-day window and no others', () => {
    const old = submissionRecord(testPhotoId('old-sub'), daysAgo(31));
    const boundary = submissionRecord(testPhotoId('boundary-sub'), daysAgo(30));
    const recent = submissionRecord(testPhotoId('recent-sub'), daysAgo(29));

    expect(
      expiredSubmissions([old, boundary, recent], NOW_MS).map((each) => each.id),
    ).toEqual([old.id, boundary.id]);
  });

  it('gives a claimed submission no reprieve', () => {
    // A tab that claimed something a month ago is a tab that is long gone.
    const claimed = {
      ...submissionRecord(testPhotoId('claimed'), daysAgo(31)),
      claim: { token: 'tab', at: daysAgo(31) },
    };
    expect(expiredSubmissions([claimed], NOW_MS)).toHaveLength(1);
  });
});

describe('runMaintenance and the inbox', () => {
  it('deletes an expired submission, parts and record, and audits it', async () => {
    const store = new InMemoryObjectStore({ now: () => NOW });
    store.seed(R2_KEYS.catalog, encodeJson(makeCatalog([])));
    const old = submissionRecord(testPhotoId('old-sub'), daysAgo(31));
    await seedSubmission(store, old);

    const report = await runMaintenance(store, () => NOW);

    expect(report.purgedSubmissionIds).toEqual([old.id]);
    expect(store.keys().filter((key) => key.startsWith(R2_KEYS.inboxPrefix))).toEqual(
      [],
    );

    const audits = store
      .keys()
      .filter((key) => key.startsWith(R2_KEYS.auditPrefix))
      .map((key) => store.readJson<{ action: string; note?: string }>(key)!);
    const purge = audits.find((event) => event.action === 'submission-purged');
    expect(purge?.note).toContain(old.id);
    expect(purge?.note).toContain('2 parts');
    // Never the address and never the subject: the audit log is forever.
    expect(purge?.note).not.toContain('cf-1');
    expect(purge?.note).not.toContain('Beach day');
  });

  it('leaves a submission inside the window exactly where it is', async () => {
    const store = new InMemoryObjectStore({ now: () => NOW });
    store.seed(R2_KEYS.catalog, encodeJson(makeCatalog([])));
    const recent = submissionRecord(testPhotoId('recent-sub'), daysAgo(3));
    await seedSubmission(store, recent);

    const report = await runMaintenance(store, () => NOW);

    expect(report.purgedSubmissionIds).toEqual([]);
    expect(store.has(submissionRecordKey(recent.id))).toBe(true);
  });

  /**
   * The one rule the inbox depends on. Every object under `inbox/` has no
   * catalog record by definition, so an orphan sweep extended to that prefix
   * would delete every waiting submission on its first run — including one
   * that arrived a minute ago.
   */
  it('leaves inbox/ alone when sweeping objects with no catalog record', async () => {
    const store = new InMemoryObjectStore({
      // Old enough that the orphan grace period has long elapsed.
      now: () => new Date(NOW_MS - 48 * 3_600_000),
    });
    store.seed(R2_KEYS.catalog, encodeJson(makeCatalog([])));
    const recent = submissionRecord(testPhotoId('untouched'), daysAgo(1));
    await seedSubmission(store, recent);

    const report = await runMaintenance(store, () => NOW);

    expect(report.orphanKeysDeleted).toBe(0);
    expect(store.has(submissionRecordKey(recent.id))).toBe(true);
    expect(store.has(submissionPartKey(recent.id, 0))).toBe(true);
    // No delete named an inbox key at all. The prefix is listed — the
    // retention purge reads it — but nothing under it is ever swept.
    const deletes = store.calls.filter((call) => call.startsWith('delete '));
    expect(deletes.some((call) => call.includes(R2_KEYS.inboxPrefix))).toBe(false);
  });
});
