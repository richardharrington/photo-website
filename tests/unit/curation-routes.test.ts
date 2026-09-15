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
import {
  FIXTURE_PHOTO_IDS,
  FIXTURE_UPLOADER_HASH,
  FIXTURE_UPLOADER_TOKEN,
  fixtureCatalog,
} from '../../fixtures/catalog.ts';
import { R2_KEYS, RENDITIONS, photoObjectKey } from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import type { AuditEvent } from '../../src/shared/audit.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import { UPLOADER_HEADER } from '../../src/shared/uploader.ts';
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
/** Live, and added by nobody: no uploader hash. */
const LIVE_ID = FIXTURE_PHOTO_IDS['beach-early']!;
/** Live, and added by the fixture uploader. */
const OWNED_ID = FIXTURE_PHOTO_IDS['scratch-0-a']!;
/** Trashed, and added by the fixture uploader. */
const TRASHED_ID = FIXTURE_PHOTO_IDS['deleted-0']!;
const OTHER_TRASHED_ID = FIXTURE_PHOTO_IDS['deleted-1']!;

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

/**
 * A request as the gate forwards it. It carries the fixture uploader's token
 * unless told otherwise, as the family app always does; the admin link
 * ignores it.
 */
function gated(
  mode: AccessMode,
  method: string,
  path: string,
  body?: unknown,
  uploaderToken: string | null = FIXTURE_UPLOADER_TOKEN,
): Request {
  return new Request(`https://photos.example.test/.netlify/functions/${mode}${path}`, {
    method,
    headers: {
      [ACCESS_MODE_HEADER]: mode,
      [INTERNAL_SECRET_HEADER]: GATE_SECRET,
      'content-type': 'application/json',
      ...(uploaderToken === null ? {} : { [UPLOADER_HEADER]: uploaderToken }),
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
  'POST /edit': { body: { photoId: OWNED_ID, date: 'not a date' }, status: 400 },
  'POST /trash/preview': { body: {}, status: 400 },
  'POST /trash/confirm': { body: {}, status: 400 },
  'POST /restore': { body: {}, status: 400 },
  'POST /permanent-delete/preview': { body: {}, status: 400 },
  'POST /permanent-delete/confirm': { body: {}, status: 400 },
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
        selection: { kind: 'ids', photoIds: [OWNED_ID] },
      }),
    );
    expect(preview.status).toBe(200);
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
      gated('display', 'POST', '/edit', { photoId: OWNED_ID, caption: 'At the beach' }),
    );
    expect(response.status).toBe(200);
    expect(await auditEvents()).toEqual([
      expect.objectContaining({ action: 'metadata-change', via: 'display-api' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The family trashes only what it added (family-own-trash.md 6.5, 11.1)
// ---------------------------------------------------------------------------

function catalogInStore(): Catalog {
  return store.readJson<Catalog>(R2_KEYS.catalog)!;
}

function setUploaderHash(id: string, uploaderHash: string | null): void {
  const catalog = catalogInStore();
  catalog.photos[id] = { ...catalog.photos[id]!, uploaderHash };
  store.seed(R2_KEYS.catalog, encodeJson(catalog));
}

const isTrashed = (id: string) => catalogInStore().photos[id]!.trashedAt !== null;

function previewOf(ids: string[]) {
  return { selection: { kind: 'ids', photoIds: ids } };
}

/** Move photographs to the trash through the admin link. */
async function adminTrash(...ids: string[]): Promise<void> {
  const admin = handlerFor('admin');
  const preview = await admin(gated('admin', 'POST', '/trash/preview', previewOf(ids)));
  const confirm = await admin(
    gated('admin', 'POST', '/trash/confirm', await preview.json()),
  );
  expect((await confirm.json()).count).toBe(ids.length);
}

/**
 * The same request sent to a path that does not exist, through the same
 * handler with the same headers: what every refusal must be identical to.
 */
async function refusedLikeAnUnknownPath(
  path: string,
  body: unknown,
  uploaderToken: string | null = FIXTURE_UPLOADER_TOKEN,
) {
  const handler = handlerFor('display');
  const refused = await snapshot(
    await handler(gated('display', 'POST', path, body, uploaderToken)),
  );
  const unknown = await snapshot(
    await handler(gated('display', 'POST', '/no-such-route', body, uploaderToken)),
  );
  expect(refused).toEqual(unknown);
  expect(refused.status).toBe(404);
}

describe('a commit', () => {
  const NEW_ID = 'c'.repeat(32);
  const body = {
    photoId: NEW_ID,
    contentHash: 'e'.repeat(64),
    originalFilename: 'new.jpg',
    sourceMimeType: 'image/jpeg',
    timestampSource: 'none',
    batchSeq: 1,
    selectionIndex: 0,
    derivatives: Object.fromEntries(
      RENDITIONS.map((rendition) => [rendition, { width: 10, height: 10, bytes: 10 }]),
    ),
  };

  beforeEach(() => {
    for (const rendition of RENDITIONS) {
      store.seed(photoObjectKey(NEW_ID, rendition), new Uint8Array([1]));
    }
  });

  it('through the family link without a token is refused, and stores nothing', async () => {
    const response = await handlerFor('display')(
      gated('display', 'POST', '/commit', body, null),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'An uploader token is required.' });
    expect(catalogInStore().photos[NEW_ID]).toBeUndefined();
  });

  it('through the family link records the hash of its token, and nothing else does', async () => {
    const response = await handlerFor('display')(
      gated('display', 'POST', '/commit', body),
    );
    expect(response.status).toBe(200);
    const reply = await response.text();

    expect(catalogInStore().photos[NEW_ID]!.uploaderHash).toBe(FIXTURE_UPLOADER_HASH);
    // Not the reply every page may see, and not the audit log kept forever.
    expect(reply).not.toContain(FIXTURE_UPLOADER_HASH);
    const listed = await store.list(R2_KEYS.auditPrefix);
    expect(listed).toHaveLength(1);
    const event = JSON.stringify(store.readJson(listed[0]!.key));
    expect(event).not.toContain(FIXTURE_UPLOADER_HASH);
    expect(event).not.toContain(FIXTURE_UPLOADER_TOKEN);
  });

  it('through the admin link records no hash, whatever header arrives', async () => {
    const response = await handlerFor('admin')(gated('admin', 'POST', '/commit', body));
    expect(response.status).toBe(200);
    expect(catalogInStore().photos[NEW_ID]!.uploaderHash).toBeNull();
  });
});

describe("in display mode, the family's trash", () => {
  describe('preview', () => {
    it.each([
      ['added from another browser', OWNED_ID, 'other'],
      ['added by nobody', LIVE_ID, 'token'],
      ['asked for with no token', OWNED_ID, 'none'],
      ['asked for with a malformed token', OWNED_ID, 'malformed'],
    ] as const)('of a photograph %s is the plain 404', async (_name, id, presented) => {
      if (presented === 'other') setUploaderHash(id, 'f'.repeat(64));
      const token =
        presented === 'none'
          ? null
          : presented === 'malformed'
            ? FIXTURE_UPLOADER_TOKEN.toUpperCase()
            : FIXTURE_UPLOADER_TOKEN;

      await refusedLikeAnUnknownPath('/trash/preview', previewOf([id]), token);
    });

    it.each([
      ['day', { kind: 'day', year: 2026, month: 7, day: 4 }],
      ['month', { kind: 'month', year: 2026, month: 7 }],
      ['year', { kind: 'year', year: 2026 }],
    ])(
      'of a %s is the plain 404, even when this browser added all of it',
      async (_kind, selection) => {
        // July 4th is the fixture uploader's scratch day, every photograph owned.
        await refusedLikeAnUnknownPath('/trash/preview', { selection });
      },
    );

    it('is cut to the photographs this browser added', async () => {
      const response = await handlerFor('display')(
        gated('display', 'POST', '/trash/preview', previewOf([OWNED_ID, LIVE_ID])),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ photoIds: [OWNED_ID], count: 1 });
    });
  });

  describe('confirm', () => {
    async function preview(ids: string[]) {
      const response = await handlerFor('display')(
        gated('display', 'POST', '/trash/preview', previewOf(ids)),
      );
      expect(response.status).toBe(200);
      return response.json();
    }

    it('trashes an owned photograph', async () => {
      const token = await preview([OWNED_ID]);
      const response = await handlerFor('display')(
        gated('display', 'POST', '/trash/confirm', token),
      );
      expect(await response.json()).toEqual({ trashed: [OWNED_ID], count: 1 });
      expect(isTrashed(OWNED_ID)).toBe(true);
    });

    it('trashes nothing once the photograph has stopped being owned', async () => {
      const token = await preview([OWNED_ID]);
      setUploaderHash(OWNED_ID, 'f'.repeat(64));

      const response = await handlerFor('display')(
        gated('display', 'POST', '/trash/confirm', token),
      );
      expect(await response.json()).toEqual({ trashed: [], count: 0 });
      expect(isTrashed(OWNED_ID)).toBe(false);
    });

    it('re-checks ownership when a conflicting write forces a retry', async () => {
      const token = await preview([OWNED_ID]);
      // The first attempt read an owned photograph; the write it then tries
      // loses to one that changes that, and the retry must see the change.
      store.onBeforeConditionalWrite = () => {
        store.onBeforeConditionalWrite = null;
        setUploaderHash(OWNED_ID, 'f'.repeat(64));
      };

      const response = await handlerFor('display')(
        gated('display', 'POST', '/trash/confirm', token),
      );
      expect(await response.json()).toEqual({ trashed: [], count: 0 });
      expect(isTrashed(OWNED_ID)).toBe(false);
    });

    it('without a token is the plain 404', async () => {
      const token = await preview([OWNED_ID]);
      await refusedLikeAnUnknownPath('/trash/confirm', token, null);
      expect(isTrashed(OWNED_ID)).toBe(false);
    });
  });

  describe('restore', () => {
    it('of a photograph this browser did not add is the plain 404', async () => {
      await adminTrash(LIVE_ID);
      await refusedLikeAnUnknownPath('/restore', { photoIds: [LIVE_ID] });
      expect(isTrashed(LIVE_ID)).toBe(true);
    });

    it('without a token is the plain 404', async () => {
      await refusedLikeAnUnknownPath('/restore', { photoIds: [TRASHED_ID] }, null);
      expect(isTrashed(TRASHED_ID)).toBe(true);
    });

    it('puts back an owned photograph, including one the administrator trashed', async () => {
      await adminTrash(OWNED_ID, LIVE_ID);

      const response = await handlerFor('display')(
        gated('display', 'POST', '/restore', { photoIds: [OWNED_ID, LIVE_ID] }),
      );
      expect(await response.json()).toEqual({ restored: [OWNED_ID], count: 1 });
      expect(isTrashed(OWNED_ID)).toBe(false);
      expect(isTrashed(LIVE_ID)).toBe(true);
    });
  });

  describe('listing and count', () => {
    beforeEach(async () => {
      // Something in the trash this browser did not add.
      await adminTrash(LIVE_ID);
    });

    async function listed(mode: AccessMode, token: string | null) {
      const handler = handlerFor(mode);
      const listing = await handler(gated(mode, 'GET', '/trash', undefined, token));
      const count = await handler(gated(mode, 'GET', '/trash/count', undefined, token));
      const { items } = (await listing.json()) as {
        items: { photo: { id: string } }[];
      };
      return {
        ids: items.map((item) => item.photo.id).sort(),
        count: ((await count.json()) as { count: number }).count,
      };
    }

    it('include only the photographs this browser added', async () => {
      expect(await listed('display', FIXTURE_UPLOADER_TOKEN)).toEqual({
        ids: [TRASHED_ID, OTHER_TRASHED_ID].sort(),
        count: 2,
      });
    });

    it('are empty without a token, rather than refused', async () => {
      expect(await listed('display', null)).toEqual({ ids: [], count: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// The family edits only what it added (read-first-photo-view.md #24)
// ---------------------------------------------------------------------------

describe('an edit', () => {
  const captionOf = (id: string) => catalogInStore().photos[id]!.caption;
  const auditCount = async () => (await store.list(R2_KEYS.auditPrefix)).length;

  it('in display mode, of a photograph this browser added, is stored and audited as display-api', async () => {
    const response = await handlerFor('display')(
      gated('display', 'POST', '/edit', { photoId: OWNED_ID, caption: 'Edited here' }),
    );
    expect(response.status).toBe(200);
    expect(captionOf(OWNED_ID)).toBe('Edited here');
    const listed = await store.list(R2_KEYS.auditPrefix);
    expect(listed.map(({ key }) => store.readJson<AuditEvent>(key))).toEqual([
      expect.objectContaining({ action: 'metadata-change', via: 'display-api' }),
    ]);
  });

  it.each([
    ['added by nobody', LIVE_ID, { caption: 'Not mine' }, FIXTURE_UPLOADER_TOKEN],
    [
      'added by nobody, with an invalid date',
      LIVE_ID,
      { date: 'not a date' },
      FIXTURE_UPLOADER_TOKEN,
    ],
    ['added here, with no token', OWNED_ID, { caption: 'No token' }, null],
    [
      'added here, but trashed',
      TRASHED_ID,
      { caption: 'Trashed' },
      FIXTURE_UPLOADER_TOKEN,
    ],
    [
      'that does not exist',
      'd'.repeat(32),
      { caption: 'Nobody' },
      FIXTURE_UPLOADER_TOKEN,
    ],
    ['with a malformed ID', 'not-an-id', { caption: 'Nobody' }, FIXTURE_UPLOADER_TOKEN],
  ] as const)(
    'in display mode, of a photograph %s, is the plain 404 and changes nothing',
    async (_name, photoId, fields, token) => {
      const before = catalogInStore();
      await refusedLikeAnUnknownPath('/edit', { photoId, ...fields }, token);
      expect(catalogInStore()).toEqual(before);
      expect(await auditCount()).toBe(0);
    },
  );

  it('in display mode, of a photograph added from another browser, is the plain 404', async () => {
    setUploaderHash(OWNED_ID, 'f'.repeat(64));
    await refusedLikeAnUnknownPath('/edit', { photoId: OWNED_ID, caption: 'Theirs' });
    expect(captionOf(OWNED_ID)).toBe('First rocket up.');
  });

  it('in display mode, re-checks ownership when a conflicting write forces a retry', async () => {
    store.onBeforeConditionalWrite = () => {
      store.onBeforeConditionalWrite = null;
      setUploaderHash(OWNED_ID, 'f'.repeat(64));
    };

    const response = await handlerFor('display')(
      gated('display', 'POST', '/edit', { photoId: OWNED_ID, caption: 'Too late' }),
    );
    expect(response.status).toBe(404);
    expect(captionOf(OWNED_ID)).toBe('First rocket up.');
    expect(await auditCount()).toBe(0);
  });

  it('in admin mode, of a photograph nobody added, is stored as before', async () => {
    const response = await handlerFor('admin')(
      gated(
        'admin',
        'POST',
        '/edit',
        { photoId: LIVE_ID, caption: 'By the admin' },
        null,
      ),
    );
    expect(response.status).toBe(200);
    expect(captionOf(LIVE_ID)).toBe('By the admin');
  });

  it('in admin mode, still explains an invalid date', async () => {
    const response = await handlerFor('admin')(
      gated('admin', 'POST', '/edit', { photoId: LIVE_ID, date: 'not a date' }, null),
    );
    expect(response.status).toBe(400);
  });
});

describe('in admin mode, nothing about the trash changed', () => {
  it('previews any photograph and any selection kind', async () => {
    const admin = handlerFor('admin');
    const byId = await admin(
      gated('admin', 'POST', '/trash/preview', previewOf([LIVE_ID])),
    );
    expect(await byId.json()).toMatchObject({ photoIds: [LIVE_ID] });

    const byDay = await admin(
      gated('admin', 'POST', '/trash/preview', {
        selection: { kind: 'day', year: 2026, month: 7, day: 4 },
      }),
    );
    expect(await byDay.json()).toMatchObject({ count: 3 });
  });

  it('trashes and restores a photograph another browser added', async () => {
    setUploaderHash(OWNED_ID, 'f'.repeat(64));
    await adminTrash(OWNED_ID, LIVE_ID);

    const response = await handlerFor('admin')(
      gated('admin', 'POST', '/restore', { photoIds: [OWNED_ID, LIVE_ID] }),
    );
    expect(await response.json()).toEqual({ restored: [OWNED_ID, LIVE_ID], count: 2 });
  });

  it('lists and counts every trashed photograph, with or without a token', async () => {
    await adminTrash(LIVE_ID);
    for (const token of [FIXTURE_UPLOADER_TOKEN, null]) {
      const admin = handlerFor('admin');
      const count = await admin(
        gated('admin', 'GET', '/trash/count', undefined, token),
      );
      expect(await count.json()).toEqual({ count: 3 });
      const listing = await admin(gated('admin', 'GET', '/trash', undefined, token));
      expect(((await listing.json()) as { items: unknown[] }).items).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Permanent deletion (family-own-trash.md 15)
// ---------------------------------------------------------------------------

describe('permanent deletion', () => {
  const objectsOf = (id: string) =>
    RENDITIONS.map((rendition) => photoObjectKey(id, rendition));

  beforeEach(() => {
    for (const id of [TRASHED_ID, OTHER_TRASHED_ID, LIVE_ID, OWNED_ID]) {
      for (const key of objectsOf(id)) store.seed(key, new Uint8Array([1]));
    }
  });

  async function purgePreview(
    mode: AccessMode,
    body: unknown,
    token: string | null = FIXTURE_UPLOADER_TOKEN,
  ) {
    return handlerFor(mode)(
      gated(mode, 'POST', '/permanent-delete/preview', body, token),
    );
  }

  async function purgeConfirm(
    mode: AccessMode,
    token: unknown,
    uploader: string | null = FIXTURE_UPLOADER_TOKEN,
  ) {
    return handlerFor(mode)(
      gated(mode, 'POST', '/permanent-delete/confirm', token, uploader),
    );
  }

  const isGone = (id: string) =>
    catalogInStore().photos[id] === undefined &&
    objectsOf(id).every((key) => !store.has(key));

  describe('in display mode', () => {
    it('removes a trashed photograph this browser added, record and bytes, as display-api', async () => {
      const preview = await purgePreview('display', previewOf([TRASHED_ID]));
      expect(preview.status).toBe(200);

      const confirm = await purgeConfirm('display', await preview.json());
      expect(await confirm.json()).toEqual({ deleted: [TRASHED_ID], count: 1 });
      expect(isGone(TRASHED_ID)).toBe(true);
      expect(isGone(OTHER_TRASHED_ID)).toBe(false);

      const listed = await store.list(R2_KEYS.auditPrefix);
      const events = listed.map(({ key }) => store.readJson<AuditEvent>(key)!);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'permanent-delete',
          via: 'display-api',
          photoIds: [TRASHED_ID],
        }),
      ]);
    });

    it('of a trashed photograph this browser did not add is the plain 404', async () => {
      await adminTrash(LIVE_ID);
      await refusedLikeAnUnknownPath('/permanent-delete/preview', previewOf([LIVE_ID]));
      expect(isGone(LIVE_ID)).toBe(false);
    });

    it('of a photograph this browser added that is not in the trash is the plain 404', async () => {
      await refusedLikeAnUnknownPath(
        '/permanent-delete/preview',
        previewOf([OWNED_ID]),
      );
      expect(isGone(OWNED_ID)).toBe(false);
    });

    it('without a token is the plain 404, preview and confirm alike', async () => {
      await refusedLikeAnUnknownPath(
        '/permanent-delete/preview',
        previewOf([TRASHED_ID]),
        null,
      );
      const preview = await purgePreview('display', previewOf([TRASHED_ID]));
      await refusedLikeAnUnknownPath(
        '/permanent-delete/confirm',
        await preview.json(),
        null,
      );
      expect(isGone(TRASHED_ID)).toBe(false);
    });

    it('of anything but an explicit list is the plain 404', async () => {
      await refusedLikeAnUnknownPath('/permanent-delete/preview', {
        selection: { kind: 'day', year: 2026, month: 7, day: 4 },
      });
    });

    it('cut to what this browser added when the list names both', async () => {
      await adminTrash(LIVE_ID);
      const preview = await purgePreview('display', previewOf([TRASHED_ID, LIVE_ID]));
      expect(await preview.json()).toMatchObject({ photoIds: [TRASHED_ID], count: 1 });
    });

    it('deletes nothing once the photograph has stopped being this browser’s', async () => {
      const preview = await purgePreview('display', previewOf([TRASHED_ID]));
      setUploaderHash(TRASHED_ID, 'f'.repeat(64));

      const confirm = await purgeConfirm('display', await preview.json());
      expect(await confirm.json()).toEqual({ deleted: [], count: 0 });
      expect(isGone(TRASHED_ID)).toBe(false);
    });
  });

  describe('in admin mode, unchanged', () => {
    it('removes any trashed photograph, whoever added it', async () => {
      await adminTrash(LIVE_ID);
      const preview = await purgePreview(
        'admin',
        previewOf([LIVE_ID, TRASHED_ID]),
        null,
      );
      const confirm = await purgeConfirm('admin', await preview.json(), null);
      expect(await confirm.json()).toEqual({
        deleted: [LIVE_ID, TRASHED_ID],
        count: 2,
      });
      expect(isGone(LIVE_ID)).toBe(true);
    });

    it('still explains a refused group selection, rather than hiding it', async () => {
      const response = await purgePreview(
        'admin',
        { selection: { kind: 'day', year: 2026, month: 7, day: 4 } },
        null,
      );
      expect(response.status).toBe(400);
    });
  });
});
