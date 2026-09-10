import { describe, it, expect } from 'vitest';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { R2_KEYS } from '../../src/shared/constants.ts';
import { decodeJson, encodeJson } from '../../src/shared/store.ts';
import {
  NotificationConflictError,
  NotificationSchemaError,
  loadNotificationState,
  mutateNotificationState,
} from '../../src/shared/notifications-repository.ts';
import {
  NOTIFICATION_SCHEMA_VERSION,
  emptyNotificationState,
  newRecipient,
  pruneNotificationState,
} from '../../src/shared/notifications.ts';
import type {
  DestinationAddress,
  NotificationState,
} from '../../src/shared/notifications.ts';

const NOW = '2026-09-05T04:17:00.000Z';

function withRecipient(email: string, seenThrough = NOW): NotificationState {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    recipients: { [email]: newRecipient(seenThrough) },
  };
}

function stored(store: InMemoryObjectStore): NotificationState | null {
  return store.readJson<NotificationState>(R2_KEYS.notifications);
}

function enable(state: NotificationState, email: string) {
  return {
    state: {
      ...state,
      recipients: {
        ...state.recipients,
        [email]: newRecipient(NOW),
      },
    },
    value: email,
  };
}

describe('loadNotificationState', () => {
  it('returns an empty state when nothing has been written yet', async () => {
    const { state, etag } = await loadNotificationState(new InMemoryObjectStore());
    expect(state).toEqual(emptyNotificationState());
    // A null etag is what makes the first write an ifAbsent create.
    expect(etag).toBeNull();
  });

  it('refuses a newer schema rather than writing an older shape back over it', async () => {
    const store = new InMemoryObjectStore();
    store.seed(
      R2_KEYS.notifications,
      encodeJson({ schemaVersion: 99, recipients: {} }),
    );

    await expect(loadNotificationState(store)).rejects.toBeInstanceOf(
      NotificationSchemaError,
    );
  });

  /**
   * Version 1 predates `canSubmit` and `reviewsInbox`. Reading it must give
   * every recipient both switched off — not undefined, which would read as
   * neither on nor off and would reach the page as an uncontrolled checkbox.
   */
  it('upgrades a version-1 object in memory, with both new bits off', async () => {
    const store = new InMemoryObjectStore();
    store.seed(
      R2_KEYS.notifications,
      encodeJson({
        schemaVersion: 1,
        recipients: {
          'a@example.com': { enabled: true, seenThrough: NOW, lastSent: null },
        },
      }),
    );

    const { state } = await loadNotificationState(store);

    expect(state.schemaVersion).toBe(NOTIFICATION_SCHEMA_VERSION);
    expect(state.recipients['a@example.com']).toEqual({
      enabled: true,
      canSubmit: false,
      reviewsInbox: false,
      seenThrough: NOW,
      lastSent: null,
    });
  });

  it('does not write the upgrade back just to read it', async () => {
    const store = new InMemoryObjectStore();
    store.seed(R2_KEYS.notifications, encodeJson({ schemaVersion: 1, recipients: {} }));

    await loadNotificationState(store);

    expect(store.calls.filter((call) => call.startsWith('putConditional'))).toEqual([]);
  });

  it('writes the upgraded shape back on the next mutation', async () => {
    const store = new InMemoryObjectStore();
    store.seed(
      R2_KEYS.notifications,
      encodeJson({
        schemaVersion: 1,
        recipients: {
          'a@example.com': { enabled: true, seenThrough: NOW, lastSent: null },
        },
      }),
    );

    await mutateNotificationState(store, (state) => enable(state, 'b@example.com'));

    const after = stored(store)!;
    expect(after.schemaVersion).toBe(NOTIFICATION_SCHEMA_VERSION);
    expect(after.recipients['a@example.com']?.canSubmit).toBe(false);
    expect(after.recipients['a@example.com']?.reviewsInbox).toBe(false);
  });
});

describe('mutateNotificationState', () => {
  it('creates the first state with ifAbsent', async () => {
    const store = new InMemoryObjectStore();

    await mutateNotificationState(store, (state) => enable(state, 'a@example.com'));

    expect(stored(store)?.recipients['a@example.com']?.enabled).toBe(true);
    // No get-then-update: the object did not exist, so nothing was matched.
    expect(store.calls).toContain(`putConditional ${R2_KEYS.notifications}`);
  });

  it('guards an update with ifMatch', async () => {
    const store = new InMemoryObjectStore();
    store.seed(R2_KEYS.notifications, encodeJson(withRecipient('a@example.com')));
    const before = store.etagOf(R2_KEYS.notifications);

    await mutateNotificationState(store, (state) => enable(state, 'b@example.com'));

    expect(Object.keys(stored(store)?.recipients ?? {}).sort()).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    // A successful write produces a new etag, so a stale one is detectable.
    expect(store.etagOf(R2_KEYS.notifications)).not.toBe(before);
  });

  it('spends no write when the mutation returns the state it was handed', async () => {
    const store = new InMemoryObjectStore();
    store.seed(R2_KEYS.notifications, encodeJson(withRecipient('a@example.com')));

    const value = await mutateNotificationState(store, (state) => ({
      state,
      value: 'nothing to do',
    }));

    expect(value).toBe('nothing to do');
    expect(store.calls.filter((call) => call.startsWith('putConditional'))).toEqual([]);
  });

  /**
   * The conflict the retry loop exists for, in both shapes the two adapters
   * report it as. `InMemoryObjectStore` normalizes each to `{ ok: false }`, and
   * these assert the loop reloads and re-runs against what is now stored rather
   * than overwriting it.
   */
  describe('on conflict', () => {
    it('reloads and re-runs against the winner, from an ifAbsent create', async () => {
      const store = new InMemoryObjectStore();
      let raced = false;

      store.onBeforeConditionalWrite = () => {
        if (raced) return;
        raced = true;
        // Another writer creates the object first, so this ifAbsent fails.
        store.seed(
          R2_KEYS.notifications,
          encodeJson(withRecipient('first@example.com')),
        );
      };

      await mutateNotificationState(store, (state) =>
        enable(state, 'second@example.com'),
      );

      // The loser's change landed *on top of* the winner's, not instead of it.
      expect(Object.keys(stored(store)?.recipients ?? {}).sort()).toEqual([
        'first@example.com',
        'second@example.com',
      ]);
    });

    it('reloads and re-runs against the winner, from an ifMatch update', async () => {
      const store = new InMemoryObjectStore();
      store.seed(R2_KEYS.notifications, encodeJson(withRecipient('base@example.com')));
      let raced = false;

      store.onBeforeConditionalWrite = () => {
        if (raced) return;
        raced = true;
        // A competing write between this writer's read and its write.
        store.seed(
          R2_KEYS.notifications,
          encodeJson({
            schemaVersion: 1,
            recipients: {
              'base@example.com': { enabled: true, seenThrough: NOW, lastSent: null },
              'other@example.com': { enabled: true, seenThrough: NOW, lastSent: null },
            },
          }),
        );
      };

      await mutateNotificationState(store, (state) =>
        enable(state, 'mine@example.com'),
      );

      expect(Object.keys(stored(store)?.recipients ?? {}).sort()).toEqual([
        'base@example.com',
        'mine@example.com',
        'other@example.com',
      ]);
    });

    it('gives up rather than retrying endlessly', async () => {
      const store = new InMemoryObjectStore();
      // A writer that always loses: something else writes before every attempt.
      store.onBeforeConditionalWrite = () => {
        store.seed(
          R2_KEYS.notifications,
          encodeJson(withRecipient('winner@example.com')),
        );
      };

      await expect(
        mutateNotificationState(store, (state) => enable(state, 'loser@example.com'), {
          maxAttempts: 3,
        }),
      ).rejects.toBeInstanceOf(NotificationConflictError);

      expect(
        store.calls.filter((call) => call.startsWith('putConditional')),
      ).toHaveLength(3);
    });
  });

  it('prunes entries with no Cloudflare address when a write goes through', async () => {
    const store = new InMemoryObjectStore();
    store.seed(
      R2_KEYS.notifications,
      encodeJson({
        schemaVersion: 1,
        recipients: {
          'kept@example.com': { enabled: true, seenThrough: NOW, lastSent: null },
          'deleted-at-cloudflare@example.com': {
            enabled: true,
            seenThrough: NOW,
            lastSent: null,
          },
        },
      }),
    );

    const addresses: DestinationAddress[] = [
      { id: 'a', email: 'kept@example.com', verified: true },
    ];

    await mutateNotificationState(store, (state) => ({
      state: pruneNotificationState(state, addresses),
      value: undefined,
    }));

    expect(Object.keys(stored(store)?.recipients ?? {})).toEqual(['kept@example.com']);
  });

  it('writes JSON the loader reads back unchanged', async () => {
    const store = new InMemoryObjectStore();
    await mutateNotificationState(store, (state) => enable(state, 'a@example.com'));

    const raw = await store.get(R2_KEYS.notifications);
    expect(decodeJson<NotificationState>(raw!.body).schemaVersion).toBe(
      NOTIFICATION_SCHEMA_VERSION,
    );
    expect((await loadNotificationState(store)).etag).toBe(raw!.etag);
  });
});
