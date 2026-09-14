import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { dispatchApi } from '../../config/fixture-server.ts';
import type { Body } from '../../config/fixture-server.ts';
import { CURATION_ROUTES } from '../../netlify/functions/lib/curation-routes.ts';
import { FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';
import { RENDITIONS } from '../../src/shared/constants.ts';
import { ADMIN_ONLY_ROUTES } from './admin-only-routes.ts';

/**
 * The development fixture server holds the same tier production does.
 *
 * It has been more permissive than production before and hid a missing route
 * (CLAUDE.md). After family-tier.md it must be exactly as permissive in both
 * directions: the display base answers every curation route, and refuses every
 * admin-only one with the plain 404.
 *
 * The fixture keeps one in-memory store for the process, so the requests here
 * are chosen to succeed against the fixture catalog rather than to leave it
 * as they found it.
 */

const DISPLAY_BASE = 'dev-display-path';
const ADMIN_BASE = process.env.ADMIN_PATH || 'dev-admin-path';
const LIVE_ID = FIXTURE_PHOTO_IDS['beach-early']!;

function fakeResponse() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: unknown) {
      captured.body = body === undefined ? '' : String(body);
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

async function call(base: string, method: string, path: string, body: unknown = {}) {
  const url = new URL(`http://localhost/${base}/api${path}`);
  const { res, captured } = fakeResponse();
  await dispatchApi(
    base,
    url.pathname.replace(`/${base}/api`, ''),
    method,
    body as Body,
    url,
    res,
  );
  return captured;
}

/** One request per curation route that the fixture answers with a 200. */
const REACHING: Record<string, unknown> = {
  'GET /trash': undefined,
  'GET /trash/count': undefined,
  'POST /begin-batch': {},
  'POST /prepare': { contentHash: 'f'.repeat(64), originalFilename: 'new.jpg' },
  'POST /commit': {
    photoId: 'c'.repeat(32),
    contentHash: 'e'.repeat(64),
    originalFilename: 'new.jpg',
    sourceMimeType: 'image/jpeg',
    timestampSource: 'none',
    batchSeq: 1,
    selectionIndex: 0,
    derivatives: Object.fromEntries(
      RENDITIONS.map((rendition) => [rendition, { width: 10, height: 10, bytes: 10 }]),
    ),
  },
  'POST /edit': { photoId: LIVE_ID, caption: 'At the beach' },
  'POST /trash/preview': { selection: { kind: 'ids', photoIds: [LIVE_ID] } },
  'POST /trash/confirm': { photoIds: [] },
  'POST /restore': { photoIds: [] },
};

describe('the fixture server', () => {
  it('knows a reaching request for exactly the curation routes', () => {
    expect(
      CURATION_ROUTES.map(({ method, path }) => `${method} ${path}`).sort(),
    ).toEqual(Object.keys(REACHING).sort());
  });

  describe.each([
    ['display', DISPLAY_BASE],
    ['admin', ADMIN_BASE],
  ])('under the %s base', (_name, base) => {
    it.each(CURATION_ROUTES.map((route) => [`${route.method} ${route.path}`, route]))(
      'answers %s',
      async (key, { method, path }) => {
        const response = await call(base, method, path, REACHING[key]);
        expect(response.status, response.body).toBe(200);
      },
    );
  });

  describe('under the display base', () => {
    it.each(ADMIN_ONLY_ROUTES.map((route) => [`${route.method} ${route.path}`, route]))(
      'refuses %s with the plain 404 an unknown path gets',
      async (_key, { method, path, body }) => {
        const refused = await call(DISPLAY_BASE, method, path, body);
        const unknown = await call(DISPLAY_BASE, method, '/no-such-route', body);
        expect(refused).toEqual(unknown);
        expect(refused.status).toBe(404);
      },
    );
  });

  it('still answers the admin-only routes under the admin base', async () => {
    expect((await call(ADMIN_BASE, 'GET', '/export')).status).toBe(200);
    expect((await call(ADMIN_BASE, 'GET', '/emails')).status).toBe(200);
    expect((await call(ADMIN_BASE, 'GET', '/inbox/count')).status).toBe(200);
  });
});
