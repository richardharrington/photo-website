/**
 * Security headers, shared by the Edge Function, the Netlify Functions, and
 * the Cloudflare Worker so all three emit the same directives.
 *
 * These discourage indexing and limit what a page may load. They are **not**
 * access control — the access model is the unguessable paths and capability
 * URLs described in design.md.
 */

export const ROBOTS_DIRECTIVE = 'noindex, nofollow, noarchive, nosnippet';

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** Applied to every response from every tier, including images and JSON. */
export function baseSecurityHeaders(): Record<string, string> {
  return {
    // Images and API responses cannot carry a robots meta tag, so the
    // directive has to travel as a header.
    'X-Robots-Tag': ROBOTS_DIRECTIVE,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export interface CspOptions {
  /** Origin of the Cloudflare asset Worker, e.g. `https://x.workers.dev`. */
  workerOrigin: string;
  /**
   * Origin the admin browser PUTs artifacts to. Admin app only: the display
   * app has no upload path and must not be allowed to reach R2 at all.
   */
  r2UploadOrigin?: string | null;
  /**
   * Admin only. The image pipeline compiles WebAssembly codecs, which needs
   * `'wasm-unsafe-eval'`. libheif-js and the jSquash codecs inline their
   * WebAssembly into the JS bundle, so no extra origin is needed alongside it
   * (implementation-plan.md, "Opaque route handling").
   */
  allowWasm?: boolean;
  /** Admin only: local file previews and pipeline output use blob:/data: URLs. */
  allowLocalImageSources?: boolean;
}

/**
 * Build the Content-Security-Policy for an HTML response.
 *
 * Note there is no `'unsafe-inline'` in `style-src`. React sets its `style`
 * prop through CSSOM rather than by writing a `style` attribute, so inline
 * style objects keep working under the strict policy.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const scriptSrc = ["'self'"];
  if (options.allowWasm) scriptSrc.push("'wasm-unsafe-eval'");

  const imgSrc = ["'self'", options.workerOrigin];
  if (options.allowLocalImageSources) imgSrc.push('blob:', 'data:');

  const connectSrc = ["'self'"];
  if (options.r2UploadOrigin) connectSrc.push(options.r2UploadOrigin);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    'style-src': ["'self'"],
    'img-src': imgSrc,
    'connect-src': connectSrc,
    'font-src': ["'self'"],
    // No third-party fonts, media, plugins, or embeds anywhere in the design.
    'media-src': ["'none'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'manifest-src': ["'none'"],
    // The pipeline may run in a worker; Vite emits blob: workers.
    'worker-src': ["'self'", 'blob:'],
    // Nothing may frame the site, rewrite its base URL, or post a form off-origin.
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** Origin of a URL string, or null if it cannot be parsed. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Copy a response and apply headers to it. Responses returned by the Netlify
 * Edge runtime can have immutable headers, so this rebuilds rather than
 * mutating in place.
 */
export function withHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    out.headers.set(name, value);
  }
  return out;
}
