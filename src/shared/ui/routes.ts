/**
 * Client-side routes for both apps, below each build's own opaque base.
 *
 * Deep URLs are stable and shareable. A photo's route is keyed by its ID
 * rather than its date, so correcting a capture date never breaks a bookmark
 * someone has already sent to the family.
 */

import { isValidPhotoId } from '../ids.ts';
import { isValidYmd } from '../datetime.ts';

export type Route =
  | { kind: 'home' }
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'day'; year: number; month: number; day: number }
  | { kind: 'undated' }
  | { kind: 'photo'; id: string }
  | { kind: 'not-found' };

const NOT_FOUND: Route = { kind: 'not-found' };

const YEAR_RE = /^\d{4}$/;
const TWO_DIGIT_RE = /^\d{2}$/;

/**
 * Parse a pathname into a route.
 *
 * Anything malformed becomes `not-found` rather than being coerced, so a
 * mistyped URL shows the site's own 404 instead of an empty group that looks
 * like a real but deleted one.
 */
export function parseRoute(pathname: string, base: string): Route {
  const root = base.replace(/\/+$/, '');
  if (!pathname.startsWith(root)) return NOT_FOUND;

  const rest = pathname.slice(root.length);
  const segments = rest.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) return { kind: 'home' };

  if (segments[0] === 'undated') {
    return segments.length === 1 ? { kind: 'undated' } : NOT_FOUND;
  }

  if (segments[0] === 'photo') {
    const id = segments[1];
    if (segments.length !== 2 || !id || !isValidPhotoId(id)) return NOT_FOUND;
    return { kind: 'photo', id };
  }

  const [rawYear, rawMonth, rawDay] = segments;
  if (!rawYear || !YEAR_RE.test(rawYear)) return NOT_FOUND;
  const year = Number(rawYear);
  if (segments.length === 1) return { kind: 'year', year };

  if (!rawMonth || !TWO_DIGIT_RE.test(rawMonth)) return NOT_FOUND;
  const month = Number(rawMonth);
  if (month < 1 || month > 12) return NOT_FOUND;
  if (segments.length === 2) return { kind: 'month', year, month };

  if (!rawDay || !TWO_DIGIT_RE.test(rawDay)) return NOT_FOUND;
  const day = Number(rawDay);
  // Rejects February 30th here rather than showing an empty day grid for it.
  if (!isValidYmd(year, month, day)) return NOT_FOUND;
  if (segments.length === 3) return { kind: 'day', year, month, day };

  return NOT_FOUND;
}
