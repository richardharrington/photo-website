import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler as createDisplayHandler } from '../../netlify/functions/display.ts';
import { createHandler as createAdminHandler } from '../../netlify/functions/admin.ts';
import { CURATION_ROUTES } from '../../netlify/functions/lib/curation-routes.ts';
import {
  ACCESS_MODE_HEADER,
  INTERNAL_SECRET_HEADER,
} from '../../netlify/functions/lib/http.ts';
import type { AccessMode } from '../../netlify/functions/lib/http.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { FIXTURE_PHOTO_IDS, fixtureCatalog } from '../../fixtures/catalog.ts';
import { R2_KEYS } from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import type { AuditEvent } from '../../src/shared/audit.ts';
import { ADMIN_ONLY_ROUTES as ADMIN_ONLY } from './admin-only-routes.ts';

/**
 * The tier, asserted (family-tier.md #2).
 *
 * The display link is the family link: a display-mode request may reach the
 * read routes, `/download/<id>`, and the curation routes, and nothing else.
 * These drive the real Functions' handlers over an in-memory store, through
 * the same gate headers production uses, and assert both directions — every
 * curation route answers in display mode, and every admin-only route is the
 * very same 404 an unknown path is.
 *
 * A routing 404 and a "no such photo" 404 are indistinguishable by design, so
 * each curation route gets a request chosen to produce something other than
 * 404 when it is reached: a 400 for a malformed body, or a 200.
 */

const GATE_SECRET = 'test-gate-secret';
const LIVE_ID = FIXTURE_PHOTO_IDS['beach-early']!;
const TRASHED_ID = FIXTURE_PHOTO_IDS['deleted-0']!;

let store: InMemoryObjectStore;

beforeEach(() => {
  vi.stubEnv('INTERNAL_GATE_SECRET', GATE_SECRET);
  vi.stubEnv('ASSET_SIGNING_KEY', 'dGVzdC1zaWduaW5nLWtleS1mb3ItdW5pdC10ZXN0cw==');
  vi.stubEnv('WORKER_BASE_URL', 'https://worker.example.test');
  vi.stubEnv('R2_S3_ENDPOINT', 'https://account.r2.example.test');
  vi.stubEnv('R2_BUCKET', 'photos');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key');
  vi.stubEnv('R2_ACCOUNT_ID', 'test-account');
  vi.stubEnv('CLOUDFLARE_ADDRESSES_WRITE_TOKEN', 'test-token');

  store = new InMemoryObjectStore();
  store.seed(R2_KEYS.catalog, encodeJson(fixtureCatalog()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function handlerFor(mode: AccessMode) {
  return mode === 'display'
    ? createDisplayHandler(() => store)
    : createAdminHandler(() => store);
}

function gated(
  mode: AccessMode,
  method: string,
  path: string,
  body?: unknown,
): Request {
  return new Request(`https://photos.example.test/.netlify/functions/${mode}${path}`, {
    method,
    headers: {
      [ACCESS_MODE_HEADER]: mode,
      [INTERNAL_SECRET_HEADER]: GATE_SECRET,
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

/**
 * One reaching request per curation route. Keyed by method and path so the
 * test below can insist this table and `CURATION_ROUTES` are the same list: a
 * route added to the module without a line here fails.
 */
const REACHING: Record<string, { body?: unknown; status: number }> = {
  'GET /trash': { status: 200 },
  'GET /trash/count': { status: 200 },
  'POST /begin-batch': { status: 200 },
  'POST /prepare': { body: {}, status: 400 },
  'POST /commit': { body: {}, status: 400 },
  'POST /edit': { body: { photoId: LIVE_ID, date: 'not a date' }, status: 400 },
  'POST /trash/preview': { body: {}, status: 400 },
  'POST /trash/confirm': { body: {}, status: 400 },
  'POST /restore': { body: {}, status: 400 },
};

async function snapshot(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

describe('CURATION_ROUTES', () => {
  it('is exactly the list this test knows how to reach', () => {
    expect(
      CURATION_ROUTES.map(({ method, path }) => `${method} ${path}`).sort(),
    ).toEqual(Object.keys(REACHING).sort());
  });

  it('shares no path with an admin-only route', () => {
    const curation = new Set(CURATION_ROUTES.map(({ path }) => path));
    for (const { path } of ADMIN_ONLY) {
      expect(curation.has(path.split('?')[0]!), path).toBe(false);
    }
  });
});

describe.each(['display', 'admin'] as const)('%s mode', (mode) => {
  it.each(CURATION_ROUTES.map((route) => [`${route.method} ${route.path}`, route]))(
    'reaches %s',
    async (key, { method, path }) => {
      const { body, status } = REACHING[key]!;
      const response = await handlerFor(mode)(gated(mode, method, path, body));
      expect(response.status).toBe(status);
    },
  );
});

describe('display mode', () => {
  it.each(ADMIN_ONLY.map((route) => [`${route.method} ${route.path}`, route]))(
    'refuses %s with the plain 404 an unknown path gets',
    async (_key, { method, path, body }) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const handler = handlerFor('display');

      const refused = await snapshot(
        await handler(gated('display', method, path, body)),
      );
      const unknown = await snapshot(
        await handler(gated('display', method, '/no-such-route', body)),
      );

      expect(refused).toEqual(unknown);
      expect(refused.status).toBe(404);
      // Nothing admin-only ran far enough to call Cloudflare or the Worker.
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('still refuses a request the gate did not mark', async () => {
    const request = new Request(
      'https://photos.example.test/.netlify/functions/display/trash/count',
      { headers: { [ACCESS_MODE_HEADER]: 'display' } },
    );
    expect((await handlerFor('display')(request)).status).toBe(404);
  });

  it('cannot confirm a permanent delete with a trash token', async () => {
    const handler = handlerFor('display');
    const preview = await handler(
      gated('display', 'POST', '/trash/preview', {
        selection: { kind: 'ids', photoIds: [LIVE_ID] },
      }),
    );
    const token = await preview.json();

    const admin = handlerFor('admin');
    const confirm = await admin(
      gated('admin', 'POST', '/permanent-delete/confirm', token),
    );
    expect(confirm.status).toBe(400);
    expect(await confirm.json()).toEqual({
      error: 'That confirmation does not match the selection it was issued for.',
    });
  });
});

describe('the audit log', () => {
  async function auditEvents(): Promise<AuditEvent[]> {
    const listed = await store.list(R2_KEYS.auditPrefix);
    return listed.map(({ key }) => store.readJson<AuditEvent>(key)!);
  }

  it.each([
    ['display', 'display-api'],
    ['admin', 'admin-api'],
  ] as const)('records a %s-mode restore as %s', async (mode, via) => {
    const response = await handlerFor(mode)(
      gated(mode, 'POST', '/restore', { photoIds: [TRASHED_ID] }),
    );
    expect(response.status).toBe(200);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'restore', via, photoIds: [TRASHED_ID] });
  });

  it('records a display-mode edit as display-api', async () => {
    const response = await handlerFor('display')(
      gated('display', 'POST', '/edit', { photoId: LIVE_ID, caption: 'At the beach' }),
    );
    expect(response.status).toBe(200);
    expect(await auditEvents()).toEqual([
      expect.objectContaining({ action: 'metadata-change', via: 'display-api' }),
    ]);
  });
});
