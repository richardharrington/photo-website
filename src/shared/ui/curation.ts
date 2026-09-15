/**
 * The one seam between the shared UI and what a listing may do.
 *
 * Both apps render the same pages, the same grid, and the same lightbox, and
 * both curate: the family link adds and edits (family-tier.md #3), and trashes
 * and restores what its own browser added (family-own-trash.md), and the admin
 * trashes anything and adds selection on top. Rather than thread
 * a dozen callbacks through every component, each listing provides this
 * context and the shared components read what they need from it — deciding by
 * `can`, never by whether a context is present.
 *
 * The direction of the dependency is what matters: nothing in this shared
 * tree imports from either app, so neither bundle carries a line of the
 * other's code. Everything here is therefore expressed in types both apps
 * already have — no admin types, no admin imports.
 */

import { createContext, useContext } from 'react';
import type { PublicPhoto } from '../display-api.ts';

/** The fields the edit form sends, exactly as `curationApi.edit` takes them. */
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
  /**
   * Who emailed this photograph in, or null when nobody did.
   *
   * A separate request rather than a field on `PublicPhoto`, because that
   * projection is a whitelist every page receives and who sent a photograph
   * is the administrator's business alone. It is asked for only when the info
   * panel is opened, and the address is resolved on the server — the browser
   * never holds an address id either.
   *
   * Required, like every other member here, so a new listing has to decide
   * rather than inherit: the trash, the upload panel, the family's library,
   * and the tests all answer null without a request, and only the admin's
   * library ever asks.
   */
  attribution(id: string): Promise<string | null>;
  /**
   * Put a trashed photo back. Reachable only where `can.restore`; every other
   * listing implements it as an unreachable no-op.
   */
  restore(id: string): void;
  /**
   * This browser added the photograph. Only the family's listings can say yes,
   * and only where `can.addedFrom`; every other listing answers false. It
   * decides only what is shown — the server decides what may be trashed
   * (family-own-trash.md #12).
   */
  addedHere(id: string): boolean;
  /** What the photo view offers for these photographs; see `Capabilities`. */
  can: Capabilities;
}

/**
 * What a context may do with the photographs it covers.
 *
 * Seven flags rather than one `readOnly` or `isAdmin`, because the six
 * listings that provide a context do not agree along any single axis:
 *
 *   | Listing               | edit | download | trash  | select | restore | added from | filename |
 *   | --------------------- | ---- | -------- | ------ | ------ | ------- | ---------- | -------- |
 *   | Family library/recent | yes  | yes      | `own`  | no     | no      | yes        | no       |
 *   | Family uploading      | yes  | no       | `none` | no     | no      | yes        | yes      |
 *   | Family trash          | no   | no       | `none` | no     | yes     | yes        | no       |
 *   | Admin library/recent  | yes  | yes      | `all`  | yes    | no      | no         | yes      |
 *   | Admin uploading       | yes  | no       | `none` | no     | no      | no         | yes      |
 *   | Admin trash           | no   | no       | `none` | yes    | yes     | no         | yes      |
 *
 * Both libraries edit and download. The admin's trashes any photograph and the
 * family's only one this browser added (`own`, decided per photograph by
 * `canTrash`), because a family member may take back their own mistake but not
 * remove anybody else's photograph (family-own-trash.md #4). Only the admin's
 * selects, because selection and its bulk actions are the administrator's
 * (family-tier.md #5). A
 * photograph still being uploaded allows editing and nothing else — it is
 * exactly the point of showing it early that its date and caption can be typed
 * before it lands — but it has no stored bytes to download, no catalog record
 * to trash, and no bulk action to be selected for. A trashed photo has no
 * download of any kind and no edit, and can be restored from the photo view in
 * either app; the admin's trash also selects, because its bar's Restore and
 * Delete permanently act on a selection.
 *
 * `select` is what decides a tile's gestures: where it is true a plain click
 * selects and a double-click opens, and where it is false a plain click opens,
 * as it always did. `addedFrom` is the family's: Photo info on every
 * photograph says whether it was added from this device or another, so a
 * missing Delete explains itself. The admin never records what it added, so
 * the line would say "Another device" of the administrator's own uploads, and
 * it is not shown there. None of the seven is optional, so adding one visits
 * every call site and no listing inherits a default.
 */
export interface Capabilities {
  edit: boolean;
  download: boolean;
  /**
   * Which photographs the photo view offers Delete for: every one, only those
   * added here (the family's library), or none.
   */
  trash: 'all' | 'own' | 'none';
  select: boolean;
  /** Restore from the trash. Only a trash listing says yes. */
  restore: boolean;
  /** Photo info's "Added from" line, answered by `addedHere`. The family's only. */
  addedFrom: boolean;
  /**
   * The filename on a tile and at the lightbox's top right. Admin only, and
   * the files still uploading. Photo info shows it regardless.
   */
  filename: boolean;
}

/** Whether the photo view offers Delete, and the Delete key, for this photograph. */
export function canTrash(curation: Curation, photoId: string): boolean {
  if (curation.can.trash === 'all') return true;
  return curation.can.trash === 'own' && curation.addedHere(photoId);
}

export const CurationContext = createContext<Curation | null>(null);

/**
 * `null` only in tests and in a listing that deliberately provides nothing.
 * Both apps provide one, and components decide by `can`, never by presence.
 */
export function useCuration(): Curation | null {
  return useContext(CurationContext);
}
