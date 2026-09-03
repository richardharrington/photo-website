/**
 * The read client both apps share.
 *
 * Every request goes to a path below this build's own opaque base, which is a
 * build-time define — so the same module resolves to the display base in the
 * display bundle and the admin base in the admin bundle, and neither can reach
 * the other's endpoints even by mistake. That is also why the shared UI needs
 * nothing injected to talk to its own API.
 *
 * Mutations are not here. The admin app's own client wraps this one and adds
 * them; the viewer has no writes at all.
 */

import { appRoutes } from '../urls.ts';
import { NotFoundError } from './useResource.ts';
import type { PhotoResponse, TimelineResponse } from '../display-api.ts';

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
    // Same-origin only; neither app talks to another origin for JSON.
    credentials: 'omit',
  });

  if (response.status === 404) throw new NotFoundError();
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export const readApi = {
  /**
   * The whole library, in one request at page load.
   *
   * Both apps are a single scrolling page, so this and `/photo` are the only
   * read projections the server has.
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
