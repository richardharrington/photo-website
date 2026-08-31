/**
 * Local development fake: the display API and the asset Worker, in-process.
 *
 * No Netlify or Cloudflare account is required to run and exercise the
 * viewer. This serves the *same* projection functions the real Netlify
 * function will call, so what is exercised locally is the real contract and
 * not a hand-written imitation of it. Only the storage and the image bytes
 * are fake.
 *
 * Development only. It is mounted by the Vite dev server and is never part of
 * a production build.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtureCatalog } from '../fixtures/catalog.ts';
import {
  dayResponse,
  hierarchyResponse,
  photoResponse,
  undatedResponse,
} from '../src/shared/display-api.ts';
import { getLivePhoto } from '../src/shared/catalog.ts';
import { RENDITION_SPECS, SIGNED_URL_TTL_SECONDS } from '../src/shared/constants.ts';
import type { Rendition } from '../src/shared/constants.ts';
import { baseSecurityHeaders } from '../src/shared/headers.ts';

const catalog = fixtureCatalog();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    ...baseSecurityHeaders(),
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Not Found');
}

/**
 * A placeholder image standing in for a real derivative.
 *
 * SVG rather than a generated WebP: the point is to exercise layout, lazy
 * loading, and aspect-ratio reservation, and encoding real bytes here would
 * add a codec dependency to the dev server for no benefit. The label makes it
 * obvious at a glance which rendition the browser actually requested.
 */
function placeholderSvg(
  width: number,
  height: number,
  label: string,
  hue: number,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="hsl(${hue} 45% 72%)"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        font-family="system-ui, sans-serif" font-size="${Math.round(Math.min(width, height) / 8)}"
        fill="hsl(${hue} 60% 22%)">${label}</text>
</svg>`;
}

function hueFor(photoId: string): number {
  let hash = 0;
  for (let i = 0; i < photoId.length; i += 1) {
    hash = (hash * 31 + photoId.charCodeAt(i)) % 360;
  }
  return hash;
}

function isRendition(value: string): value is Rendition {
  return Object.prototype.hasOwnProperty.call(RENDITION_SPECS, value);
}

function handle(url: URL, res: ServerResponse): boolean {
  const path = url.pathname;

  // ---- Asset Worker stand-in -------------------------------------------
  // Capability URLs: /p/<photo-id>/<rendition>
  const asset = /^\/p\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (asset) {
    const [, photoId, rendition] = asset as unknown as [string, string, string];
    // Refuses trashed and unknown photos identically, exactly as the real
    // Worker must.
    const photo = getLivePhoto(catalog, photoId);
    if (!photo || !isRendition(rendition) || rendition === 'full') {
      sendNotFound(res);
      return true;
    }

    const descriptor = photo.derivatives[rendition];
    const body = placeholderSvg(
      descriptor.width,
      descriptor.height,
      rendition,
      hueFor(photoId),
    );
    res.writeHead(200, {
      ...baseSecurityHeaders(),
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(body);
    return true;
  }

  // ---- Display API ------------------------------------------------------
  const api = /^\/[^/]+\/api(\/.*)?$/.exec(path);
  if (!api) return false;

  const route = api[1] ?? '/';

  if (route === '/hierarchy') {
    sendJson(
      res,
      200,
      hierarchyResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'),
    );
    return true;
  }

  if (route === '/undated') {
    sendJson(res, 200, undatedResponse(catalog));
    return true;
  }

  const day = /^\/day\/(\d{4})\/(\d{2})\/(\d{2})$/.exec(route);
  if (day) {
    const [, y, m, d] = day as unknown as [string, string, string, string];
    const body = dayResponse(catalog, Number(y), Number(m), Number(d));
    if (!body) sendNotFound(res);
    else sendJson(res, 200, body);
    return true;
  }

  const photo = /^\/photo\/([0-9a-f]{32})$/.exec(route);
  if (photo) {
    const body = photoResponse(catalog, photo[1]!);
    if (!body) sendNotFound(res);
    else sendJson(res, 200, body);
    return true;
  }

  const download = /^\/download\/([0-9a-f]{32})$/.exec(route);
  if (download) {
    const record = getLivePhoto(catalog, download[1]!);
    if (!record) {
      sendNotFound(res);
      return true;
    }
    sendJson(res, 200, {
      // In production this is an HMAC-signed Worker URL; locally it just
      // points back at the placeholder so the button is exercisable.
      url: `/p/${record.id}/display-2560`,
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      filename: record.downloadFilename,
    });
    return true;
  }

  sendNotFound(res);
  return true;
}

export function fixtureServer(): Plugin {
  return {
    name: 'photo-fixture-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (!handle(url, res)) next();
        },
      );
    },
  };
}
