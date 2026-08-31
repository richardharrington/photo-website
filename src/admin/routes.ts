/**
 * Admin routes: the display hierarchy, plus Trash.
 */

import { isValidPhotoId } from '../shared/ids.ts';
import { isValidYmd } from '../shared/datetime.ts';

export type AdminRoute =
  | { kind: 'home' }
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'day'; year: number; month: number; day: number }
  | { kind: 'undated' }
  | { kind: 'photo'; id: string }
  | { kind: 'trash' }
  | { kind: 'not-found' };

const NOT_FOUND: AdminRoute = { kind: 'not-found' };

export function parseAdminRoute(pathname: string, base: string): AdminRoute {
  const root = base.replace(/\/+$/, '');
  if (!pathname.startsWith(root)) return NOT_FOUND;

  const segments = pathname
    .slice(root.length)
    .split('/')
    .filter((segment) => segment !== '');

  if (segments.length === 0) return { kind: 'home' };
  if (segments[0] === 'trash') {
    return segments.length === 1 ? { kind: 'trash' } : NOT_FOUND;
  }
  if (segments[0] === 'undated') {
    return segments.length === 1 ? { kind: 'undated' } : NOT_FOUND;
  }
  if (segments[0] === 'photo') {
    const id = segments[1];
    if (segments.length !== 2 || !id || !isValidPhotoId(id)) return NOT_FOUND;
    return { kind: 'photo', id };
  }

  const [rawYear, rawMonth, rawDay] = segments;
  if (!rawYear || !/^\d{4}$/.test(rawYear)) return NOT_FOUND;
  const year = Number(rawYear);
  if (segments.length === 1) return { kind: 'year', year };

  if (!rawMonth || !/^\d{2}$/.test(rawMonth)) return NOT_FOUND;
  const month = Number(rawMonth);
  if (month < 1 || month > 12) return NOT_FOUND;
  if (segments.length === 2) return { kind: 'month', year, month };

  if (!rawDay || !/^\d{2}$/.test(rawDay)) return NOT_FOUND;
  const day = Number(rawDay);
  if (!isValidYmd(year, month, day)) return NOT_FOUND;
  if (segments.length === 3) return { kind: 'day', year, month, day };

  return NOT_FOUND;
}
