/**
 * Display API client.
 *
 * Every request goes to a path below this build's own opaque base. The
 * display bundle has no admin base and no admin route, so there is nothing
 * here that could reach an admin endpoint even by mistake.
 */

import { appRoutes } from '../shared/urls.ts';
import { NotFoundError } from '../shared/ui/useResource.ts';
import type {
  GroupResponse,
  HierarchyResponse,
  PhotoResponse,
} from '../shared/display-api.ts';

export const routes = appRoutes(__APP_BASE__);

export interface DownloadLink {
  url: string;
  expiresAt: string;
  filename: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(routes.api(path), {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
    // Same-origin only; the viewer never talks to another origin.
    credentials: 'omit',
  });

  if (response.status === 404) throw new NotFoundError();
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export const displayApi = {
  hierarchy: (signal?: AbortSignal) => getJson<HierarchyResponse>('/hierarchy', signal),

  day: (year: number, month: number, day: number, signal?: AbortSignal) =>
    getJson<GroupResponse>(`/day/${year}/${pad2(month)}/${pad2(day)}`, signal),

  undated: (signal?: AbortSignal) => getJson<GroupResponse>('/undated', signal),

  photo: (id: string, signal?: AbortSignal) =>
    getJson<PhotoResponse>(`/photo/${id}`, signal),

  /**
   * Signed, short-lived link to the full-resolution JPEG. Requested at click
   * time rather than rendered into the page, so a five-minute link cannot go
   * stale while someone reads a caption.
   */
  downloadLink: (id: string, signal?: AbortSignal) =>
    getJson<DownloadLink>(`/download/${id}`, signal),
};
