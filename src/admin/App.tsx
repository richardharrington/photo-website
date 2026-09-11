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
import { RecentPage } from '../shared/ui/RecentPage.tsx';
import { PhotoPage } from '../shared/ui/PhotoPage.tsx';
import { ViewToggle } from '../shared/ui/ViewToggle.tsx';
import { useUnseenRecent } from '../shared/ui/unseen.ts';
import { indexTimeline, recentOrderedIds } from '../shared/ui/timeline-index.ts';
import { CurationContext } from '../shared/ui/curation.ts';
import type { Curation, PhotoEdit } from '../shared/ui/curation.ts';
import {
  removePhotos,
  replacePhotosInPlace,
  upsertPhoto,
} from '../shared/timeline-patch.ts';
import { validateCaption } from '../shared/validation.ts';
import { nextAfterDeleting } from './advance.ts';
import { reverseCaptionChanges } from './caption-apply.ts';
import type { CaptionPlan } from './caption-apply.ts';
import { useDeselectGestures } from './deselect.ts';
import { adminApi, routes } from './api.ts';
import type { PreviewResult } from './api.ts';
import { Confirm, UndoBanner } from './components/Confirm.tsx';
import { CaptionApply } from './components/CaptionApply.tsx';
import type { CaptionApplyResult } from './components/CaptionApply.tsx';
import { ReplaceCaptions } from './components/ReplaceCaptions.tsx';
import { SelectionBar } from './components/SelectionBar.tsx';
import { TrashPage } from './components/TrashPage.tsx';
import { EmailsPage } from './components/EmailsPage.tsx';
import { InboxPage } from './components/InboxPage.tsx';
import { UploadPanel } from './components/Upload.tsx';
import {
  addAll,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectedIds,
  selectOnly,
  toggle,
} from './selection.ts';
import type { SelectionState } from './selection.ts';
import type { PublicPhoto, TimelineResponse } from '../shared/display-api.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';

/**
 * The admin's own top-level pages, on top of the routes both apps share.
 *
 * `recent` is not one of them: both apps have it, so the shared parser knows
 * it unconditionally.
 */
const ADMIN_PAGES = ['trash', 'emails', 'inbox'] as const;

/** Which section of the one page a route is asking for. */
function targetOf(
  route: Exclude<
    Route,
    { kind: 'not-found' | 'photo' | 'page' | 'recent' | 'recent-photo' }
  >,
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
 * What the undo banner would put back: photos sent to the trash, or the
 * captions a bulk apply replaced.
 */
type UndoOffer =
  | { kind: 'trash'; ids: string[]; message: string }
  | {
      kind: 'caption';
      /** Reversed changes: caption = what the photo had, expected = what was applied. */
      changes: { photoId: string; caption: string | null; expected: string }[];
      message: string;
    };

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
  /**
   * The one standing undo offer, for a delete or a caption apply alike, and a
   * serial number that is new every time an offer is raised — the banner's key,
   * and so its clock.
   */
  const [undo, setUndo] = useState<(UndoOffer & { serial: number }) | null>(null);
  const undoSerial = useRef(0);
  const undoing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dismissUndo = useCallback(() => setUndo(null), []);

  function offerUndo(offer: UndoOffer) {
    undoSerial.current += 1;
    setUndo({ ...offer, serial: undoSerial.current });
  }

  /** The replace-captions dialog, and how to answer the apply waiting on it. */
  const [replacing, setReplacing] = useState<{
    caption: string;
    selected: number;
    replaced: CaptionPlan['replaced'];
    decide: (confirmed: boolean) => void;
  } | null>(null);

  // Escape, and a click on the page margins, are the two ways out of a
  // selection now that a plain click makes one rather than clearing it.
  useDeselectGestures(useCallback(() => setSelection(EMPTY_SELECTION), []));

  /**
   * Which listing the reader is standing in. The Recently Uploaded view is
   * the family's page plus full curation, so everything below works there
   * unchanged — except the order it all reasons about.
   */
  const onRecent = route.kind === 'recent' || route.kind === 'recent-photo';

  /**
   * The order the selection measures in: whatever is actually on screen.
   *
   * A shift-range, the advance after a delete, and the pruning that keeps a
   * bulk action honest all take this list. In the Recently Uploaded view the
   * photographs are in a different order, and a range measured in library
   * order would quietly select photographs scattered across years and look as
   * though it had worked.
   */
  const index = useMemo(() => (data ? indexTimeline(data) : null), [data]);
  const orderedIds = useMemo(() => {
    if (!data || !index) return [];
    return onRecent ? recentOrderedIds(data) : index.orderedIds;
  }, [data, index, onRecent]);

  // Pruned on every render, never the raw state: a delete takes photos off the
  // page without touching the selection, and a bulk action must never reach a
  // photo the administrator can no longer see.
  const visible = pruneToVisible(selection, orderedIds);
  const chosen = selectedIds(visible);

  // The same photos in the order the page shows them, which is not `chosen`'s
  // order: that is the order they were clicked. The replace dialog lists them.
  const selectedPhotos: PublicPhoto[] = [];
  if (chosen.length > 0 && index) {
    for (const id of orderedIds) {
      const photo = visible.ids.has(id) ? index.photos.get(id) : undefined;
      if (photo) selectedPhotos.push(photo);
    }
  }

  const [trashKey, setTrashKey] = useState(0);
  const trash = useResource<{ count: number }>(
    (signal) => adminApi.trashCount(signal),
    [trashKey],
  );
  const trashCount = trash.status === 'ready' ? trash.data.count : null;
  const countTrashAgain = useCallback(() => setTrashKey((key) => key + 1), []);

  // The Inbox count, fetched and refetched exactly as the trash count is: it
  // is a number in the header, and every action on the Inbox page changes it.
  const [inboxKey, setInboxKey] = useState(0);
  const inbox = useResource<{ count: number }>(
    (signal) => adminApi.inboxCount(signal),
    [inboxKey],
  );
  const inboxCount = inbox.status === 'ready' ? inbox.data.count : null;
  const countInboxAgain = useCallback(() => setInboxKey((key) => key + 1), []);

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
      offerUndo({
        kind: 'trash',
        ids: outcome.trashed,
        message: `${photoCount(outcome.count)} deleted.`,
      });

      if (from) {
        // A replace, so Back from the next photo does not land on the one just
        // trashed — which is a 404 now. It stays in whichever view the delete
        // was made from.
        const photoRoute = onRecent ? routes.recentPhoto : routes.photo;
        const listing = onRecent ? routes.recent : routes.home;
        navigate(next ? photoRoute(next) : listing(), { replace: true });
      }
      countTrashAgain();
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    }
  }

  async function performUndo() {
    // Once per offer: a second click on a caption Undo would find every photo
    // already put back and report them all as changed since.
    if (!undo || undoing.current) return;
    const offer = undo;
    // Only this offer. One raised while the request was out is still standing.
    const withdraw = () =>
      setUndo((current) => (current?.serial === offer.serial ? null : current));

    undoing.current = true;
    try {
      if (offer.kind === 'trash') {
        try {
          await adminApi.restore(offer.ids);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Restore failed.');
          return;
        }
        withdraw();
        // No patch: the restored photos are not in the response this page
        // holds, so a refetch is the honest answer, and the undo path is rare.
        countTrashAgain();
        refetch();
        return;
      }

      setError(null);
      let reply: { updated: PublicPhoto[]; skipped: string[] };
      try {
        reply = await adminApi.captions(offer.changes, { undo: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Undo failed.');
        return;
      }
      patchInPlace(reply.updated);
      withdraw();
      const kept = reply.skipped.length;
      if (kept > 0) {
        setError(
          `${photoCount(kept)} had ${kept === 1 ? 'a newer caption' : 'newer captions'}` +
            ', which Undo left in place.',
        );
      }
      refetch();
    } finally {
      undoing.current = false;
    }
  }

  /** Captions change nothing about where a photo sits, so swap them in place. */
  function patchInPlace(photos: PublicPhoto[]) {
    if (photos.length === 0) return;
    // From the latest copy, not this render's: a dialog and a request stand
    // between the render that started an apply and its reply.
    setPatched((current) => {
      const base = current ?? data;
      return base ? replacePhotosInPlace(base, photos) : current;
    });
  }

  /**
   * Apply one caption to the selection (docs/specs/bulk-captions.md 6.3).
   *
   * Confirms only when a photo would lose a different caption. The request
   * carries the caption each photo was showing, and the server skips any photo
   * that no longer has it, so the dialog's list is everything that can be lost.
   */
  async function applyCaption(
    plan: CaptionPlan,
    sending: () => void,
  ): Promise<CaptionApplyResult> {
    const { caption, changes, replaced } = plan;
    if (caption === null) return 'cancelled';
    setError(null);

    const valid = validateCaption(caption);
    if (!valid.ok) {
      setError(valid.error);
      return 'failed';
    }

    // Every selected photo already says this. Nothing to send, and so nothing
    // to undo — but it is still what was asked for.
    if (changes.length === 0) return 'applied';

    if (replaced.length > 0) {
      const confirmed = await new Promise<boolean>((decide) =>
        setReplacing({ caption, selected: plan.selected, replaced, decide }),
      );
      if (!confirmed) return 'cancelled';
    }

    let reply: { updated: PublicPhoto[]; skipped: string[] };
    try {
      sending();
      reply = await adminApi.captions(changes);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That caption could not be applied.',
      );
      return 'failed';
    }

    const { updated, skipped } = reply;
    patchInPlace(updated);
    if (updated.length > 0) {
      offerUndo({
        kind: 'caption',
        changes: reverseCaptionChanges(
          changes,
          updated.map((photo) => photo.id),
        ),
        message: `Caption applied to ${photoCount(updated.length)}.`,
      });
    }
    if (skipped.length > 0) {
      const one = skipped.length === 1;
      setError(
        `${photoCount(skipped.length)} had changed since this page loaded and ` +
          `${one ? 'was' : 'were'} left alone. Apply again to include ${one ? 'it' : 'them'}.`,
      );
    }
    refetch();
    return 'applied';
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
      // A plain click narrows the selection to this photograph and stays the
      // anchor, the way it does in a file manager: it is the one gesture that
      // always gets out of a selection gone wrong, and a shift-click after it
      // reaches back to the photo just clicked.
      selectOnly: (id) => setSelection((state) => selectOnly(state, id)),
      toggle: (id) => setSelection(toggle(visible, id)),
      extendTo: (id) => setSelection(extendTo(visible, orderedIds, id)),
      selectAll: (ids) => setSelection((state) => addAll(state, ids)),
      trash: (id) => void startTrash({ kind: 'ids', photoIds: [id] }, id),
      edit: saveEdit,
      // Asked only when the info panel is opened, and only in the library:
      // the answer is a fact about how a photograph arrived, not part of the
      // page.
      attribution: (id) => adminApi.attribution(id),
      can: { edit: true, download: true, trash: true, select: true },
    }),
    // startTrash and saveEdit read the current render's `data` and
    // `orderedIds`, which is what these dependencies stand for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, orderedIds, data],
  );

  /**
   * The marker follows the admin's own uploads too, since they land in the
   * refetch like anything else. Accepted: it clears on one click, and the
   * alternative is a per-app rule for a dot.
   */
  const unseen = useUnseenRecent(data?.recent[0]?.uploadedAt ?? null, onRecent);

  const nav = (
    <>
      {/* On the trash, emails, and inbox pages neither view is current, so
          both are links. */}
      <ViewToggle
        current={route.kind === 'page' ? null : onRecent ? 'recent' : 'library'}
        unseen={unseen}
      />
      <Link to={routes.trash()}>
        Trash{trashCount === null ? '' : ` (${trashCount})`}
      </Link>
      {/* The digest, and who may send photographs in. */}
      <Link to={routes.emails()}>Emails</Link>
      <Link to={routes.inbox()}>
        Inbox{inboxCount === null ? '' : ` (${inboxCount})`}
      </Link>
      <a href={adminApi.exportUrl()} download>
        Export catalog
      </a>
    </>
  );

  const libraryIsEmpty = data !== null && data.total === 0 && data.undated.count === 0;

  // Always large and easy to target; more prominent when there is nothing in
  // the library yet. It stands down under either photo view, or it would pin
  // over the lightbox and invite a drop onto a view that is not a listing.
  const uploadPanel = (
    <UploadPanel
      onLibraryChanged={refetch}
      emphasized={libraryIsEmpty}
      photoViewOpen={route.kind === 'photo' || route.kind === 'recent-photo'}
    />
  );

  /**
   * The trash provides its own read-only curation, so the library's selection
   * and its bar stay behind on the timeline while it is open. The confirm
   * dialog, the error line, and the undo offer below are outside this, because
   * an offer raised on the timeline must survive walking over to the trash.
   */
  const main =
    route.kind === 'page' ? (
      // The three admin-only pages. `parseRoute` has already refused any name
      // that is not in ADMIN_PAGES, so there is no fourth case to fall through
      // to — and the viewer's parser is never given any of the names at all.
      route.name === 'emails' ? (
        <EmailsPage nav={nav} />
      ) : route.name === 'inbox' ? (
        <InboxPage nav={nav} onChanged={countInboxAgain} />
      ) : (
        <TrashPage nav={nav} onChanged={countTrashAgain} />
      )
    ) : route.kind === 'not-found' ? (
      <CurationContext.Provider value={curation}>
        <Layout nav={nav}>
          <NotFound />
        </Layout>
      </CurationContext.Provider>
    ) : (
      <CurationContext.Provider value={curation}>
        {/* One listing at a time and never both: a tile's element id is
            document-unique, and every scroll depends on it. The upload target
            stays on either — it is chrome, not part of a listing. */}
        {onRecent ? (
          <RecentPage
            resource={timeline}
            target={route.kind === 'recent-photo' ? null : 'top'}
            nav={nav}
            above={uploadPanel}
          />
        ) : (
          <TimelinePage
            resource={timeline}
            // A photo route must not move the page underneath the photo view.
            target={route.kind === 'photo' ? null : targetOf(route)}
            nav={nav}
            above={uploadPanel}
          />
        )}

        {route.kind === 'photo' ? (
          <PhotoPage id={route.id} timeline={timeline} />
        ) : null}
        {route.kind === 'recent-photo' ? (
          <PhotoPage
            id={route.id}
            timeline={timeline}
            orderedIds={orderedIds}
            backHref={routes.recent()}
            photoHref={routes.recentPhoto}
          />
        ) : null}

        {chosen.length > 0 ? (
          <SelectionBar
            count={chosen.length}
            onDeselectAll={() => setSelection(EMPTY_SELECTION)}
            trailing={
              <CaptionApply
                selected={selectedPhotos}
                onApply={(plan, sending) => applyCaption(plan, sending)}
              />
            }
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

      {/* Here and not inside the bar: the bar is `position: fixed` with a
          z-index, so a dialog rendered in it would be trapped beneath the
          error line and the undo offer. */}
      {replacing ? (
        <ReplaceCaptions
          caption={replacing.caption}
          selected={replacing.selected}
          replaced={replacing.replaced}
          onConfirm={() => {
            setReplacing(null);
            replacing.decide(true);
          }}
          onCancel={() => {
            setReplacing(null);
            replacing.decide(false);
          }}
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
         * The offer is a delete's or a caption apply's, and a later one of
         * either kind replaces it. Keyed by a serial number raised with each
         * offer, so a second offer inside those five seconds gets a fresh
         * clock — even a second apply to the very same photos, which a key
         * built from the photo IDs would not tell apart.
         */
        <UndoBanner
          key={undo.serial}
          message={undo.message}
          onUndo={() => void performUndo()}
          onDismiss={dismissUndo}
        />
      ) : null}
    </>
  );
}
