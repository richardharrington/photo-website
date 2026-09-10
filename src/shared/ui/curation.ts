/**
 * The one seam between the shared UI and the admin app.
 *
 * The viewer and the admin render the same pages, the same grid, and the same
 * lightbox; the admin's difference is curation — selecting, editing, deleting.
 * Rather than thread a dozen callbacks through every component, the admin
 * provides this context and the shared components check for its presence.
 *
 * The direction of the dependency is what matters: nothing in this shared
 * tree imports from either app, so the viewer compiles and ships without a
 * line of admin code, carrying only the branches that test this context for
 * `null`. Everything here is therefore expressed in types the viewer already
 * has — no admin types, no admin imports.
 */

import { createContext, useContext } from 'react';
import type { PublicPhoto } from '../display-api.ts';

/** The fields the edit form sends, exactly as `adminApi.edit` takes them. */
export interface PhotoEdit {
  date: string | null;
  time: string | null;
  caption: string | null;
}

export interface Curation {
  /** Photos a bulk action would cover, pruned to what is on the page. */
  selectedIds: ReadonlySet<string>;
  /**
   * Plain click: this photograph alone, unless it is already selected, in
   * which case the selection is left as it is. The anchor moves either way.
   * See `selectOnly` in the admin's `selection.ts` for why that matters.
   */
  selectOnly(id: string): void;
  /** Modifier-click. */
  toggle(id: string): void;
  /** Shift-click. */
  extendTo(id: string): void;
  /** A day heading's Select all: add these to the selection, keep the rest. */
  selectAll(ids: readonly string[]): void;
  /** Delete one photo: preview, confirm, then the app's post-delete flow. */
  trash(id: string): void;
  /** Save an edit; resolves with the stored photo. Rejects with a message. */
  edit(id: string, edit: PhotoEdit): Promise<PublicPhoto>;
  /** What the photo view offers for these photographs; see `Capabilities`. */
  can: Capabilities;
}

/**
 * What a context may do with the photographs it covers.
 *
 * Four of them rather than one `readOnly` flag, because the three listings
 * that provide a context do not agree along a single axis. The library allows
 * all four. The trash allows only `select`: a trashed photo has no download of
 * any kind and no edit, and its own bar owns Restore and Delete permanently,
 * both of which act on a selection. A photograph still being uploaded allows
 * editing and nothing else — it is exactly the point of showing it early that
 * its date and caption can be typed before it lands — but it has no stored
 * bytes to download, no catalog record to trash, and no bulk action to be
 * selected for.
 *
 * `select` is what decides a tile's gestures: where it is true a plain click
 * selects and a double-click opens, and where it is false a plain click opens,
 * as it always did. None of the four is optional, so adding one visits every
 * call site and no listing inherits a default.
 *
 * The viewer provides no context at all, and gets the download it has always
 * had; only `edit`, `trash` and `select` are admin-only by nature.
 */
export interface Capabilities {
  edit: boolean;
  download: boolean;
  trash: boolean;
  select: boolean;
}

export const CurationContext = createContext<Curation | null>(null);

/** `null` in the viewer, which is how every shared component tells them apart. */
export function useCuration(): Curation | null {
  return useContext(CurationContext);
}
