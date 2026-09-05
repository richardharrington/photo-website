/**
 * URL construction for app routes and image capability URLs.
 *
 * Both apps build derivative URLs on the client rather than receiving them
 * from the API. The URLs are stable functions of the photo ID, so a browser
 * can reuse a cached thumbnail across visits instead of re-fetching one behind
 * a freshly signed link (decisions.md #8).
 */

import type { DisplayRendition } from './constants.ts';

/** Two-digit zero padding for month and day segments. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Routes below the app's opaque base. The base is baked into each build, so
 * the display bundle can only ever produce display URLs.
 */
export function appRoutes(base: string) {
  const root = base.replace(/\/+$/, '');
  return {
    home: () => `${root}/`,
    year: (year: number) => `${root}/${year}`,
    month: (year: number, month: number) => `${root}/${year}/${pad2(month)}`,
    day: (year: number, month: number, day: number) =>
      `${root}/${year}/${pad2(month)}/${pad2(day)}`,
    undated: () => `${root}/undated`,
    photo: (id: string) => `${root}/photo/${id}`,
    /**
     * The Recently Uploaded view, and a photograph opened from it.
     *
     * There is deliberately no address for one upload sitting: a link to it
     * would stop meaning anything as soon as that sitting aged out of the set,
     * and a URL that silently becomes a 404 is worse than no URL. `/recent`
     * itself is stable, which is the link that matters.
     */
    recent: () => `${root}/recent`,
    recentPhoto: (id: string) => `${root}/recent/photo/${id}`,
    trash: () => `${root}/trash`,
    api: (path: string) => `${root}/api${path.startsWith('/') ? path : `/${path}`}`,
  };
}

export type AppRoutes = ReturnType<typeof appRoutes>;

/**
 * Unsigned capability URL for a display derivative. Unguessable because the
 * photo ID is 128 bits of randomness, and cacheable because it never expires.
 */
export function derivativeUrl(
  workerBaseUrl: string,
  photoId: string,
  rendition: DisplayRendition,
): string {
  return `${workerBaseUrl.replace(/\/+$/, '')}/p/${photoId}/${rendition}`;
}

/**
 * `srcset` for a grid or lightbox image, so the browser picks a rendition to
 * match the display size and pixel ratio.
 */
export function derivativeSrcSet(
  workerBaseUrl: string,
  photoId: string,
  renditions: readonly { rendition: DisplayRendition; width: number }[],
): string {
  return renditions
    .map(
      ({ rendition, width }) =>
        `${derivativeUrl(workerBaseUrl, photoId, rendition)} ${width}w`,
    )
    .join(', ');
}
