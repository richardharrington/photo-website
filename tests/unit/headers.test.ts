import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ROBOTS_DIRECTIVE,
  ROBOTS_TXT,
  baseSecurityHeaders,
  contentSecurityPolicy,
  originOf,
  withHeaders,
} from '../../src/shared/headers.ts';

const WORKER = 'https://photo-assets.example.workers.dev';
const R2 = 'https://abc123.r2.cloudflarestorage.com';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name!, values];
    }),
  );
}

describe('baseSecurityHeaders', () => {
  it('carries the no-index directive as a header', () => {
    // Images and JSON cannot hold a robots meta tag, so every tier sends this.
    expect(baseSecurityHeaders()['X-Robots-Tag']).toBe(ROBOTS_DIRECTIVE);
    expect(ROBOTS_DIRECTIVE).toBe('noindex, nofollow, noarchive, nosnippet');
  });

  it('suppresses the referrer, so a secret path never leaks outbound', () => {
    expect(baseSecurityHeaders()['Referrer-Policy']).toBe('no-referrer');
  });

  it('blocks content-type sniffing', () => {
    expect(baseSecurityHeaders()['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('robots.txt', () => {
  it('disallows every crawler', () => {
    expect(ROBOTS_TXT).toContain('User-agent: *');
    expect(ROBOTS_TXT).toContain('Disallow: /');
  });

  it('matches the file checked into public/', () => {
    // The gate serves the text inline because the root otherwise 404s; this
    // keeps the checked-in copy from drifting away from what is served.
    expect(readFileSync('public/robots.txt', 'utf8')).toBe(ROBOTS_TXT);
  });
});

describe('contentSecurityPolicy', () => {
  const display = directives(contentSecurityPolicy({ workerOrigin: WORKER }));
  const admin = directives(
    contentSecurityPolicy({
      workerOrigin: WORKER,
      r2UploadOrigin: R2,
      allowWasm: true,
      allowLocalImageSources: true,
    }),
  );

  it('defaults to same-origin only', () => {
    expect(display.get('default-src')).toEqual(["'self'"]);
  });

  it('allows images from the site and the asset Worker', () => {
    expect(display.get('img-src')).toEqual(["'self'", WORKER]);
  });

  it('never allows inline or eval-based scripts in the display app', () => {
    expect(display.get('script-src')).toEqual(["'self'"]);
  });

  it('does not allow inline styles', () => {
    // React sets its style prop through CSSOM rather than by writing a style
    // attribute, so the strict policy costs nothing.
    expect(display.get('style-src')).toEqual(["'self'"]);
  });

  it('forbids framing, base rewriting, and off-origin form posts', () => {
    for (const name of ['frame-ancestors', 'base-uri', 'form-action']) {
      expect(display.get(name), name).toEqual(["'none'"]);
    }
  });

  it('forbids plugins, embedded frames, media, and manifests', () => {
    for (const name of ['object-src', 'frame-src', 'media-src', 'manifest-src']) {
      expect(display.get(name), name).toEqual(["'none'"]);
    }
  });

  it('gives the display app no route to R2 at all', () => {
    // The viewer never uploads, so R2 has no business in its connect-src.
    expect(display.get('connect-src')).toEqual(["'self'"]);
    expect(contentSecurityPolicy({ workerOrigin: WORKER })).not.toContain(R2);
  });

  it('allows WebAssembly only in the admin app', () => {
    expect(admin.get('script-src')).toContain("'wasm-unsafe-eval'");
    expect(display.get('script-src')).not.toContain("'wasm-unsafe-eval'");
  });

  it('allows the admin app to reach R2 and to preview local files', () => {
    expect(admin.get('connect-src')).toEqual(["'self'", R2]);
    expect(admin.get('img-src')).toEqual(["'self'", WORKER, 'blob:', 'data:']);
  });

  it('needs no separate WASM origin, since the codecs are inlined', () => {
    const csp = contentSecurityPolicy({
      workerOrigin: WORKER,
      r2UploadOrigin: R2,
      allowWasm: true,
    });

    expect(csp).not.toContain('.wasm');
    expect(directives(csp).get('default-src')).toEqual(["'self'"]);
  });

  it('omits an unknown R2 origin rather than widening the policy', () => {
    const csp = contentSecurityPolicy({
      workerOrigin: WORKER,
      r2UploadOrigin: null,
      allowWasm: true,
    });

    expect(directives(csp).get('connect-src')).toEqual(["'self'"]);
  });
});

describe('originOf', () => {
  it('reduces a URL to its origin', () => {
    expect(originOf('https://x.workers.dev/p/abc/thumb.webp')).toBe(
      'https://x.workers.dev',
    );
    expect(originOf('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('returns null rather than throwing on unusable input', () => {
    expect(originOf('')).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('withHeaders', () => {
  it('applies headers to a copy, leaving the original alone', () => {
    const original = new Response('body', {
      status: 201,
      headers: { 'content-type': 'text/plain' },
    });

    const result = withHeaders(original, baseSecurityHeaders());

    expect(result.status).toBe(201);
    expect(result.headers.get('content-type')).toBe('text/plain');
    expect(result.headers.get('X-Robots-Tag')).toBe(ROBOTS_DIRECTIVE);
    expect(original.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('overwrites a header the upstream response already set', () => {
    const original = new Response('body', {
      headers: { 'Referrer-Policy': 'origin-when-cross-origin' },
    });

    expect(
      withHeaders(original, baseSecurityHeaders()).headers.get('Referrer-Policy'),
    ).toBe('no-referrer');
  });
});
