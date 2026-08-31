/**
 * The daily maintenance pass, as pure planning plus a small executor.
 *
 * The decisions — which photos have outlived the trash window, which object
 * prefixes have no catalog record, which snapshots to thin — are pure
 * functions so they can be tested without a bucket. Only `runMaintenance`
 * touches storage.
 */

import {
  ORPHAN_GRACE_HOURS,
  R2_KEYS,
  TRASH_RETENTION_DAYS,
} from '../../src/shared/constants.ts';
import { trashedAgeMs, trashedPhotos } from '../../src/shared/catalog.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import {
  mutateCatalog,
  loadCatalog,
  snapshotsToPrune,
} from '../../src/shared/catalog-repository.ts';
import {
  permanentlyDeletePhotos,
  objectKeysFor,
} from '../../src/shared/admin-operations.ts';
import { makeAuditEvent, writeAuditEvent } from '../../src/shared/audit.ts';
import { generateAuditId } from '../../src/shared/ids.ts';
import type { ObjectStore, ObjectSummary } from '../../src/shared/store.ts';

const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ORPHAN_GRACE_MS = ORPHAN_GRACE_HOURS * 60 * 60 * 1000;

/** Photo IDs whose trash retention has elapsed. */
export function expiredTrashIds(catalog: Catalog, nowMs: number): string[] {
  return trashedPhotos(catalog)
    .filter((photo) => {
      const age = trashedAgeMs(photo, nowMs);
      return age !== null && age >= TRASH_RETENTION_MS;
    })
    .map((photo) => photo.id);
}

/** The photo ID a `photos/<id>/<file>` key belongs to, or null. */
export function photoIdFromKey(key: string): string | null {
  if (!key.startsWith(R2_KEYS.photoPrefix)) return null;
  const rest = key.slice(R2_KEYS.photoPrefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * Object keys belonging to no catalog record and older than the grace period.
 *
 * The grace period is what makes this safe to run alongside uploads: a photo
 * whose artifacts are uploaded but not yet committed has no catalog record
 * for a few seconds, and sweeping it immediately would delete the images out
 * from under a commit that was about to succeed.
 *
 * A prefix is swept only when *every* one of its objects is past the grace
 * period, so a partly-uploaded photo is never half-deleted.
 */
export function orphanedKeys(
  catalog: Catalog,
  objects: readonly ObjectSummary[],
  nowMs: number,
): string[] {
  const byPhoto = new Map<string, ObjectSummary[]>();

  for (const object of objects) {
    const photoId = photoIdFromKey(object.key);
    if (photoId === null) continue;
    if (catalog.photos[photoId]) continue;
    const bucket = byPhoto.get(photoId);
    if (bucket) bucket.push(object);
    else byPhoto.set(photoId, [object]);
  }

  const doomed: string[] = [];
  for (const group of byPhoto.values()) {
    const newest = Math.max(...group.map((o) => o.uploadedAt.getTime()));
    if (nowMs - newest < ORPHAN_GRACE_MS) continue;
    for (const object of group) doomed.push(object.key);
  }

  return doomed.sort();
}

export interface MaintenanceReport {
  purgedPhotoIds: string[];
  orphanKeysDeleted: number;
  snapshotsPruned: number;
}

export async function runMaintenance(
  store: ObjectStore,
  now: () => Date,
): Promise<MaintenanceReport> {
  const nowMs = now().getTime();
  const at = new Date(nowMs).toISOString();
  const report: MaintenanceReport = {
    purgedPhotoIds: [],
    orphanKeysDeleted: 0,
    snapshotsPruned: 0,
  };

  // 1. Purge photos whose 30-day trash retention has elapsed.
  const { catalog } = await loadCatalog(store, () => at);
  const expired = expiredTrashIds(catalog, nowMs);

  if (expired.length > 0) {
    const auditId = generateAuditId();
    const outcome = await mutateCatalog(store, { now: () => at }, (current) =>
      permanentlyDeletePhotos(current, expired),
    );

    // Objects go after the catalog write, as in the manual delete path: the
    // other order would, on a lost race, leave records pointing at images
    // that no longer exist.
    if (outcome.affected.length > 0) {
      await store.delete(outcome.affected.flatMap(objectKeysFor));
      // The audit event outlives the photos it describes.
      await writeAuditEvent(
        store,
        makeAuditEvent('trash-purge', outcome.affected, {
          at,
          id: auditId,
          via: 'scheduled-maintenance',
          note: `Retention of ${TRASH_RETENTION_DAYS} days elapsed`,
        }),
      );
    }
    report.purgedPhotoIds = outcome.affected;
  }

  // 2. Sweep objects with no catalog record. Re-read the catalog so a photo
  //    committed during step 1 is not mistaken for an orphan.
  const { catalog: afterPurge } = await loadCatalog(store, () => at);
  const photoObjects = await store.list(R2_KEYS.photoPrefix);
  const orphans = orphanedKeys(afterPurge, photoObjects, nowMs);

  if (orphans.length > 0) {
    await store.delete(orphans);
    await writeAuditEvent(
      store,
      makeAuditEvent('orphan-sweep', [], {
        at,
        via: 'scheduled-maintenance',
        note: `Deleted ${orphans.length} object(s) with no catalog record`,
      }),
    );
    report.orphanKeysDeleted = orphans.length;
  }

  // 3. Thin old snapshots.
  const snapshots = await store.list(R2_KEYS.snapshotPrefix);
  const doomed = snapshotsToPrune(snapshots, nowMs);
  if (doomed.length > 0) {
    await store.delete(doomed);
    report.snapshotsPruned = doomed.length;
  }

  return report;
}
