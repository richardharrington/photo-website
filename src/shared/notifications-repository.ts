/**
 * Reading and mutating `catalog/notifications.json`.
 *
 * The same shape as `catalog-repository.ts` and for the same reasons: every
 * mutation is an ETag-guarded conditional write through the store seam, and a
 * writer that loses the race reloads and re-runs its mutation against whatever
 * is now stored. `ifAbsent` creates the first one; `ifMatch` guards every
 * update after that.
 *
 * It is a second object rather than a field on the catalog on purpose. Every
 * viewer request loads the catalog through the Worker, and the catalog should
 * not carry a list of family email addresses to serve a thumbnail.
 */

import { R2_KEYS } from './constants.ts';
import {
  NOTIFICATION_SCHEMA_VERSION,
  emptyNotificationState,
} from './notifications.ts';
import type { NotificationState } from './notifications.ts';
import { decodeJson, encodeJson } from './store.ts';
import type { ObjectStore, WriteCondition } from './store.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface LoadedNotificationState {
  state: NotificationState;
  /** null when no state object exists yet. */
  etag: string | null;
}

export class NotificationConflictError extends Error {
  constructor(attempts: number) {
    super(`Notification state write conflicted ${attempts} times; giving up.`);
    this.name = 'NotificationConflictError';
  }
}

export class NotificationSchemaError extends Error {
  constructor(found: unknown) {
    super(
      `Notification state schema version ${String(found)} is not supported by ` +
        `this build (expected ${NOTIFICATION_SCHEMA_VERSION}). Refusing to ` +
        'read or write it.',
    );
    this.name = 'NotificationSchemaError';
  }
}

/**
 * Load the state, or an empty one when nothing has been written yet.
 *
 * A newer-than-expected schema version is a hard failure, as it is for the
 * catalog: writing back a record shaped for an older schema is how a rollback
 * quietly destroys data.
 */
export async function loadNotificationState(
  store: ObjectStore,
): Promise<LoadedNotificationState> {
  const stored = await store.get(R2_KEYS.notifications);
  if (!stored) return { state: emptyNotificationState(), etag: null };

  const state = decodeJson<NotificationState>(stored.body);
  if (state.schemaVersion !== NOTIFICATION_SCHEMA_VERSION) {
    throw new NotificationSchemaError(state.schemaVersion);
  }

  return { state, etag: stored.etag };
}

export interface MutateNotificationOptions {
  /** Attempts before giving up. Conflicts are expected but not endless. */
  maxAttempts?: number;
}

/**
 * Apply a mutation under a conditional write, retrying on conflict.
 *
 * `mutate` must be a pure function of the state it is handed: it is re-run
 * from scratch on every retry, so a side effect inside it would happen more
 * than once. Sending an email is exactly such a side effect, which is why the
 * digest executor sends first and records afterwards.
 *
 * Returning the same object the mutation was given means "nothing to do", and
 * spends no write.
 */
export async function mutateNotificationState<T>(
  store: ObjectStore,
  mutate: (state: NotificationState) => { state: NotificationState; value: T },
  options: MutateNotificationOptions = {},
): Promise<T> {
  const { maxAttempts = 5 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { state, etag } = await loadNotificationState(store);
    const outcome = mutate(state);

    if (outcome.state === state) return outcome.value;

    const condition: WriteCondition =
      etag === null ? { ifAbsent: true } : { ifMatch: etag };

    const result = await store.putConditional(
      R2_KEYS.notifications,
      encodeJson(outcome.state),
      condition,
      JSON_CONTENT_TYPE,
    );

    if (result.ok) return outcome.value;
    // Conflict: loop, reload, and re-run the mutation against the new state.
  }

  throw new NotificationConflictError(maxAttempts);
}
