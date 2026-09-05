import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { resetCatalogCache } from '../../worker/src/index.ts';
import type { Env } from '../../worker/src/index.ts';
import { runDigest, runDigestTest } from '../../worker/src/digest.ts';
import type { DigestDeps, SendEmailLike } from '../../worker/src/digest.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { bindingFor } from '../../fixtures/r2-binding.ts';
import { makeCatalog, makePhoto, testPhotoId } from '../../fixtures/photos.ts';
import { R2_KEYS } from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import { signNotificationTest } from '../../src/shared/signing.ts';
import type { NotificationState } from '../../src/shared/notifications.ts';
import type { FetchLike } from '../../src/shared/cloudflare-addresses.ts';
import type { Catalog } from '../../src/shared/catalog.ts';

const KEY = 'digest-test-signing-key';
const NOW = new Date('2026-09-05T04:17:00.000Z');
const SITE = 'https://photos.test/secret-display-path';

interface Sent {
  to: string;
  subject: string;
  text: string;
}

/** A send binding that records instead of sending, and can be made to fail. */
function fakeEmail(failFor: readonly string[] = []) {
  const sent: Sent[] = [];
  const binding: SendEmailLike = {
    async send(message) {
      if (failFor.includes(message.to)) {
        throw new Error(`Cloudflare refused ${message.to}`);
      }
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return {};
    },
  };
  return { binding, sent };
}

/**
 * Cloudflare's address API, faked at the HTTP boundary.
 *
 * Deliberately faked here rather than at the client, so the `verified`
 * timestamp-or-null mapping is exercised rather than assumed.
 */
function fakeFetch(addresses: readonly { email: string; verified: boolean }[]) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result:
            page > 1
              ? []
              : addresses.map((address, index) => ({
                  id: `cf-${index}`,
                  email: address.email,
                  // Cloudflare's own shape: an instant, or null.
                  verified: address.verified ? '2026-08-01T00:00:00.000Z' : null,
                })),
        };
      },
    };
  };
  return { fetchImpl, calls };
}

function uploaded(createdAt: string, trashedAt: string | null = null) {
  return makePhoto({ id: testPhotoId(createdAt), createdAt, trashedAt });
}

const CATALOG = makeCatalog([
  uploaded('2026-09-02T09:00:00.000Z'),
  uploaded('2026-09-03T09:00:00.000Z'),
  uploaded('2026-09-04T09:00:00.000Z'),
]);

function seedStore(
  catalog: Catalog = CATALOG,
  state?: NotificationState,
): InMemoryObjectStore {
  const store = new InMemoryObjectStore();
  store.seed(R2_KEYS.catalog, encodeJson(catalog));
  if (state) store.seed(R2_KEYS.notifications, encodeJson(state));
  return store;
}

function stateWith(
  recipients: Record<string, { enabled: boolean; seenThrough: string }>,
): NotificationState {
  return {
    schemaVersion: 1,
    recipients: Object.fromEntries(
      Object.entries(recipients).map(([email, value]) => [
        email,
        { ...value, lastSent: null },
      ]),
    ),
  };
}

function deps(
  store: InMemoryObjectStore,
  email: SendEmailLike,
  fetchImpl: FetchLike,
): DigestDeps {
  return {
    store,
    email,
    fetch: fetchImpl,
    accountId: 'account',
    apiToken: 'token',
    from: 'photos@example.test',
    siteTitle: 'Family Photos',
    displaySiteUrl: SITE,
    now: () => NOW,
  };
}

function readState(store: InMemoryObjectStore): NotificationState {
  return store.readJson<NotificationState>(R2_KEYS.notifications)!;
}

afterEach(() => vi.restoreAllMocks());

describe('runDigest', () => {
  it('sends one message per recipient and never several on one', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
        'b@example.com': { enabled: true, seenThrough: '2026-09-03T09:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([
      { email: 'a@example.com', verified: true },
      { email: 'b@example.com', verified: true },
    ]);

    const report = await runDigest(deps(store, binding, fetchImpl));

    expect(report).toEqual({
      considered: 2,
      sent: 2,
      skippedUnverified: 0,
      skippedDisabled: 0,
      skippedEmpty: 0,
      failed: 0,
    });
    // Each message has exactly one recipient: nobody learns who else is on
    // the list.
    expect(sent.map((message) => message.to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(sent[0]?.subject).toBe('3 new photos on Family Photos');
    expect(sent[1]?.subject).toBe('1 new photo on Family Photos');
    expect(sent[0]?.text).toContain(`${SITE}/recent`);
  });

  it('counts every skipped address in the log line', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'off@example.com': { enabled: false, seenThrough: '2026-09-01T00:00:00.000Z' },
        'caught-up@example.com': {
          enabled: true,
          seenThrough: '2026-09-04T09:00:00.000Z',
        },
        'pending@example.com': {
          enabled: true,
          seenThrough: '2026-09-01T00:00:00.000Z',
        },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([
      { email: 'off@example.com', verified: true },
      { email: 'caught-up@example.com', verified: true },
      { email: 'pending@example.com', verified: false },
      // Verified at Cloudflare, never added through the page: no state entry,
      // which reads as switched off.
      { email: 'stranger@example.com', verified: true },
    ]);

    const report = await runDigest(deps(store, binding, fetchImpl));

    expect(sent).toEqual([]);
    expect(report).toEqual({
      considered: 4,
      sent: 0,
      skippedUnverified: 1,
      skippedDisabled: 2,
      skippedEmpty: 1,
      failed: 0,
    });
  });

  it('advances the watermark only after the send succeeded', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    await runDigest(deps(store, binding, fetchImpl));

    const recipient = readState(store).recipients['a@example.com'];
    // The newest photo counted, not the moment the run happened.
    expect(recipient?.seenThrough).toBe('2026-09-04T09:00:00.000Z');
    expect(recipient?.lastSent).toEqual({ at: NOW.toISOString(), count: 3 });
  });

  it('leaves a failed recipient exactly where it was, and advances the others', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'broken@example.com': {
          enabled: true,
          seenThrough: '2026-09-01T00:00:00.000Z',
        },
        'fine@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail(['broken@example.com']);
    const { fetchImpl } = fakeFetch([
      { email: 'broken@example.com', verified: true },
      { email: 'fine@example.com', verified: true },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = await runDigest(deps(store, binding, fetchImpl));

    expect(report.sent).toBe(1);
    expect(report.failed).toBe(1);
    expect(sent.map((message) => message.to)).toEqual(['fine@example.com']);

    const state = readState(store);
    // Untouched, so tomorrow's digest for it covers both days.
    expect(state.recipients['broken@example.com']?.seenThrough).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(state.recipients['broken@example.com']?.lastSent).toBeNull();
    expect(state.recipients['fine@example.com']?.seenThrough).toBe(
      '2026-09-04T09:00:00.000Z',
    );
  });

  it('prunes entries whose address Cloudflare no longer holds', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
        'gone@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    await runDigest(deps(store, binding, fetchImpl));

    expect(Object.keys(readState(store).recipients)).toEqual(['a@example.com']);
  });

  it('ignores trashed photos, so the count matches the link', async () => {
    const store = seedStore(
      makeCatalog([
        uploaded('2026-09-03T09:00:00.000Z'),
        uploaded('2026-09-04T09:00:00.000Z', '2026-09-04T10:00:00.000Z'),
      ]),
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    await runDigest(deps(store, binding, fetchImpl));

    expect(sent[0]?.subject).toBe('1 new photo on Family Photos');
  });

  it('writes nothing when there is nothing to send', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([
      { email: 'stranger@example.com', verified: true },
    ]);

    await runDigest(deps(store, binding, fetchImpl));

    expect(store.calls.filter((call) => call.startsWith('putConditional'))).toEqual([]);
  });
});

describe('runDigestTest', () => {
  it('sends even when nothing is new, and does not move the watermark', async () => {
    const state = stateWith({
      'a@example.com': { enabled: false, seenThrough: '2026-09-04T09:00:00.000Z' },
    });
    const store = seedStore(CATALOG, state);
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    const outcome = await runDigestTest(
      deps(store, binding, fetchImpl),
      'a@example.com',
    );

    expect(outcome).toEqual({ count: 0 });
    expect(sent[0]?.subject).toBe('[Test] No new photos on Family Photos');
    // Not enabled, and still exactly as it was.
    expect(readState(store)).toEqual(state);
  });

  it('does not consult enabled: the point is to test before switching on', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: false, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    expect(
      await runDigestTest(deps(store, binding, fetchImpl), 'a@example.com'),
    ).toEqual({ count: 3 });
    expect(sent[0]?.subject).toBe('[Test] 3 new photos on Family Photos');
  });

  it('refuses an unverified address, because Cloudflare would', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: false }]);

    expect(
      await runDigestTest(deps(store, binding, fetchImpl), 'a@example.com'),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  it('previews from now for an address with no entry, not from the whole library', async () => {
    const store = seedStore(CATALOG);
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    expect(
      await runDigestTest(deps(store, binding, fetchImpl), 'a@example.com'),
    ).toEqual({ count: 0 });
    expect(sent[0]?.subject).toBe('[Test] No new photos on Family Photos');
  });
});

// ---------------------------------------------------------------------------
// The Worker's one POST route
// ---------------------------------------------------------------------------

function envFor(
  store: InMemoryObjectStore,
  email: SendEmailLike,
  fetchImpl: FetchLike,
  overrides: Partial<Env> = {},
): Env {
  return {
    PHOTOS: bindingFor(store),
    ASSET_SIGNING_KEY: KEY,
    EMAIL: email,
    FETCH: fetchImpl,
    SITE_TITLE: 'Family Photos',
    NOTIFY_FROM: 'photos@example.test',
    DISPLAY_SITE_URL: SITE,
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_ADDRESSES_READ_TOKEN: 'token',
    ...overrides,
  };
}

async function post(body: unknown): Promise<Request> {
  return new Request('https://photo-assets.test/notify/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function grantFor(email: string, offsetSeconds = 60) {
  const expiresAt = Math.floor(Date.now() / 1000) + offsetSeconds;
  return {
    email,
    exp: expiresAt,
    sig: await signNotificationTest(KEY, { email, expiresAt }),
  };
}

describe('POST /notify/test', () => {
  beforeEach(() => resetCatalogCache());

  it('sends and answers with the count', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: false, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    const response = await worker.fetch(
      await post(await grantFor('a@example.com')),
      envFor(store, binding, fetchImpl),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 3 });
    expect(sent).toHaveLength(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves the watermark alone', async () => {
    const state = stateWith({
      'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
    });
    const store = seedStore(CATALOG, state);
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);

    await worker.fetch(
      await post(await grantFor('a@example.com')),
      envFor(store, binding, fetchImpl),
    );

    expect(readState(store)).toEqual(state);
  });

  /**
   * Every refusal is the same plain 404. A distinguishable response here would
   * be a probe oracle for whether an address is on the list.
   */
  describe('refuses with a plain 404', () => {
    async function refuse(
      request: Request,
      overrides: Partial<Env> = {},
      addresses: readonly { email: string; verified: boolean }[] = [
        { email: 'a@example.com', verified: true },
      ],
    ) {
      const store = seedStore(CATALOG, stateWith({}));
      const { binding, sent } = fakeEmail();
      const { fetchImpl } = fakeFetch(addresses);
      const response = await worker.fetch(
        request,
        envFor(store, binding, fetchImpl, overrides),
      );
      return { response, sent };
    }

    it('a bad signature', async () => {
      const grant = await grantFor('a@example.com');
      const { response, sent } = await refuse(
        await post({ ...grant, sig: 'f'.repeat(64) }),
      );
      expect(response.status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('a grant re-pointed at another address', async () => {
      const grant = await grantFor('a@example.com');
      const { response } = await refuse(
        await post({ ...grant, email: 'stranger@example.com' }),
      );
      expect(response.status).toBe(404);
    });

    it('an expired grant', async () => {
      const { response, sent } = await refuse(
        await post(await grantFor('a@example.com', -1)),
      );
      expect(response.status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('an address nobody has verified', async () => {
      const { response, sent } = await refuse(
        await post(await grantFor('a@example.com')),
        {},
        [{ email: 'a@example.com', verified: false }],
      );
      expect(response.status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('a malformed body', async () => {
      expect((await refuse(await post('not json'))).response.status).toBe(404);
      expect((await refuse(await post({}))).response.status).toBe(404);
      expect(
        (await refuse(await post({ email: 'a@example.com', exp: 'soon', sig: 'x' })))
          .response.status,
      ).toBe(404);
    });

    it('an address that is not one', async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 60;
      const email = 'a@example.com, b@example.com';
      const sig = await signNotificationTest(KEY, { email, expiresAt });
      const { response } = await refuse(await post({ email, exp: expiresAt, sig }));
      expect(response.status).toBe(404);
    });

    it('a deployment with no send binding configured', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { response } = await refuse(await post(await grantFor('a@example.com')), {
        NOTIFY_FROM: undefined,
      });
      expect(response.status).toBe(404);
    });

    it('an unset signing key', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { response } = await refuse(await post(await grantFor('a@example.com')), {
        ASSET_SIGNING_KEY: '',
      });
      expect(response.status).toBe(404);
    });

    it('any method but POST', async () => {
      const store = seedStore(CATALOG, stateWith({}));
      const { binding } = fakeEmail();
      const { fetchImpl } = fakeFetch([]);
      const env = envFor(store, binding, fetchImpl);

      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await worker.fetch(
          new Request('https://photo-assets.test/notify/test', { method }),
          env,
        );
        expect(response.status).toBe(404);
      }
    });
  });

  it('leaves every other path refusing non-GET as before', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([]);

    const response = await worker.fetch(
      new Request('https://photo-assets.test/p/aaaa/thumb', { method: 'POST' }),
      envFor(store, binding, fetchImpl),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The cron
// ---------------------------------------------------------------------------

describe('scheduled()', () => {
  beforeEach(() => resetCatalogCache());

  it('runs the digest after maintenance', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await worker.scheduled(null, envFor(store, binding, fetchImpl));

    expect(sent).toHaveLength(1);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('Maintenance complete');
    expect(lines).toContain('Digest complete');
    // Maintenance first: the count should describe the library after a purge.
    expect(lines.indexOf('Maintenance complete')).toBeLessThan(
      lines.indexOf('Digest complete'),
    );
  });

  it('still runs the digest when maintenance throws', async () => {
    const store = seedStore(
      CATALOG,
      stateWith({
        'a@example.com': { enabled: true, seenThrough: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: true }]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Maintenance lists object prefixes; this makes that fail.
    vi.spyOn(store, 'list').mockRejectedValue(new Error('R2 is having a day'));

    await worker.scheduled(null, envFor(store, binding, fetchImpl));

    expect(errors.mock.calls.map((call) => String(call[0]))).toContain(
      'Maintenance failed',
    );
    expect(sent).toHaveLength(1);
  });

  it('still completes maintenance when the digest throws', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding } = fakeEmail();
    const failing: FetchLike = async () => {
      throw new Error('Cloudflare is unreachable');
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await worker.scheduled(null, envFor(store, binding, failing));

    expect(log.mock.calls.map((call) => String(call[0]))).toContain(
      'Maintenance complete',
    );
    expect(errors.mock.calls.map((call) => String(call[0]))).toContain('Digest failed');
  });

  it('sends nothing, and does not throw, on a deployment with no mail configured', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding, sent } = fakeEmail();
    const { fetchImpl } = fakeFetch([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await worker.scheduled(
      null,
      envFor(store, binding, fetchImpl, { DISPLAY_SITE_URL: undefined }),
    );

    expect(sent).toEqual([]);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      'Notifications are not configured; sending nothing.',
    );
  });
});

// A guard on the one thing the whole feature turns on: `verified` arrives as a
// timestamp or null, and must never be treated as a boolean.
describe('the Cloudflare boundary', () => {
  it('maps a null verified timestamp to false, not to truthiness', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding } = fakeEmail();
    const { fetchImpl } = fakeFetch([{ email: 'a@example.com', verified: false }]);

    const report = await runDigest(deps(store, binding, fetchImpl));
    expect(report.skippedUnverified).toBe(1);
  });

  it('sends a signed test to a lowercased address regardless of how it was typed', async () => {
    const store = seedStore(CATALOG, stateWith({}));
    const { binding, sent } = fakeEmail();
    // Cloudflare returns what was typed; everything below the boundary is
    // lowercased, so the two spellings are one recipient.
    const { fetchImpl } = fakeFetch([{ email: 'Aunt@Example.COM', verified: true }]);

    const response = await worker.fetch(
      await post(await grantFor('aunt@example.com')),
      envFor(store, binding, fetchImpl),
    );

    expect(response.status).toBe(200);
    expect(sent[0]?.to).toBe('aunt@example.com');
  });
});
