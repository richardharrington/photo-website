/**
 * Reading and mutating the catalog.
 *
 * Every mutation is an ETag-guarded conditional write. On conflict the writer
 * reloads and re-runs the mutation against whatever is now stored, rather than
 * overwriting it.
 *
 * **This retry loop is correct only because R2 is strongly consistent** for
 * read-after-write: the reload after a losing write is guaranteed to see the
 * write that beat it, so the retry converges. Moving the catalog to
 * eventually-consistent storage would break atomicity silently — a retry could
 * read stale data, re-apply against it, and win, discarding the other change
 * with no error anywhere. That dependency is recorded here deliberately.
 */

import { CATALOG_SCHEMA_VERSION, emptyCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { R2_KEYS, SNAPSHOT_FULL_RETENTION_DAYS } from './constants.ts';
import { decodeJson, encodeJson } from './store.ts';
import type { ObjectStore, WriteCondition } from './store.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface LoadedCatalog {
  catalog: Catalog;
  /** null when no catalog object exists yet. */
  etag: string | null;
}

export class CatalogConflictError extends Error {
  constructor(attempts: number) {
    super(`Catalog write conflicted ${attempts} times; giving up.`);
    this.name = 'CatalogConflictError';
  }
}

export class CatalogSchemaError extends Error {
  constructor(found: unknown) {
    super(
      `Catalog schema version ${String(found)} is not supported by this build ` +
        `(expected ${CATALOG_SCHEMA_VERSION}). Refusing to read or write it.`,
    );
    this.name = 'CatalogSchemaError';
  }
}

/**
 * Load the catalog, or an empty one when the bucket is new.
 *
 * A newer-than-expected schema version is a hard failure rather than a
 * best-effort read: silently writing back a record shaped for an older schema
 * is how a rollback quietly destroys data.
 */
export async function loadCatalog(
  store: ObjectStore,
  now: () => string,
): Promise<LoadedCatalog> {
  const stored = await store.get(R2_KEYS.catalog);
  if (!stored) return { catalog: emptyCatalog(now()), etag: null };

  const catalog = decodeJson<Catalog>(stored.body);
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new CatalogSchemaError(catalog.schemaVersion);
  }

  return { catalog, etag: stored.etag };
}

/**
 * What a mutation decided to do.
 *
 * `abort` exists so a mutation can conclude that nothing needs to change —
 * an upload whose hash is already present, a restore of a photo that is not
 * trashed — and return its answer without spending a write or opening a race.
 */
export type Mutation<T> =
  { kind: 'write'; catalog: Catalog; value: T } | { kind: 'abort'; value: T };

export function writeMutation<T>(catalog: Catalog, value: T): Mutation<T> {
  return { kind: 'write', catalog, value };
}

export function abortMutation<T>(value: T): Mutation<T> {
  return { kind: 'abort', value };
}

export interface MutateOptions {
  /** Attempts before giving up. Conflicts are expected but not endless. */
  maxAttempts?: number;
  /** Write a snapshot alongside the new catalog. On by default. */
  snapshot?: boolean;
}

export interface MutateContext {
  now: () => string;
}

/**
 * Apply a mutation to the catalog under a conditional write, retrying on
 * conflict.
 *
 * `mutate` must be a pure function of the catalog it is handed: it is re-run
 * from scratch on every retry, so any side effect inside it would happen more
 * than once. Anything with an external effect belongs outside this call.
 */
export async function mutateCatalog<T>(
  store: ObjectStore,
  context: MutateContext,
  mutate: (catalog: Catalog) => Mutation<T>,
  options: MutateOptions = {},
): Promise<T> {
  const { maxAttempts = 5, snapshot = true } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { catalog, etag } = await loadCatalog(store, context.now);
    const outcome = mutate(catalog);

    if (outcome.kind === 'abort') return outcome.value;

    const next: Catalog = { ...outcome.catalog, updatedAt: context.now() };
    const condition: WriteCondition =
      etag === null ? { ifAbsent: true } : { ifMatch: etag };

    const body = encodeJson(next);
    const result = await store.putConditional(
      R2_KEYS.catalog,
      body,
      condition,
      JSON_CONTENT_TYPE,
    );

    if (result.ok) {
      if (snapshot) {
        // After the catalog write, never before: a snapshot of a state that
        // lost its race would be a snapshot of something that never existed.
        // A failed snapshot must not fail the mutation it describes.
        await writeSnapshot(store, body, next.updatedAt).catch((error: unknown) => {
          console.error('Catalog snapshot failed', error);
        });
      }
      return outcome.value;
    }
    // Conflict: loop, reload, and re-run the mutation against the new state.
  }

  throw new CatalogConflictError(maxAttempts);
}

/** Snapshot keys sort chronologically, which the pruning cron relies on. */
export function snapshotKey(timestamp: string): string {
  return `${R2_KEYS.snapshotPrefix}${timestamp.replace(/[:.]/g, '-')}.json`;
}

async function writeSnapshot(
  store: ObjectStore,
  body: Uint8Array,
  timestamp: string,
): Promise<void> {
  await store.put(snapshotKey(timestamp), body, JSON_CONTENT_TYPE);
}

/**
 * Decide which snapshots to delete: keep everything inside the full-retention
 * window, then thin older ones to the newest per calendar day.
 *
 * Pure, and separate from the cron that performs the deletes, so the retention
 * rule can be tested without a store.
 */
export function snapshotsToPrune(
  snapshots: readonly { key: string; uploadedAt: Date }[],
  nowMs: number,
): string[] {
  const cutoff = nowMs - SNAPSHOT_FULL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Newest first, so the first entry seen for a day is the one that is kept.
  const older = snapshots
    .filter((snapshot) => snapshot.uploadedAt.getTime() < cutoff)
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());

  const keptDays = new Set<string>();
  const doomed: string[] = [];

  for (const snapshot of older) {
    const day = snapshot.uploadedAt.toISOString().slice(0, 10);
    if (keptDays.has(day)) doomed.push(snapshot.key);
    else keptDays.add(day);
  }

  return doomed;
}
