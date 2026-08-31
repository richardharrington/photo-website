/**
 * Shared HTTP plumbing for the two Netlify Functions.
 *
 * Both functions verify independently that a request arrived through the Edge
 * Function gate. Netlify Functions are also addressable directly at
 * `/.netlify/functions/<name>`; the gate 404s that path, but a function that
 * trusted the gate's routing alone would be one routing change away from
 * accepting `x-photo-access-mode: admin` from anybody. So the check is here,
 * at the thing being protected.
 */

import { baseSecurityHeaders } from '../../../src/shared/headers.ts';

export const ACCESS_MODE_HEADER = 'x-photo-access-mode';
export const INTERNAL_SECRET_HEADER = 'x-photo-gate-secret';

export type AccessMode = 'display' | 'admin';

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function timingSafeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Every refusal is the same plain 404: wrong mode, missing gate marker,
 * unknown route, trashed photo, unknown photo. Nothing distinguishes them, so
 * nothing can be probed.
 */
export function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      ...baseSecurityHeaders(),
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseSecurityHeaders(),
      'content-type': 'application/json; charset=utf-8',
      // API responses are per-request state; never let one be cached.
      'cache-control': 'no-store',
    },
  });
}

/** A client mistake worth explaining, unlike an authorization failure. */
export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

export function serverError(message = 'Something went wrong.'): Response {
  return json({ error: message }, 500);
}

/**
 * Confirm the request was gated, and that it was gated as `expected`.
 *
 * Returns null when the request may proceed, or the response to send.
 */
export function checkAccess(request: Request, expected: AccessMode): Response | null {
  const secret = process.env.INTERNAL_GATE_SECRET ?? '';
  if (secret === '') {
    // Fail closed. Without the shared marker this function cannot tell a gated
    // request from a direct one, and guessing would be the wrong way to err.
    console.error('INTERNAL_GATE_SECRET is not set; refusing every request.');
    return notFound();
  }

  const presented = request.headers.get(INTERNAL_SECRET_HEADER) ?? '';
  if (!timingSafeEquals(presented, secret)) return notFound();

  // The mode is set by the gate from which secret path was used. It is only
  // trustworthy because the marker above proves the gate set it.
  if (request.headers.get(ACCESS_MODE_HEADER) !== expected) return notFound();

  return null;
}

/** The path below `/.netlify/functions/<name>`, always starting with `/`. */
export function subPath(request: Request, functionName: string): string {
  const { pathname } = new URL(request.url);
  const prefix = `/.netlify/functions/${functionName}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  return rest === '' ? '/' : rest;
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
