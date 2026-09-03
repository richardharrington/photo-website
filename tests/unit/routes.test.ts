import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../src/shared/ui/routes.ts';

/**
 * One parser, two apps.
 *
 * The routes both apps share are parsed identically; the only difference is
 * the list of extra top-level pages the caller declares. That is what keeps
 * `/trash` out of the display bundle's vocabulary without a second parser to
 * keep in step — the viewer declares none, so under its base `/trash` is a
 * mistyped URL like any other.
 */

const BASE = '/secret-base';
const ADMIN = ['trash'] as const;

describe('parseRoute', () => {
  it('parses the routes both apps share', () => {
    expect(parseRoute(`${BASE}/`, BASE)).toEqual({ kind: 'home' });
    expect(parseRoute(BASE, BASE)).toEqual({ kind: 'home' });
    expect(parseRoute(`${BASE}/2026`, BASE)).toEqual({ kind: 'year', year: 2026 });
    expect(parseRoute(`${BASE}/2026/03`, BASE)).toEqual({
      kind: 'month',
      year: 2026,
      month: 3,
    });
    expect(parseRoute(`${BASE}/2026/03/01`, BASE)).toEqual({
      kind: 'day',
      year: 2026,
      month: 3,
      day: 1,
    });
    expect(parseRoute(`${BASE}/undated`, BASE)).toEqual({ kind: 'undated' });

    const id = 'a1b2c3d4'.repeat(4);
    expect(parseRoute(`${BASE}/photo/${id}`, BASE)).toEqual({ kind: 'photo', id });
  });

  it('refuses anything outside the app base', () => {
    expect(parseRoute('/somewhere-else/2026', BASE)).toEqual({ kind: 'not-found' });
  });

  it('404s a malformed route rather than coercing it', () => {
    for (const path of [
      `${BASE}/2026/13`,
      `${BASE}/2026/02/30`,
      `${BASE}/2026/03/01/extra`,
      `${BASE}/photo/not-a-valid-id`,
      `${BASE}/photo`,
      `${BASE}/undated/extra`,
    ]) {
      expect(parseRoute(path, BASE), path).toEqual({ kind: 'not-found' });
    }
  });

  it('parses /trash only for the app that declares it', () => {
    expect(parseRoute(`${BASE}/trash`, BASE, ADMIN)).toEqual({
      kind: 'page',
      name: 'trash',
    });
    // The viewer declares no extra pages, so this is its own 404.
    expect(parseRoute(`${BASE}/trash`, BASE)).toEqual({ kind: 'not-found' });
  });

  it('accepts an extra page only on its own', () => {
    expect(parseRoute(`${BASE}/trash/extra`, BASE, ADMIN)).toEqual({
      kind: 'not-found',
    });
  });

  it('does not let an extra page shadow a shared route', () => {
    // Checked last, so an app cannot claim a name the shared parser owns.
    expect(parseRoute(`${BASE}/undated`, BASE, ['undated'])).toEqual({
      kind: 'undated',
    });
    const id = 'f'.repeat(32);
    expect(parseRoute(`${BASE}/photo/${id}`, BASE, ['photo'])).toEqual({
      kind: 'photo',
      id,
    });
  });
});
