import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useResource } from '../../shared/ui/useResource.ts';
import { Layout } from '../../shared/ui/Layout.tsx';
import { ErrorState, Loading } from '../../shared/ui/States.tsx';
import { PhotoGrid } from '../../shared/ui/PhotoGrid.tsx';
import { SelectAll } from '../../shared/ui/SelectAll.tsx';
import { Lightbox } from '../../shared/ui/Lightbox.tsx';
import { CurationContext } from '../../shared/ui/curation.ts';
import type { Curation } from '../../shared/ui/curation.ts';
import { formatCaptureDate } from '../../shared/datetime.ts';
import { TRASH_RETENTION_DAYS } from '../../shared/constants.ts';
import { adminApi, routes } from '../api.ts';
import type { PreviewResult, TrashItem, TrashListing } from '../api.ts';
import { Confirm } from './Confirm.tsx';
import { SelectionBar } from './SelectionBar.tsx';
import {
  addAll,
  anchorOn,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectedIds,
  toggle,
} from '../selection.ts';
import type { SelectionState } from '../selection.ts';

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
/** A stable empty listing, so the memos below do not see a new array a render. */
const NO_ITEMS: readonly TrashItem[] = [];

function purgeDate(trashedAt: string): string {
  const purgeAt = new Date(Date.parse(trashedAt) + TRASH_RETENTION_DAYS * 86_400_000);
  return formatCaptureDate(purgeAt.toISOString().slice(0, 10));
}

/**
 * The trash: the same grid and the same photo view as the library, read-only.
 *
 * Identification is the whole job here — is this the photograph I meant to
 * throw away? — so it shows a thumbnail, a filename, the original date, and
 * the date it will be purged, on the grid an administrator already knows, with
 * a photo view big enough to be sure. It offers no download of any kind, and
 * the API never signs the full rendition for a trashed photo.
 *
 * Both images arrive as short-lived signed URLs, because the Worker refuses
 * capability-URL access to a trashed photo. That is also why the photo view
 * here is local state rather than a route: `/photo/<id>` for a trashed photo
 * is a 404 by design, so there is no address to link a tile to.
 */
export function TrashPage({
  nav,
  onChanged,
}: {
  nav: ReactNode;
  /** The header's Trash count is the app's, and a restore changes it. */
  onChanged: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resource = useResource<TrashListing>(
    (signal) => adminApi.trash(signal),
    [reloadKey],
  );

  const items = resource.status === 'ready' ? resource.data.items : NO_ITEMS;
  const ids = useMemo(() => items.map((item) => item.photo.id), [items]);
  const byId = useMemo(
    () => new Map(items.map((item) => [item.photo.id, item])),
    [items],
  );

  // Everything works from the pruned selection, never the raw state: a restore
  // takes photos out of the listing without touching it, and a bulk action
  // must never reach a photo the administrator can no longer see.
  const visible = pruneToVisible(selection, ids);
  const chosen = selectedIds(visible);

  function reload() {
    setSelection(EMPTY_SELECTION);
    setOpenId(null);
    setReloadKey((key) => key + 1);
    onChanged();
  }

  async function restore(photoIds: string[]) {
    setBusy(true);
    setError(null);
    try {
      await adminApi.restore(photoIds);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  async function startPermanentDelete(photoIds: string[]) {
    setError(null);
    try {
      setPreview(await adminApi.previewPermanentDelete(photoIds));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmPermanentDelete() {
    if (!preview) return;
    setBusy(true);
    try {
      await adminApi.confirmPermanentDelete(preview);
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
   * Read-only curation: the same selection gestures as the library, and
   * nothing that edits or trashes. `readOnly` is what tells the shared photo
   * view to show no form, no Download, and no Delete, so the two callbacks
   * below are unreachable rather than merely unused.
   */
  const curation = useMemo<Curation>(
    () => ({
      selectedIds: visible.ids,
      anchorOn: (id) => setSelection(anchorOn(id)),
      toggle: (id) => setSelection(toggle(visible, id)),
      extendTo: (id) => setSelection(extendTo(visible, ids, id)),
      selectAll: (all) => setSelection((state) => addAll(state, all)),
      trash: () => {
        // Unreachable: `readOnly` means no Delete button and no Delete key.
      },
      edit: () => Promise.reject(new Error('A trashed photo cannot be edited.')),
      readOnly: true,
    }),
    // Both are recomputed only when the listing itself changes.
    [visible, ids],
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
        <p className="trash__intro">
          Deleted photos are kept for {TRASH_RETENTION_DAYS} days, then removed
          automatically.
        </p>

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
                  single-group listing needs. It names no route: the trash is
                  already the whole page. */}
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

      {chosen.length > 0 ? (
        <SelectionBar
          count={chosen.length}
          onDeselectAll={() => setSelection(EMPTY_SELECTION)}
        >
          <button type="button" disabled={busy} onClick={() => void restore(chosen)}>
            Restore
          </button>
          <button
            type="button"
            className="admin-danger"
            disabled={busy}
            onClick={() => void startPermanentDelete(chosen)}
          >
            Delete permanently
          </button>
        </SelectionBar>
      ) : null}

      {preview ? (
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
