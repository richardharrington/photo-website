/**
 * The opaque-path gate. Runs before static content and before any function.
 *
 * Everything the site exposes is reached through here: it decides whether a
 * request is under the display secret path, the admin secret path, or neither,
 * and it is the only thing that assigns an access mode. A browser never gets
 * to say which mode it wants.
 */

import {
  ROBOTS_TXT,
  baseSecurityHeaders,
  contentSecurityPolicy,
  originOf,
  withHeaders,
} from '../../src/shared/headers.ts';
import { routeRequest, secureEquals } from '../lib/routing.ts';
import type { AccessMode, GateConfig } from '../lib/routing.ts';

/**
 * Header carrying the access mode from the gate to the function. The function
 * must not trust it on its own — see INTERNAL_SECRET_HEADER.
 */
export const ACCESS_MODE_HEADER = 'x-photo-access-mode';

/**
 * Proof that a request reached the function *through* this gate.
 *
 * Netlify Functions are also addressable at `/.netlify/functions/<name>`. This
 * gate returns 404 for that path, but the function must not depend on the
 * gate's routing alone: without an unforgeable marker, anyone could call the
 * admin function directly and simply assert `x-photo-access-mode: admin`,
 * which would defeat the entire opaque-path model. The functions verify this
 * header independently.
 *
 * This is a different link from the Netlify-to-Worker calls that decisions.md
 * #15 removed a shared key for; no such calls exist, and this is not one.
 */
export const INTERNAL_SECRET_HEADER = 'x-photo-gate-secret';

/** Minimal shape of the Netlify Edge Function context that this gate uses. */
interface EdgeContext {
  next(): Promise<Response>;
  rewrite(url: URL | string): Promise<Response>;
}

declare const Netlify: { env: { get(name: string): string | undefined } };

function env(name: string): string {
  return Netlify.env.get(name) ?? '';
}

function plainNotFound(): Response {
  // Identical for an unknown path, a wrong secret, a trashed photo, and a
  // disabled route: the response must not reveal that anything exists.
  return new Response('Not Found', {
    status: 404,
    headers: { ...baseSecurityHeaders(), 'content-type': 'text/plain; charset=utf-8' },
  });
}

function robotsResponse(): Response {
  return new Response(ROBOTS_TXT, {
    status: 200,
    headers: { ...baseSecurityHeaders(), 'content-type': 'text/plain; charset=utf-8' },
  });
}

function htmlHeaders(mode: AccessMode): Record<string, string> {
  const workerOrigin = originOf(env('WORKER_BASE_URL')) ?? "'none'";
  const isAdmin = mode === 'admin';
  return {
    ...baseSecurityHeaders(),
    'Content-Security-Policy': contentSecurityPolicy({
      workerOrigin,
      // Only the admin app uploads, previews local files, or runs WASM codecs.
      r2UploadOrigin: isAdmin ? originOf(env('R2_S3_ENDPOINT')) : null,
      allowWasm: isAdmin,
      allowLocalImageSources: isAdmin,
    }),
    // The HTML shell is tiny and must never be stale after a deploy; the
    // fingerprinted assets it references carry the long cache lifetimes.
    'Cache-Control': 'no-cache',
  };
}

export default async function gate(
  request: Request,
  context: EdgeContext,
): Promise<Response> {
  const url = new URL(request.url);
  const gateSecret = env('INTERNAL_GATE_SECRET');

  // Our own rewrite, arriving back at the gate. Netlify does not normally
  // re-run edge functions on a rewrite, but if it ever does, the request is
  // recognizable by a marker no outside caller can produce.
  if (url.pathname.startsWith('/.netlify/functions/')) {
    const presented = request.headers.get(INTERNAL_SECRET_HEADER) ?? '';
    if (gateSecret !== '' && secureEquals(presented, gateSecret)) {
      return context.next();
    }
    return plainNotFound();
  }

  const config: GateConfig = {
    displayPath: env('DISPLAY_PATH'),
    adminPath: env('ADMIN_PATH'),
  };

  const decision = routeRequest(url.pathname, config);

  switch (decision.kind) {
    case 'robots':
      return robotsResponse();

    case 'not-found':
      return plainNotFound();

    case 'asset': {
      const response = await context.next();
      if (response.status === 404) return plainNotFound();
      return withHeaders(response, baseSecurityHeaders());
    }

    case 'app': {
      const target = new URL(url);
      target.pathname = decision.indexPath;
      const response = await context.rewrite(target);
      if (response.status === 404) return plainNotFound();
      return withHeaders(response, htmlHeaders(decision.mode));
    }

    case 'api': {
      if (gateSecret === '') {
        // Without the shared marker the function cannot tell a gated request
        // from a direct one, so refuse rather than route insecurely.
        console.error('INTERNAL_GATE_SECRET is not set; refusing to route the API.');
        return plainNotFound();
      }

      const target = new URL(url);
      target.pathname = decision.functionPath + trimTrailingSlash(decision.subPath);

      // The mode comes from which secret path was used, never from the client.
      request.headers.set(ACCESS_MODE_HEADER, decision.mode);
      request.headers.set(INTERNAL_SECRET_HEADER, gateSecret);

      const response = await context.rewrite(target);
      return withHeaders(response, baseSecurityHeaders());
    }
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export const config = { path: '/*' };
