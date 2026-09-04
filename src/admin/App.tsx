import { useCallback, useMemo, useRef, useState } from 'react';
import { navigate, useLocationPath } from '../shared/ui/navigation.ts';
import { Link } from '../shared/ui/Link.tsx';
import { useResource } from '../shared/ui/useResource.ts';
import type { Resource } from '../shared/ui/useResource.ts';
import { parseRoute } from '../shared/ui/routes.ts';
import type { Route } from '../shared/ui/routes.ts';
import { Layout } from '../shared/ui/Layout.tsx';
import { NotFound } from '../shared/ui/States.tsx';
import { TimelinePage } from '../shared/ui/TimelinePage.tsx';
import type { TimelineTarget } from '../shared/ui/TimelinePage.tsx';
import { PhotoPage } from '../shared/ui/PhotoPage.tsx';
import { indexTimeline } from '../shared/ui/timeline-index.ts';
import { CurationContext } from '../shared/ui/curation.ts';
import type { Curation, PhotoEdit } from '../shared/ui/curation.ts';
import { removePhotos, upsertPhoto } from '../shared/timeline-patch.ts';
import { nextAfterDeleting } from './advance.ts';
import { adminApi, routes } from './api.ts';
import type { PreviewResult } from './api.ts';
import { Confirm, UndoBanner } from './components/Confirm.tsx';
import { SelectionBar } from './components/SelectionBar.tsx';
import { TrashPage } from './components/TrashPage.tsx';
import { UploadPanel } from './components/Upload.tsx';
import {
  addAll,
  anchorOn,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectedIds,
  toggle,
} from './selection.ts';
import type { SelectionState } from './selection.ts';
import type { PublicPhoto, TimelineResponse } from '../shared/display-api.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';

/** The admin's own top-level pages, on top of the routes both apps share. */
const ADMIN_PAGES = ['trash'] as const;

/** Which section of the one page a route is asking for. */
function targetOf(
  route: Exclude<Route, { kind: 'not-found' | 'photo' | 'page' }>,
): TimelineTarget {
  switch (route.kind) {
    case 'home':
      return { kind: 'top' };
    case 'year':
      return { kind: 'year', year: route.year };
    case 'month':
      return { kind: 'month', year: route.year, month: route.month };
    case 'day':
      return { kind: 'day', year: route.year, month: route.month, day: route.day };
    case 'undated':
      return { kind: 'undated' };
  }
}

function photoCount(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/**
 * The admin site: the viewer, plus curation.
 *
 * One request, one page, the same pages the family sees — with a selection, an
 * upload target above the timeline, an edit form in the photo view, and Trash
 * in the header. Everything that makes it an admin is the `CurationContext`
 * this provides; nothing in `src/shared/ui/` knows this file exists.
 *
 * This component owns the library, because every mutation changes it and
 * because a delete in the photo view has to know what the neighbouring photo
 * was. It holds the fetched timeline and a patched copy: a mutation patches
 * the copy from the server's own reply, so the page never waits on a reload,
 * and a background refetch replaces it a moment later so nothing stays out of
 * step for long.
 */
export function App() {
  const path = useLocationPath();
  const route = parseRoute(path, __APP_BASE__, ADMIN_PAGES);

  /**
   * The library as fetched, and as patched.
   *
   * `fetched` loads once and is never re-run: refetching goes through
   * `refetch` below, which replaces the patched copy in place rather than
   * dropping the page back to a loading state.
   */
  const fetched = useResource<TimelineResponse>(
    (signal) => adminApi.timeline(signal),
    [],
  );
  const [patched, setPatched] = useState<TimelineResponse | null>(null);
  const data = patched ?? (fetched.status === 'ready' ? fetched.data : null);

  const timeline = useMemo<Resource<TimelineResponse>>(
    () => (data ? { status: 'ready', data, stale: false } : fetched),
    [data, fetched],
  );

  /**
   * At most one refetch in flight; a burst of edits is not a burst of GETs.
   *
   * It resolves when the library on the page is up to date, which the upload
   * panel waits on before it forgets the files it has just added.
   */
  const pendingRefetch = useRef<Promise<void> | null>(null);
  const refetch = useCallback((): Promise<void> => {
    const running = pendingRefetch.current;
    if (running) return running;
    const next = adminApi
      .timeline()
      .then((response) => setPatched(response))
      // A failed background refetch leaves the patched copy standing: it is
      // the server's own reply to the mutation, not a guess.
      .catch(() => undefined)
      .finally(() => {
        pendingRefetch.current = null;
      });
    pendingRefetch.current = next;
    return next;
  }, []);

  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<{
    result: PreviewResult;
    /** The photo the view was on, when the delete came from the photo view. */
    from: string | null;
  } | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dismissUndo = useCallback(() => setUndo(null), []);

  const orderedIds = useMemo(
    () => (data ? indexTimeline(data).orderedIds : []),
    [data],
  );

  // Pruned on every render, never the raw state: a delete takes photos off the
  // page without touching the selection, and a bulk action must never reach a
  // photo the administrator can no longer see.
  const visible = pruneToVisible(selection, orderedIds);
  const chosen = selectedIds(visible);

  const [trashKey, setTrashKey] = useState(0);
  const trash = useResource<{ count: number }>(
    (signal) => adminApi.trashCount(signal),
    [trashKey],
  );
  const trashCount = trash.status === 'ready' ? trash.data.count : null;
  const countTrashAgain = useCallback(() => setTrashKey((key) => key + 1), []);

  async function startTrash(query: SelectionQuery, from: string | null) {
    setError(null);
    try {
      setPreview({ result: await adminApi.previewTrash(query), from });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmTrash() {
    if (!preview || !data) return;
    const { result, from } = preview;
    try {
      const outcome = await adminApi.confirmTrash(result);
      setPreview(null);

      // Before the patch, while the trashed photo still has neighbours.
      const next = from ? nextAfterDeleting(orderedIds, outcome.trashed, from) : null;

      setPatched(removePhotos(data, outcome.trashed));
      setUndo({
        ids: outcome.trashed,
        message: `${photoCount(outcome.count)} deleted.`,
      });

      if (from) {
        // A replace, so Back from the next photo does not land on the one just
        // trashed — which is a 404 now.
        navigate(next ? routes.photo(next) : routes.home(), { replace: true });
      }
      countTrashAgain();
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    }
  }

  async function performUndo() {
    if (!undo) return;
    try {
      await adminApi.restore(undo.ids);
      setUndo(null);
      // No patch: the restored photos are not in the response this page holds,
      // so a refetch is the honest answer, and the undo path is rare.
      countTrashAgain();
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restore failed.');
    }
  }

  async function saveEdit(photoId: string, edit: PhotoEdit): Promise<PublicPhoto> {
    setError(null);
    // Rejections travel to the form, which is where the message belongs.
    const { photo } = await adminApi.edit(photoId, edit);
    if (data) setPatched(upsertPhoto(data, photo));
    refetch();
    return photo;
  }

  const curation = useMemo<Curation>(
    () => ({
      selectedIds: visible.ids,
      // A plain click clears the selection and stays the anchor, the way it
      // does in a file manager: it is the one gesture that always gets out of
      // a selection gone wrong, and a shift-click after it reaches back to the
      // photo now open.
      anchorOn: (id) => setSelection(anchorOn(id)),
      toggle: (id) => setSelection(toggle(visible, id)),
      extendTo: (id) => setSelection(extendTo(visible, orderedIds, id)),
      selectAll: (ids) => setSelection((state) => addAll(state, ids)),
      trash: (id) => void startTrash({ kind: 'ids', photoIds: [id] }, id),
      edit: saveEdit,
      can: { edit: true, download: true, trash: true },
    }),
    // startTrash and saveEdit read the current render's `data` and
    // `orderedIds`, which is what these dependencies stand for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, orderedIds, data],
  );

  const nav = (
    <>
      <Link to={routes.trash()}>
        Trash{trashCount === null ? '' : ` (${trashCount})`}
      </Link>
      <a href={adminApi.exportUrl()} download>
        Export catalog
      </a>
    </>
  );

  const libraryIsEmpty = data !== null && data.total === 0 && data.undated.count === 0;

  /**
   * The trash provides its own read-only curation, so the library's selection
   * and its bar stay behind on the timeline while it is open. The confirm
   * dialog, the error line, and the undo offer below are outside this, because
   * an offer raised on the timeline must survive walking over to the trash.
   */
  const main =
    route.kind === 'page' ? (
      <TrashPage nav={nav} onChanged={countTrashAgain} />
    ) : route.kind === 'not-found' ? (
      <CurationContext.Provider value={curation}>
        <Layout nav={nav}>
          <NotFound />
        </Layout>
      </CurationContext.Provider>
    ) : (
      <CurationContext.Provider value={curation}>
        <TimelinePage
          resource={timeline}
          // A photo route must not move the page underneath the photo view.
          target={route.kind === 'photo' ? null : targetOf(route)}
          nav={nav}
          above={
            // Always large and easy to target; more prominent when there is
            // nothing in the library yet.
            <UploadPanel
              onLibraryChanged={refetch}
              emphasized={libraryIsEmpty}
              photoViewOpen={route.kind === 'photo'}
            />
          }
        />
        {route.kind === 'photo' ? (
          <PhotoPage id={route.id} timeline={timeline} />
        ) : null}

        {chosen.length > 0 ? (
          <SelectionBar
            count={chosen.length}
            onDeselectAll={() => setSelection(EMPTY_SELECTION)}
          >
            <button
              type="button"
              className="admin-danger"
              onClick={() => void startTrash({ kind: 'ids', photoIds: chosen }, null)}
            >
              Delete selected
            </button>
          </SelectionBar>
        ) : null}
      </CurationContext.Provider>
    );

  return (
    <>
      {main}

      {/* Fixed at the top, above the photo view: a delete can fail while the
          photo view is covering the page, and the reason has to be visible. */}
      {error ? (
        <p className="admin-banner admin-error" role="alert">
          {error}
        </p>
      ) : null}

      {preview ? (
        <Confirm
          preview={preview.result}
          title="Delete photos?"
          description="will move to the trash, where they are kept for 30 days."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void confirmTrash()}
          onCancel={() => setPreview(null)}
        />
      ) : null}

      {undo ? (
        /*
         * Five seconds from the moment it appears, and nothing else retires
         * it: not arrowing, not closing the photo view, not clicking a
         * heading. Advancing after a delete is itself a navigation, so a rule
         * that retired the offer on navigation would withdraw it before it
         * could be read.
         *
         * Keyed by what it would put back, so a second deletion inside those
         * five seconds raises a fresh banner for its own photos rather than
         * inheriting the old one's clock.
         */
        <UndoBanner
          key={undo.ids.join(',')}
          message={undo.message}
          onUndo={() => void performUndo()}
          onDismiss={dismissUndo}
        />
      ) : null}
    </>
  );
}
