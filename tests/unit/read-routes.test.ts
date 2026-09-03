import { describe, expect, it } from 'vitest';
import { readRoute } from '../../netlify/functions/lib/read-routes.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * The projections shared by the display and admin APIs.
 *
 * These shipped in `display.ts` alone, so the admin app — which reads through
 * the very same routes — 404ed on its first request in production while
 * working locally, because the fixture server falls through to its display
 * handler for unrecognised admin GETs. The contract worth pinning is the
 * two-valued return: `null` means "not a read route, keep looking", and a 404
 * response means "a read route, but no such photo".
 */

const catalog = fixtureCatalog();

describe('readRoute', () => {
  it('returns null for a path that is not a read route', () => {
    for (const path of ['/trash', '/export', '/begin-batch', '/', '/photos']) {
      expect(readRoute(catalog, path)).toBeNull();
    }
  });

  it('serves the whole timeline', async () => {
    const response = readRoute(catalog, '/timeline');
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      years: { months: { days: { photos: unknown[] }[] }[] }[];
      undated: { photos: unknown[] };
    };
    expect(body.years.length).toBeGreaterThan(0);
    expect(body.years[0]!.months[0]!.days[0]!.photos.length).toBeGreaterThan(0);
    expect(body.undated.photos.length).toBeGreaterThan(0);
  });

  it('serves a live photo, and 404s an unknown one', () => {
    const id = FIXTURE_PHOTO_IDS['beach-early']!;
    expect(readRoute(catalog, `/photo/${id}`)?.status).toBe(200);
    expect(readRoute(catalog, `/photo/${'0'.repeat(32)}`)?.status).toBe(404);
  });

  it('404s a trashed photo rather than exposing it', () => {
    const id = FIXTURE_PHOTO_IDS['deleted-0']!;
    expect(readRoute(catalog, `/photo/${id}`)?.status).toBe(404);
  });

  it('does not treat a malformed photo id as a read route', () => {
    expect(readRoute(catalog, '/photo/not-a-valid-id')).toBeNull();
  });

  /**
   * The level-by-level projections are gone: both apps are one scrolling
   * page, so nothing asks for a hierarchy, a day, or the undated group any
   * more. They must be `null` — not a read route at all — so a stale client
   * asking for one gets the same plain 404 as any other unknown path.
   */
  it('no longer recognises the hierarchy, day, or undated routes', () => {
    for (const path of ['/hierarchy', '/undated', '/day/2026/08/02']) {
      expect(readRoute(catalog, path), path).toBeNull();
    }
  });
});
