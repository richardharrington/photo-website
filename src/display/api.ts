/**
 * Display API client.
 *
 * Every request goes to a path below this build's own opaque base. The
 * display bundle has no admin base and no admin route, so there is nothing
 * here that could reach an admin endpoint even by mistake.
 */

import { appRoutes } from '../shared/urls.ts';
import { NotFoundError } from '../shared/ui/useResource.ts';
import type { PhotoResponse, TimelineResponse } from '../shared/display-api.ts';

export const routes = appRoutes(__APP_BASE__);

export interface DownloadLink {
  url: string;
  expiresAt: string;
  filename: string;
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
  /**
   * The whole library, in one request at page load.
   *
   * The viewer is a single scrolling page, so there is nothing left for
   * `/hierarchy`, `/day`, or `/undated` to answer; those routes stay on the
   * server for the admin app, which still browses level by level.
   */
  timeline: (signal?: AbortSignal) => getJson<TimelineResponse>('/timeline', signal),

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
