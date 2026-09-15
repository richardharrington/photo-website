import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { dispatchApi } from '../../config/fixture-server.ts';
import type { Body } from '../../config/fixture-server.ts';
import { CURATION_ROUTES } from '../../netlify/functions/lib/curation-routes.ts';
import { FIXTURE_PHOTO_IDS, FIXTURE_UPLOADER_TOKEN } from '../../fixtures/catalog.ts';
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
/** Live, and added by nobody. */
const LIVE_ID = FIXTURE_PHOTO_IDS['beach-early']!;
/** Live, and added by the fixture uploader. */
const OWNED_ID = FIXTURE_PHOTO_IDS['scratch-0-a']!;

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

/** A request carrying the fixture uploader's token unless told otherwise. */
async function call(
  base: string,
  method: string,
  path: string,
  body: unknown = {},
  uploaderToken: string | null = FIXTURE_UPLOADER_TOKEN,
) {
  const url = new URL(`http://localhost/${base}/api${path}`);
  const { res, captured } = fakeResponse();
  await dispatchApi(
    base,
    url.pathname.replace(`/${base}/api`, ''),
    method,
    body as Body,
    url,
    res,
    uploaderToken,
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
  'POST /trash/preview': { selection: { kind: 'ids', photoIds: [OWNED_ID] } },
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

/**
 * The family's trash reaches only what its browser added, here as in the real
 * Function (family-own-trash.md 6.6). The fixture is the more permissive twin
 * that has hidden bugs before, so it gets the same refusals asserted.
 */
describe("the fixture server's family trash", () => {
  const preview = (ids: string[]) => ({ selection: { kind: 'ids', photoIds: ids } });

  it('refuses a preview of a photograph this browser did not add, as an unknown path', async () => {
    const refused = await call(
      DISPLAY_BASE,
      'POST',
      '/trash/preview',
      preview([LIVE_ID]),
    );
    const unknown = await call(
      DISPLAY_BASE,
      'POST',
      '/no-such-route',
      preview([LIVE_ID]),
    );
    expect(refused).toEqual(unknown);
    expect(refused.status).toBe(404);
  });

  it('refuses a preview without a token, and a day even when it is all owned', async () => {
    expect(
      (await call(DISPLAY_BASE, 'POST', '/trash/preview', preview([OWNED_ID]), null))
        .status,
    ).toBe(404);
    expect(
      (
        await call(DISPLAY_BASE, 'POST', '/trash/preview', {
          selection: { kind: 'day', year: 2026, month: 7, day: 4 },
        })
      ).status,
    ).toBe(404);
  });

  it('refuses a restore of a photograph this browser did not add', async () => {
    expect(
      (await call(DISPLAY_BASE, 'POST', '/restore', { photoIds: [LIVE_ID] })).status,
    ).toBe(404);
  });

  it('refuses a family commit without a token', async () => {
    const response = await call(DISPLAY_BASE, 'POST', '/commit', {}, null);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'An uploader token is required.',
    });
  });

  it('filters the listing and the count to what this browser added', async () => {
    const ids = async (base: string, token: string | null) => {
      const listing = await call(base, 'GET', '/trash', undefined, token);
      const count = await call(base, 'GET', '/trash/count', undefined, token);
      return {
        ids: (JSON.parse(listing.body) as { items: { photo: { id: string } }[] }).items
          .map((item) => item.photo.id)
          .sort(),
        count: (JSON.parse(count.body) as { count: number }).count,
      };
    };

    // Put something nobody added in the trash, through the admin base, and
    // take it out again afterwards: this store is shared by the whole file.
    const trashed = await call(
      ADMIN_BASE,
      'POST',
      '/trash/preview',
      preview([LIVE_ID]),
    );
    await call(ADMIN_BASE, 'POST', '/trash/confirm', JSON.parse(trashed.body));
    try {
      const family = await ids(DISPLAY_BASE, FIXTURE_UPLOADER_TOKEN);
      const admin = await ids(ADMIN_BASE, null);

      expect(family.ids).not.toContain(LIVE_ID);
      expect(family.count).toBe(family.ids.length);
      expect(admin.ids).toContain(LIVE_ID);
      expect(admin.ids).toEqual(expect.arrayContaining(family.ids));
      expect(admin.count).toBe(family.count + 1);

      expect(await ids(DISPLAY_BASE, null)).toEqual({ ids: [], count: 0 });
    } finally {
      await call(ADMIN_BASE, 'POST', '/restore', { photoIds: [LIVE_ID] });
    }
  });
});
