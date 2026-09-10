import { describe, it, expect } from 'vitest';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import {
  INBOX_CLAIM_TTL_MINUTES,
  R2_KEYS,
  submissionPartKey,
  submissionRecordKey,
} from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import {
  claimSubmission,
  inboxUsage,
  listSubmissions,
  loadSubmission,
  removeSubmission,
  storeSubmission,
  submissionIdFromKey,
  submissionObjectKeys,
} from '../../src/shared/inbox-repository.ts';
import type { Submission } from '../../src/shared/submissions.ts';

const TTL_MS = INBOX_CLAIM_TTL_MINUTES * 60 * 1000;

function id(seed: string): string {
  return (seed.repeat(32) + '0'.repeat(32)).slice(0, 32);
}

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    schemaVersion: 1,
    id: id('a'),
    receivedAt: '2026-09-08T14:02:00.000Z',
    submittedBy: 'cf-1',
    subject: 'Beach day',
    proposedCaption: 'Beach day',
    bodyLine: null,
    parts: [
      {
        index: 0,
        filename: 'IMG_4021.HEIC',
        contentType: 'image/heic',
        bytes: 3_100_000,
      },
      {
        index: 1,
        filename: 'IMG_4022.HEIC',
        contentType: 'image/heic',
        bytes: 2_900_000,
      },
    ],
    claim: null,
    ...overrides,
  };
}

async function seed(
  store: InMemoryObjectStore,
  record: Submission,
): Promise<Submission> {
  await storeSubmission(
    store,
    record,
    record.parts.map((part) => ({
      index: part.index,
      bytes: new Uint8Array(part.bytes > 1024 ? 1024 : part.bytes),
      contentType: part.contentType,
    })),
  );
  return record;
}

describe('storeSubmission', () => {
  /**
   * Parts before the record: a record whose parts are missing is a card the
   * Inbox cannot render, and parts with no record are invisible bytes the
   * retention purge removes. Of the two, only one is recoverable.
   */
  it('writes every part before it writes the record', async () => {
    const store = new InMemoryObjectStore();
    const record = submission();

    await seed(store, record);

    const writes = store.calls.filter(
      (call) => call.startsWith('put ') || call.startsWith('putConditional '),
    );
    expect(writes).toEqual([
      `put ${submissionPartKey(record.id, 0)}`,
      `put ${submissionPartKey(record.id, 1)}`,
      `putConditional ${submissionRecordKey(record.id)}`,
    ]);
  });

  it('refuses to overwrite an existing record', async () => {
    const store = new InMemoryObjectStore();
    const record = submission();
    await seed(store, record);

    // The id is freshly generated, so a conflict here is a bug, not a race.
    await expect(seed(store, record)).rejects.toThrow(/already exists/);
  });
});

describe('loadSubmission', () => {
  it('is null for an unknown id', async () => {
    const store = new InMemoryObjectStore();
    expect(await loadSubmission(store, id('b'))).toBeNull();
  });

  it('refuses a malformed id before any I/O', async () => {
    // Nothing shaped like a path may reach a key.
    const store = new InMemoryObjectStore();
    expect(await loadSubmission(store, '../catalog/current.json')).toBeNull();
    expect(await loadSubmission(store, '')).toBeNull();
    expect(store.calls).toEqual([]);
  });

  it('refuses a record written by a newer build', async () => {
    const store = new InMemoryObjectStore();
    const record = submission({ schemaVersion: 99 });
    store.seed(submissionRecordKey(record.id), encodeJson(record));

    await expect(loadSubmission(store, record.id)).rejects.toThrow(/not supported/);
  });
});

describe('listSubmissions', () => {
  it('returns newest first', async () => {
    const store = new InMemoryObjectStore();
    await seed(
      store,
      submission({ id: id('a'), receivedAt: '2026-09-01T00:00:00.000Z' }),
    );
    await seed(
      store,
      submission({ id: id('b'), receivedAt: '2026-09-08T00:00:00.000Z' }),
    );
    await seed(
      store,
      submission({ id: id('c'), receivedAt: '2026-09-04T00:00:00.000Z' }),
    );

    expect((await listSubmissions(store)).map((each) => each.id)).toEqual([
      id('b'),
      id('c'),
      id('a'),
    ]);
  });

  it('ignores parts whose record is not there', async () => {
    const store = new InMemoryObjectStore();
    // A message caught mid-write: the Worker writes parts first.
    store.seed(submissionPartKey(id('d'), 0), new Uint8Array(10));

    expect(await listSubmissions(store)).toEqual([]);
  });
});

describe('submissionIdFromKey', () => {
  it('reads the id out of any key under the prefix, and nothing else', () => {
    expect(submissionIdFromKey(`${R2_KEYS.inboxPrefix}abc/message.json`)).toBe('abc');
    expect(submissionIdFromKey(`${R2_KEYS.inboxPrefix}abc/parts/3`)).toBe('abc');
    expect(submissionIdFromKey('photos/abc/thumb.webp')).toBeNull();
    expect(submissionIdFromKey(`${R2_KEYS.inboxPrefix}loose.json`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

const AT = '2026-09-08T15:00:00.000Z';

describe('claimSubmission', () => {
  it('takes an unclaimed submission', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());

    const outcome = await claimSubmission(store, record.id, 'tab-one', AT);

    expect(outcome.status).toBe('claimed');
    const stored = await loadSubmission(store, record.id);
    expect(stored?.submission.claim).toEqual({ token: 'tab-one', at: AT });
  });

  it('is not-found for an id that does not exist', async () => {
    const store = new InMemoryObjectStore();
    expect(await claimSubmission(store, id('z'), 'tab', AT)).toEqual({
      status: 'not-found',
    });
  });

  it('reports a live claim held by another tab, and does not steal it', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    await claimSubmission(store, record.id, 'tab-one', AT);

    const later = new Date(Date.parse(AT) + TTL_MS - 1000).toISOString();
    const outcome = await claimSubmission(store, record.id, 'tab-two', later);

    expect(outcome.status).toBe('held');
    const stored = await loadSubmission(store, record.id);
    expect(stored?.submission.claim?.token).toBe('tab-one');
  });

  it('lets another tab take over an expired claim', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    await claimSubmission(store, record.id, 'tab-one', AT);

    const later = new Date(Date.parse(AT) + TTL_MS).toISOString();
    expect((await claimSubmission(store, record.id, 'tab-two', later)).status).toBe(
      'claimed',
    );
    const stored = await loadSubmission(store, record.id);
    expect(stored?.submission.claim).toEqual({ token: 'tab-two', at: later });
  });

  it('lets the holder refresh its own live claim', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    await claimSubmission(store, record.id, 'tab-one', AT);

    const later = new Date(Date.parse(AT) + 1000).toISOString();
    expect((await claimSubmission(store, record.id, 'tab-one', later)).status).toBe(
      'claimed',
    );
  });

  /**
   * The race the conditional write exists for: two tabs read the same
   * unclaimed record and both decide to take it. Only one can win the write,
   * and the loser must be told so rather than believing it holds the claim.
   *
   * Asserted against `InMemoryObjectStore`, whose conflict semantics are
   * explicit, rather than against an emulator (decisions.md #22).
   */
  it('reports a lost race as a conflict, never as a claim', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    let raced = false;

    store.onBeforeConditionalWrite = () => {
      if (raced) return;
      raced = true;
      // The other tab's claim lands between this one's read and its write.
      store.seed(
        submissionRecordKey(record.id),
        encodeJson({ ...record, claim: { token: 'tab-two', at: AT } }),
      );
    };

    const outcome = await claimSubmission(store, record.id, 'tab-one', AT);

    expect(outcome).toEqual({ status: 'conflict' });
    const stored = await loadSubmission(store, record.id);
    expect(stored?.submission.claim?.token).toBe('tab-two');
  });
});

describe('removeSubmission', () => {
  it('deletes the parts and the record together', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    await claimSubmission(store, record.id, 'tab-one', AT);

    const outcome = await removeSubmission(store, record.id, 'tab-one');

    expect(outcome.status).toBe('removed');
    expect(store.keys().filter((key) => key.startsWith(R2_KEYS.inboxPrefix))).toEqual(
      [],
    );
  });

  it('refuses a token that does not match the stored claim', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());
    await claimSubmission(store, record.id, 'tab-one', AT);

    expect(await removeSubmission(store, record.id, 'tab-two')).toEqual({
      status: 'refused',
    });
    // Nothing was deleted out from under the tab that holds the claim.
    expect(store.has(submissionRecordKey(record.id))).toBe(true);
  });

  it('refuses when nothing has been claimed at all', async () => {
    const store = new InMemoryObjectStore();
    const record = await seed(store, submission());

    expect(await removeSubmission(store, record.id, 'tab-one')).toEqual({
      status: 'refused',
    });
  });

  it('refuses an id that does not exist', async () => {
    const store = new InMemoryObjectStore();
    expect(await removeSubmission(store, id('z'), 'tab')).toEqual({
      status: 'refused',
    });
  });
});

describe('submissionObjectKeys', () => {
  it('names every object a submission owns', () => {
    const record = submission();
    expect(submissionObjectKeys(record)).toEqual([
      submissionPartKey(record.id, 0),
      submissionPartKey(record.id, 1),
      submissionRecordKey(record.id),
    ]);
  });
});

describe('inboxUsage', () => {
  it('counts parts and bytes without counting the records', async () => {
    const store = new InMemoryObjectStore();
    await seed(store, submission({ id: id('a') }));
    await seed(store, submission({ id: id('b') }));

    const usage = await inboxUsage(store);

    expect(usage.messages).toBe(2);
    expect(usage.parts).toBe(4);
    expect(usage.bytes).toBe(4 * 1024);
  });

  it('is zero for an empty inbox', async () => {
    expect(await inboxUsage(new InMemoryObjectStore())).toEqual({
      parts: 0,
      bytes: 0,
      messages: 0,
    });
  });
});
