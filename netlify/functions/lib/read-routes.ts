/**
 * The read projections both APIs serve.
 *
 * The admin app is the viewer plus curation — the same one-page timeline and
 * the same photo view — so it reads through the very same two routes, and both
 * functions have to answer them. They lived only in `display.ts` once, which
 * meant the admin app's very first request 404ed in production while working
 * locally, because the development fixture server falls through to its display
 * handler for any admin GET it does not recognise.
 *
 * Sharing one implementation is what keeps that from drifting apart again.
 */

import { photoResponse, timelineResponse } from '../../../src/shared/display-api.ts';
import type { Catalog } from '../../../src/shared/catalog.ts';
import { json, notFound } from './http.ts';

const PHOTO_ROUTE = /^\/photo\/([0-9a-f]{32})$/;

/**
 * Answer a read route, or return `null` when `path` is not one.
 *
 * The distinction matters: `null` means "keep looking, this belongs to
 * another handler", while a 404 response means "this is a read route and
 * there is no such photo".
 */
export function readRoute(catalog: Catalog, path: string): Response | null {
  // The whole library, in one request. Both apps lay themselves out from it.
  if (path === '/timeline') {
    return json(timelineResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'));
  }

  const photo = PHOTO_ROUTE.exec(path);
  if (photo) {
    const body = photoResponse(catalog, photo[1]!);
    return body ? json(body) : notFound();
  }

  return null;
}
