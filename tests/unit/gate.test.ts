import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import gate, {
  ACCESS_MODE_HEADER,
  INTERNAL_SECRET_HEADER,
} from '../../netlify/edge-functions/gate.ts';
import { ROBOTS_DIRECTIVE } from '../../src/shared/headers.ts';

const DISPLAY_PATH = 'd15p1ay5ecret0000';
const ADMIN_PATH = 'adm1n5ecret000000';
const GATE_SECRET = 'gate-secret-value';

const ENV: Record<string, string> = {
  DISPLAY_PATH,
  ADMIN_PATH,
  INTERNAL_GATE_SECRET: GATE_SECRET,
  WORKER_BASE_URL: 'https://photo-assets.example.workers.dev',
  R2_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
};

/**
 * Stand-in for the Netlify Edge context. Records what the gate asked for so
 * tests can assert on the rewrite target and the headers the gate attached to
 * the outgoing request.
 */
function makeContext(
  upstream: () => Response = () => new Response('static', { status: 200 }),
) {
  const calls: { next: number; rewrites: string[] } = { next: 0, rewrites: [] };
  return {
    calls,
    context: {
      next: async () => {
        calls.next += 1;
        return upstream();
      },
      rewrite: async (url: URL | string) => {
        calls.rewrites.push(typeof url === 'string' ? url : url.pathname);
        return upstream();
      },
    },
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://photos.example.test${path}`, init);
}

let envOverrides: Record<string, string>;

beforeEach(() => {
  envOverrides = { ...ENV };
  (globalThis as Record<string, unknown>).Netlify = {
    env: { get: (name: string) => envOverrides[name] },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Netlify;
  vi.restoreAllMocks();
});

describe('robots.txt', () => {
  it('is served with a disallow rule and no-index headers', async () => {
    const { context } = makeContext();
    const response = await gate(request('/robots.txt'), context);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Disallow: /');
    expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS_DIRECTIVE);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('unknown paths', () => {
  it('returns a plain 404 that reveals no route information', async () => {
    for (const path of ['/', '/admin', '/index.html', '/.env']) {
      const { context, calls } = makeContext();
      const response = await gate(request(path), context);

      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(response.headers.get('content-type')).toContain('text/plain');
      // Nothing downstream is consulted, so nothing downstream can leak.
      expect(calls.next + calls.rewrites.length, path).toBe(0);
    }
  });

  it('still applies no-index headers to the 404', async () => {
    const { context } = makeContext();
    const response = await gate(request('/nope'), context);

    expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS_DIRECTIVE);
  });

  it('turns an upstream 404 on a missing asset into the same plain 404', async () => {
    const { context } = makeContext(() => new Response('nope', { status: 404 }));
    const response = await gate(request(`/${DISPLAY_PATH}/assets/missing.js`), context);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });
});

describe('app shell', () => {
  it('rewrites a client-side route to that app index.html', async () => {
    const { context, calls } = makeContext();
    const response = await gate(request(`/${DISPLAY_PATH}/2026/08/02`), context);

    expect(response.status).toBe(200);
    expect(calls.rewrites).toEqual([`/${DISPLAY_PATH}/index.html`]);
  });

  it('sends a strict CSP with the display app HTML', async () => {
    const { context } = makeContext();
    const response = await gate(request(`/${DISPLAY_PATH}/`), context);
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' https://photo-assets.example.workers.dev");
    expect(csp).not.toContain('wasm-unsafe-eval');
    expect(csp).not.toContain('r2.cloudflarestorage.com');
  });

  it('widens the CSP only for the admin app', async () => {
    const { context } = makeContext();
    const response = await gate(request(`/${ADMIN_PATH}/`), context);
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain('https://abc123.r2.cloudflarestorage.com');
  });

  it('keeps the HTML shell out of caches so a deploy takes effect', async () => {
    const { context } = makeContext();
    const response = await gate(request(`/${DISPLAY_PATH}/`), context);

    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });
});

describe('API routing', () => {
  it('rewrites to the function for the matched mode, stripping the prefix', async () => {
    const { context, calls } = makeContext();
    await gate(request(`/${ADMIN_PATH}/api/commit`), context);

    expect(calls.rewrites).toEqual(['/.netlify/functions/admin/commit']);
  });

  it('attaches the access mode and the gate marker to the request', async () => {
    const { context } = makeContext();
    const req = request(`/${ADMIN_PATH}/api/commit`);
    await gate(req, context);

    expect(req.headers.get(ACCESS_MODE_HEADER)).toBe('admin');
    expect(req.headers.get(INTERNAL_SECRET_HEADER)).toBe(GATE_SECRET);
  });

  it('overwrites an access mode the client tried to supply', async () => {
    // The mode must come from which secret path was used, never from a header
    // the browser controls.
    const { context } = makeContext();
    const req = request(`/${DISPLAY_PATH}/api/timeline`, {
      headers: {
        [ACCESS_MODE_HEADER]: 'admin',
        [INTERNAL_SECRET_HEADER]: 'guessed',
      },
    });

    await gate(req, context);

    expect(req.headers.get(ACCESS_MODE_HEADER)).toBe('display');
    expect(req.headers.get(INTERNAL_SECRET_HEADER)).toBe(GATE_SECRET);
  });

  it('refuses to route the API when the gate secret is unset', async () => {
    // Without the marker a function cannot tell a gated call from a direct
    // one, so the gate fails closed instead of routing insecurely.
    delete envOverrides.INTERNAL_GATE_SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { context, calls } = makeContext();
    const response = await gate(request(`/${ADMIN_PATH}/api/commit`), context);

    expect(response.status).toBe(404);
    expect(calls.rewrites).toEqual([]);
  });
});

describe('direct access to the Netlify function endpoints', () => {
  it('404s a request that did not come through the gate', async () => {
    for (const path of [
      '/.netlify/functions/admin',
      '/.netlify/functions/admin/commit',
      '/.netlify/functions/display',
    ]) {
      const { context, calls } = makeContext();
      const response = await gate(
        request(path, { headers: { [ACCESS_MODE_HEADER]: 'admin' } }),
        context,
      );

      expect(response.status, path).toBe(404);
      expect(calls.next, path).toBe(0);
    }
  });

  it('404s a request presenting a wrong gate secret', async () => {
    const { context } = makeContext();
    const response = await gate(
      request('/.netlify/functions/admin', {
        headers: { [INTERNAL_SECRET_HEADER]: 'not-the-secret' },
      }),
      context,
    );

    expect(response.status).toBe(404);
  });

  it('lets a genuinely gated request through if it re-enters the gate', async () => {
    // Netlify does not normally re-run edge functions on a rewrite. If it
    // ever does, the request carries a marker no outside caller can produce.
    const { context, calls } = makeContext();
    const response = await gate(
      request('/.netlify/functions/admin/commit', {
        headers: { [INTERNAL_SECRET_HEADER]: GATE_SECRET },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(calls.next).toBe(1);
  });

  it('404s even a correct-looking marker when no secret is configured', async () => {
    delete envOverrides.INTERNAL_GATE_SECRET;
    const { context } = makeContext();
    const response = await gate(
      request('/.netlify/functions/admin', {
        headers: { [INTERNAL_SECRET_HEADER]: '' },
      }),
      context,
    );

    expect(response.status).toBe(404);
  });
});

describe('static assets', () => {
  it('passes them through and adds the no-index headers', async () => {
    const { context, calls } = makeContext(
      () =>
        new Response('body', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        }),
    );

    const response = await gate(
      request(`/${DISPLAY_PATH}/assets/index-abc.js`),
      context,
    );

    expect(calls.next).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript');
    expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS_DIRECTIVE);
  });
});
