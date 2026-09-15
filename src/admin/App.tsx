import { useCallback, useMemo, useState } from 'react';
import { useLocationPath } from '../shared/ui/navigation.ts';
import { Link } from '../shared/ui/Link.tsx';
import { useResource } from '../shared/ui/useResource.ts';
import { parseRoute } from '../shared/ui/routes.ts';
import { Layout } from '../shared/ui/Layout.tsx';
import { NotFound } from '../shared/ui/States.tsx';
import { TimelinePage, targetOf } from '../shared/ui/TimelinePage.tsx';
import { RecentPage } from '../shared/ui/RecentPage.tsx';
import { PhotoPage } from '../shared/ui/PhotoPage.tsx';
import { ViewToggle } from '../shared/ui/ViewToggle.tsx';
import { useUnseenRecent } from '../shared/ui/unseen.ts';
import { CurationContext } from '../shared/ui/curation.ts';
import type { Curation } from '../shared/ui/curation.ts';
import { photoCount, useLibrary } from '../shared/ui/library.ts';
import { LibraryChrome } from '../shared/ui/LibraryChrome.tsx';
import { UploadPanel, useUploads } from '../shared/ui/Upload.tsx';
import { validateCaption } from '../shared/validation.ts';
import { reverseCaptionChanges } from './caption-apply.ts';
import type { CaptionPlan } from './caption-apply.ts';
import { useDeselectGestures } from './deselect.ts';
import { adminApi, routes } from './api.ts';
import { CaptionApply } from './components/CaptionApply.tsx';
import type { CaptionApplyResult } from './components/CaptionApply.tsx';
import { ReplaceCaptions } from './components/ReplaceCaptions.tsx';
import { SelectionBar } from './components/SelectionBar.tsx';
import { AdminTrashPage } from './components/AdminTrashPage.tsx';
import { EmailsPage } from './components/EmailsPage.tsx';
import { InboxPage } from './components/InboxPage.tsx';
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
import type { PublicPhoto } from '../shared/display-api.ts';

/**
 * The admin's own top-level pages, on top of the routes both apps share.
 *
 * `recent` is not one of them: both apps have it, so the shared parser knows
 * it unconditionally.
 */
const ADMIN_PAGES = ['trash', 'emails', 'inbox'] as const;

/**
 * The admin site: the family's site, plus selection and the pages only the
 * administrator has.
 *
 * One request, one page, the same pages the family sees. The library and every
 * flow that changes it — the trash confirmation, the advance after a delete,
 * the undo offer, the edit, the upload panel's reload — are the shared
 * `useLibrary`, exactly as the family app uses it (family-tier.md #11). What
 * this component adds is the selection and its bar, the caption apply and its
 * replace dialog, the Inbox count, and the Emails, Inbox, and Export links.
 */
export function App() {
  const path = useLocationPath();
  const route = parseRoute(path, __APP_BASE__, ADMIN_PAGES);

  /**
   * Which listing the reader is standing in. The Recently Uploaded view is
   * the family's page plus full curation, so everything below works there
   * unchanged — except the order it all reasons about.
   */
  const onRecent = route.kind === 'recent' || route.kind === 'recent-photo';

  const library = useLibrary({ onRecent });
  const {
    data,
    timeline,
    index,
    orderedIds,
    refetch,
    setError,
    patchInPlace,
    offerUndo,
    startTrash,
    saveEdit,
    trashCount,
    trashRevision,
    trashChanged,
  } = library;
  // Here rather than in the add bar, which unmounts with each listing.
  const uploads = useUploads(refetch);

  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);

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

  // Pruned on every render, never the raw state: a delete takes photos off the
  // page without touching the selection, and a bulk action must never reach a
  // photo the administrator can no longer see. `orderedIds` is the order on
  // screen, so a shift-range in the recent view stays inside it.
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

  // The Inbox count, fetched and refetched exactly as the trash count is: it
  // is a number in the header, and every action on the Inbox page changes it.
  const [inboxKey, setInboxKey] = useState(0);
  const inbox = useResource<{ count: number }>(
    (signal) => adminApi.inboxCount(signal),
    [inboxKey],
  );
  const inboxCount = inbox.status === 'ready' ? inbox.data.count : null;
  const countInboxAgain = useCallback(() => setInboxKey((key) => key + 1), []);

  /**
   * Put back the captions an apply replaced. The undo offer's own guard keeps
   * this to once per offer; a rejection leaves the offer standing.
   */
  async function undoCaptions(changes: ReturnType<typeof reverseCaptionChanges>) {
    setError(null);
    let reply: { updated: PublicPhoto[]; skipped: string[] };
    try {
      reply = await adminApi.captions(changes, { undo: true });
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('Undo failed.', { cause });
    }
    patchInPlace(reply.updated);
    const kept = reply.skipped.length;
    if (kept > 0) {
      setError(
        `${photoCount(kept)} had ${kept === 1 ? 'a newer caption' : 'newer captions'}` +
          ', which Undo left in place.',
      );
    }
    refetch();
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
      const reversed = reverseCaptionChanges(
        changes,
        updated.map((photo) => photo.id),
      );
      offerUndo({
        message: `Caption applied to ${photoCount(updated.length)}.`,
        perform: () => undoCaptions(reversed),
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
      // The library holds no trashed photos; the trash page restores.
      restore: () => {},
      // Its trash page deletes permanently, from the selection bar.
      purge: () => {},
      // The admin trashes anything, and never records what it added.
      addedHere: () => false,
      can: {
        edit: 'all',
        download: true,
        trash: 'all',
        select: true,
        restore: false,
        purge: false,
        // The admin records nothing about what it added; see `Capabilities`.
        addedFrom: false,
        filename: true,
      },
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
      uploads={uploads}
      emphasized={libraryIsEmpty}
      photoViewOpen={route.kind === 'photo' || route.kind === 'recent-photo'}
      note={null}
      addedFrom={false}
      // The admin's trash lists every trashed photograph.
      trashShows={() => true}
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
      // to.
      route.name === 'emails' ? (
        <EmailsPage nav={nav} />
      ) : route.name === 'inbox' ? (
        <InboxPage nav={nav} onChanged={countInboxAgain} onLibraryChanged={refetch} />
      ) : (
        <AdminTrashPage nav={nav} onChanged={trashChanged} revision={trashRevision} />
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

      <LibraryChrome library={library} />

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
    </>
  );
}
