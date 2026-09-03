import { describe, it, expect } from 'vitest';
import { routeRequest, secureEquals } from '../../netlify/lib/routing.ts';
import type { GateConfig } from '../../netlify/lib/routing.ts';

const CONFIG: GateConfig = {
  displayPath: 'd15p1ay5ecret0000',
  adminPath: 'adm1n5ecret000000',
};

const displayUrl = (rest = '') => `/${CONFIG.displayPath}${rest}`;
const adminUrl = (rest = '') => `/${CONFIG.adminPath}${rest}`;

describe('secureEquals', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(secureEquals('abc', 'abc')).toBe(true);
    expect(secureEquals('abc', 'abd')).toBe(false);
    expect(secureEquals('abc', 'ab')).toBe(false);
    expect(secureEquals('', '')).toBe(true);
    expect(secureEquals('abc', '')).toBe(false);
  });

  it('does not treat a prefix as a match', () => {
    expect(secureEquals('secret', 'secretlonger')).toBe(false);
    expect(secureEquals('secretlonger', 'secret')).toBe(false);
  });
});

describe('robots.txt', () => {
  it('is the one thing reachable outside a secret path', () => {
    expect(routeRequest('/robots.txt', CONFIG)).toEqual({ kind: 'robots' });
  });

  it('is served even when the gate is misconfigured', () => {
    expect(routeRequest('/robots.txt', { displayPath: '', adminPath: '' })).toEqual({
      kind: 'robots',
    });
  });
});

describe('paths outside both secrets', () => {
  it('404s the root and common probes', () => {
    for (const path of [
      '/',
      '/index.html',
      '/admin',
      '/login',
      '/photos',
      '/assets/index.js',
      '/.env',
      '/.git/config',
      '/favicon.ico',
      '/sitemap.xml',
    ]) {
      expect(routeRequest(path, CONFIG), path).toEqual({ kind: 'not-found' });
    }
  });

  it('404s direct hits on the Netlify function endpoints', () => {
    // Without this the opaque-path model would be decorative: anyone could
    // call the admin function straight from the browser.
    for (const path of [
      '/.netlify/functions/admin',
      '/.netlify/functions/display',
      '/.netlify/functions/admin/commit',
      '/.netlify/edge-functions/gate',
    ]) {
      expect(routeRequest(path, CONFIG), path).toEqual({ kind: 'not-found' });
    }
  });

  it('404s a path that merely resembles a secret', () => {
    for (const path of [
      `/${CONFIG.displayPath}x`,
      `/x${CONFIG.displayPath}`,
      `/${CONFIG.displayPath.slice(0, -1)}`,
      `/${CONFIG.displayPath.toUpperCase()}`,
      `/${CONFIG.adminPath}x/api/photos`,
    ]) {
      expect(routeRequest(path, CONFIG), path).toEqual({ kind: 'not-found' });
    }
  });

  it('404s a nested path whose first segment is not a secret', () => {
    expect(routeRequest(`/public/${CONFIG.adminPath}`, CONFIG)).toEqual({
      kind: 'not-found',
    });
  });
});

describe('display routes', () => {
  it('serves the app shell at the base', () => {
    for (const path of [displayUrl(), displayUrl('/')]) {
      expect(routeRequest(path, CONFIG), path).toEqual({
        kind: 'app',
        mode: 'display',
        indexPath: displayUrl('/index.html'),
      });
    }
  });

  it('serves the app shell for client-side routes', () => {
    for (const path of [
      displayUrl('/2026'),
      displayUrl('/2026/08'),
      displayUrl('/2026/08/02'),
      displayUrl('/undated'),
      displayUrl('/photo/abc123'),
    ]) {
      const decision = routeRequest(path, CONFIG);
      expect(decision.kind, path).toBe('app');
      expect(decision).toMatchObject({ mode: 'display' });
    }
  });

  it('passes built assets through to static hosting', () => {
    for (const path of [
      displayUrl('/assets/index-abc123.js'),
      displayUrl('/assets/index-abc123.css'),
      displayUrl('/index.html'),
    ]) {
      expect(routeRequest(path, CONFIG), path).toEqual({
        kind: 'asset',
        mode: 'display',
      });
    }
  });

  it('routes the API to the display function, never the admin one', () => {
    expect(routeRequest(displayUrl('/api/timeline'), CONFIG)).toEqual({
      kind: 'api',
      mode: 'display',
      functionPath: '/.netlify/functions/display',
      subPath: '/timeline',
    });
  });
});

describe('admin routes', () => {
  it('routes the API to the admin function', () => {
    expect(routeRequest(adminUrl('/api/commit'), CONFIG)).toEqual({
      kind: 'api',
      mode: 'admin',
      functionPath: '/.netlify/functions/admin',
      subPath: '/commit',
    });
  });

  it('serves its own app shell and assets', () => {
    expect(routeRequest(adminUrl('/trash'), CONFIG)).toEqual({
      kind: 'app',
      mode: 'admin',
      indexPath: adminUrl('/index.html'),
    });
    expect(routeRequest(adminUrl('/assets/index-x.js'), CONFIG)).toEqual({
      kind: 'asset',
      mode: 'admin',
    });
  });

  it('handles a bare /api with no subpath', () => {
    expect(routeRequest(adminUrl('/api'), CONFIG)).toMatchObject({
      kind: 'api',
      subPath: '/',
    });
  });
});

describe('mode isolation', () => {
  it('never assigns admin mode to a request that stays under the display path', () => {
    for (const path of [
      displayUrl('/api/commit'),
      displayUrl('/api/trash'),
      displayUrl('/api/photos/abc/permanent-delete'),
      // Naming the admin secret *below* the display base does not escape it.
      displayUrl(`/${CONFIG.adminPath}`),
      displayUrl(`/${CONFIG.adminPath}/api/commit`),
      displayUrl(`/api/${CONFIG.adminPath}`),
    ]) {
      const decision = routeRequest(new URL(path, 'https://x').pathname, CONFIG);
      expect(decision.kind, path).not.toBe('not-found');
      if ('mode' in decision) expect(decision.mode, path).toBe('display');
    }
  });

  it('sends every display API call to the display function', () => {
    // The admin function is unreachable from the display base: the function
    // name is derived from the mode, which is derived from the matched secret.
    const decision = routeRequest(displayUrl('/api/commit'), CONFIG);
    expect(decision).toMatchObject({
      functionPath: '/.netlify/functions/display',
    });
  });

  it('resolves traversal before matching, so ".." cannot cross modes', () => {
    // URL parsing collapses dot segments, which is why routeRequest is
    // documented to take an already-parsed pathname.
    const raw = displayUrl(`/../${CONFIG.adminPath}/api/commit`);
    const pathname = new URL(raw, 'https://example.test').pathname;

    expect(pathname).toBe(adminUrl('/api/commit'));
    expect(routeRequest(pathname, CONFIG)).toMatchObject({ mode: 'admin' });
  });
});

describe('misconfiguration fails closed', () => {
  const cases: [string, GateConfig][] = [
    ['both paths empty', { displayPath: '', adminPath: '' }],
    ['display path empty', { displayPath: '', adminPath: 'admin1' }],
    ['admin path empty', { displayPath: 'display1', adminPath: '' }],
    ['paths identical', { displayPath: 'same1', adminPath: 'same1' }],
    ['path contains a slash', { displayPath: 'a/b', adminPath: 'admin1' }],
  ];

  for (const [name, config] of cases) {
    it(`404s everything when ${name}`, () => {
      for (const path of ['/', '/anything', '/same1', '/display1', '/admin1']) {
        expect(routeRequest(path, config), `${name}: ${path}`).toEqual({
          kind: 'not-found',
        });
      }
    });
  }

  it('still serves robots.txt so the disallow rule survives a misconfiguration', () => {
    expect(
      routeRequest('/robots.txt', { displayPath: 'same', adminPath: 'same' }),
    ).toEqual({ kind: 'robots' });
  });
});
