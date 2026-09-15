import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useResource } from './useResource.ts';
import { Layout } from './Layout.tsx';
import { ErrorState, Loading } from './States.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { SelectAll } from './SelectAll.tsx';
import { Lightbox } from './Lightbox.tsx';
import { Confirm } from './Confirm.tsx';
import { CurationContext } from './curation.ts';
import type { Curation } from './curation.ts';
import { routes } from './api.ts';
import { curationApi } from './curation-api.ts';
import type { PreviewResult, TrashItem, TrashListing } from './curation-api.ts';
import { formatCaptureDate } from '../datetime.ts';
import { TRASH_RETENTION_DAYS } from '../constants.ts';

/**
 * A selection over the trash's own listing, as the admin supplies it.
 *
 * Built from the listing's IDs on every render, so it is always pruned to what
 * is on the page: a restore takes photos out of the listing without touching
 * the selection, and a bulk action must never reach a photo that is no longer
 * shown.
 */
export interface TrashSelection {
  selectedIds: ReadonlySet<string>;
  /** The selected photos, pruned to the listing. */
  chosen: string[];
  selectOnly(id: string): void;
  toggle(id: string): void;
  extendTo(id: string): void;
  selectAll(ids: readonly string[]): void;
  deselectAll(): void;
}

/** What a selection bar over the trash needs from the page. */
export interface TrashBarState {
  chosen: string[];
  busy: boolean;
  restore(ids: string[]): void;
  startPermanentDelete(ids: string[]): void;
  deselectAll(): void;
}

/** The two halves of a permanent delete, which only the admin can call. */
export interface PermanentDelete {
  preview(ids: string[]): Promise<PreviewResult>;
  confirm(preview: PreviewResult): Promise<unknown>;
}

/** A stable empty listing, so the memos below do not see a new array a render. */
const NO_ITEMS: readonly TrashItem[] = [];
const NOTHING_SELECTED: ReadonlySet<string> = new Set();
const NONE_CHOSEN: string[] = [];

/**
 * The date a trashed photo will be purged.
 *
 * An absolute date rather than a countdown: it is unambiguous, it matches how
 * the rest of the site states dates, and it is a pure function of the record
 * — no clock read during render.
 *
 * `trashedAt` is a genuine instant, unlike a capture time, so Date arithmetic
 * is the right tool here.
 */
function purgeDate(trashedAt: string): string {
  const purgeAt = new Date(Date.parse(trashedAt) + TRASH_RETENTION_DAYS * 86_400_000);
  return formatCaptureDate(purgeAt.toISOString().slice(0, 10));
}

/**
 * The trash: the same grid and the same photo view as the library, read-only
 * but for putting photographs back.
 *
 * Identification is the whole job here — is this the photograph I meant to
 * throw away? — so it shows a thumbnail, the original date, and the date it
 * will be purged, on the grid everyone already knows, with a photo view big
 * enough to be sure. The photo view's one action is Restore. It offers no
 * download of any kind, and the API never signs the full rendition for a
 * trashed photo.
 *
 * One page for both apps (family-tier.md 7.7). The family's trash holds no
 * selection: a tap opens a photograph and Restore puts it back. It holds only
 * the photographs added from this browser, because that is all the server
 * lists for the family link (family-own-trash.md #6); nothing here filters. The admin
 * passes a selection, a bar that owns Restore and Delete permanently for it,
 * and the permanent-delete calls; the grid, the photo view, the restore call,
 * and the dialog stay here either way.
 *
 * Both images arrive as short-lived signed URLs, because the Worker refuses
 * capability-URL access to a trashed photo. That is also why the photo view
 * here is local state rather than a route: `/photo/<id>` for a trashed photo
 * is a 404 by design, so there is no address to link a tile to.
 */
export function TrashPage({
  nav,
  onChanged,
  selection: select,
  bar,
  permanentDelete,
  filenames,
}: {
  nav: ReactNode;
  /** The header's Trash count is the app's, and a restore changes it. */
  onChanged: () => void;
  /**
   * The selection over this listing, or null for a trash that does not
   * select. The admin supplies it, holding the state and the deselect
   * gestures itself; the family app passes null.
   */
  selection: ((ids: readonly string[]) => TrashSelection) | null;
  /**
   * The selection bar, or null. The admin passes its bar, which owns Restore
   * and Delete permanently for a selection; the family app passes nothing,
   * and restores from the lightbox.
   */
  bar: ((state: TrashBarState) => ReactNode) | null;
  /** Null where permanent deletion is not offered at all. */
  permanentDelete: PermanentDelete | null;
  /** Filenames on the tiles and at the photo view's corner: the admin's. */
  filenames: boolean;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resource = useResource<TrashListing>(
    (signal) => curationApi.trash(signal),
    [reloadKey],
  );

  const items = resource.status === 'ready' ? resource.data.items : NO_ITEMS;
  const ids = useMemo(() => items.map((item) => item.photo.id), [items]);
  const byId = useMemo(
    () => new Map(items.map((item) => [item.photo.id, item])),
    [items],
  );

  const selection = select ? select(ids) : null;
  const chosen = selection?.chosen ?? NONE_CHOSEN;

  function reload() {
    selection?.deselectAll();
    setOpenId(null);
    setReloadKey((key) => key + 1);
    onChanged();
  }

  async function restore(photoIds: string[]) {
    setBusy(true);
    setError(null);
    try {
      await curationApi.restore(photoIds);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  async function startPermanentDelete(photoIds: string[]) {
    if (!permanentDelete) return;
    setError(null);
    try {
      setPreview(await permanentDelete.preview(photoIds));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmPermanentDelete() {
    if (!preview || !permanentDelete) return;
    setBusy(true);
    try {
      await permanentDelete.confirm(preview);
      setPreview(null);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Curation for trashed photographs: nothing that edits, downloads, or
   * trashes, and Restore from the photo view. The capabilities are what tell
   * the shared photo view to show no form, no Download, and no Delete, so the
   * two callbacks for those are unreachable rather than merely unused. The
   * selection gestures are the admin's, where it passed a selection.
   */
  const curation = useMemo<Curation>(
    () => ({
      selectedIds: selection?.selectedIds ?? NOTHING_SELECTED,
      selectOnly: (id) => selection?.selectOnly(id),
      toggle: (id) => selection?.toggle(id),
      extendTo: (id) => selection?.extendTo(id),
      selectAll: (all) => selection?.selectAll(all),
      trash: () => {
        // Unreachable: `can.trash` is 'none', so no Delete button and no key.
      },
      edit: () => Promise.reject(new Error('A trashed photo cannot be edited.')),
      // The trash identifies a photograph well enough to decide about it;
      // where it came from is a library question.
      attribution: () => Promise.resolve(null),
      restore: (id) => void restore([id]),
      addedHere: () => false,
      can: {
        edit: false,
        download: false,
        trash: 'none',
        select: selection !== null,
        restore: true,
        filename: filenames,
      },
    }),
    // `restore` reads this render's `reload`, which is what `selection` stands
    // for; the selection is rebuilt from the listing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, filenames],
  );

  if (resource.status === 'loading') {
    return (
      <Layout nav={nav}>
        <Loading />
      </Layout>
    );
  }
  if (resource.status === 'error') {
    return (
      <Layout nav={nav}>
        <ErrorState message={resource.message} />
      </Layout>
    );
  }
  if (resource.status === 'not-found') {
    return (
      <Layout nav={nav}>
        <ErrorState message="The trash could not be read." />
      </Layout>
    );
  }

  const open = openId ? byId.get(openId) : undefined;

  return (
    <CurationContext.Provider value={curation}>
      <Layout nav={nav}>
        {selection ? (
          <p className="trash__intro">
            Deleted photos are kept for {TRASH_RETENTION_DAYS} days, then removed
            automatically. Click a photo to select it for Restore or Delete permanently;
            double-click — or, on a touchscreen, press and hold — to look at it.
          </p>
        ) : (
          <p className="trash__intro">
            Photos added from this device that have been deleted are kept here for{' '}
            {TRASH_RETENTION_DAYS} days, then removed automatically. Tap one to look at
            it and restore it.
          </p>
        )}

        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="state state--empty">The trash is empty.</p>
        ) : (
          <div className="timeline">
            <section className="timeline__year">
              {/* The library's own heading treatment, with the one control a
                  single-group listing needs where it selects. It names no
                  route: the trash is already the whole page. */}
              <h2 className="timeline__year-heading">
                <span className="timeline__anchor">
                  <span>Trash</span>
                  <span className="timeline__count">
                    {items.length} photo{items.length === 1 ? '' : 's'}
                  </span>
                </span>
                <SelectAll ids={ids} />
              </h2>

              <PhotoGrid
                photos={items.map((item) => item.photo)}
                imageSrc={(photo) => byId.get(photo.id)?.thumbnailUrl ?? ''}
                note={(photo) => {
                  const item = byId.get(photo.id);
                  if (!item) return null;
                  return (
                    <>
                      <span>
                        {photo.captureDate
                          ? formatCaptureDate(photo.captureDate)
                          : 'Undated'}
                      </span>
                      <span>
                        Deleted {formatCaptureDate(item.trashedAt.slice(0, 10))}, purged{' '}
                        {purgeDate(item.trashedAt)}
                      </span>
                    </>
                  );
                }}
                open={(photo) => setOpenId(photo.id)}
              />
            </section>
          </div>
        )}
      </Layout>

      {open ? (
        <Lightbox
          photo={open.photo}
          orderedIds={ids}
          backHref={routes.trash()}
          onClose={() => setOpenId(null)}
          // Local state, not a route: see the note at the top of this file.
          onStep={setOpenId}
          imageSrc={open.previewUrl}
        />
      ) : null}

      {bar && selection
        ? bar({
            chosen,
            busy,
            restore: (photoIds) => void restore(photoIds),
            startPermanentDelete: (photoIds) => void startPermanentDelete(photoIds),
            deselectAll: selection.deselectAll,
          })
        : null}

      {preview && permanentDelete ? (
        <Confirm
          preview={preview}
          title="Delete permanently?"
          description="will be deleted permanently, bytes and record alike. This cannot be undone."
          confirmLabel="Delete permanently"
          destructive
          onConfirm={() => void confirmPermanentDelete()}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </CurationContext.Provider>
  );
}
