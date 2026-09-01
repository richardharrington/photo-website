/**
 * The read projections both APIs serve.
 *
 * The admin app browses the library through the same hierarchy, day, and
 * photo routes as the viewer — `src/admin/api.ts` says it "extends the
 * display hierarchy rather than duplicating it" — so both functions must
 * answer them. They lived only in `display.ts`, which meant the admin app's
 * very first request 404ed in production while working locally, because the
 * development fixture server falls through to its display handler for any
 * admin GET it does not recognise.
 *
 * Sharing one implementation is what keeps that from drifting apart again.
 */

import {
  dayResponse,
  hierarchyResponse,
  photoResponse,
  timelineResponse,
  undatedResponse,
} from '../../../src/shared/display-api.ts';
import type { Catalog } from '../../../src/shared/catalog.ts';
import { json, notFound } from './http.ts';

const DAY_ROUTE = /^\/day\/(\d{4})\/(\d{2})\/(\d{2})$/;
const PHOTO_ROUTE = /^\/photo\/([0-9a-f]{32})$/;

/**
 * Answer a read route, or return `null` when `path` is not one.
 *
 * The distinction matters: `null` means "keep looking, this belongs to
 * another handler", while a 404 response means "this is a read route and
 * there is no such day or photo".
 */
export function readRoute(catalog: Catalog, path: string): Response | null {
  if (path === '/hierarchy') {
    return json(hierarchyResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'));
  }

  // The viewer's whole page, in one request. The admin app keeps browsing
  // through `/hierarchy` and `/day`, which is why both survive alongside it.
  if (path === '/timeline') {
    return json(timelineResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'));
  }

  if (path === '/undated') return json(undatedResponse(catalog));

  const day = DAY_ROUTE.exec(path);
  if (day) {
    const body = dayResponse(catalog, Number(day[1]), Number(day[2]), Number(day[3]));
    return body ? json(body) : notFound();
  }

  const photo = PHOTO_ROUTE.exec(path);
  if (photo) {
    const body = photoResponse(catalog, photo[1]!);
    return body ? json(body) : notFound();
  }

  return null;
}
