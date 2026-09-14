import { useMemo } from 'react';
import { useLocationPath } from '../shared/ui/navigation.ts';
import { Link } from '../shared/ui/Link.tsx';
import { routes } from '../shared/ui/api.ts';
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
import { useLibrary } from '../shared/ui/library.ts';
import { LibraryChrome } from '../shared/ui/LibraryChrome.tsx';
import { UploadPanel } from '../shared/ui/Upload.tsx';
import { TrashPage } from '../shared/ui/TrashPage.tsx';

/**
 * The family's one extra page, on top of the routes both apps share. The
 * admin's Emails and Inbox are not in it, so under this base they are a 404
 * like any other mistyped address.
 */
const FAMILY_PAGES = ['trash'] as const;

/** Nothing is ever selected here: the family app has no selection. */
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

/**
 * The family's site: the library, and the means to add to it and correct it.
 *
 * The display link is the family link (family-tier.md #1). Anyone holding it
 * can add photographs, correct any date, time, or caption, move any photograph
 * to the trash, and restore from the trash — one photograph at a time, in the
 * photo view. There is no selection: a tap on a tile opens it, exactly as it
 * always did (decision 5). What the administrator alone does — permanent
 * deletion, the Inbox, Emails, the export — is not here, and the server refuses
 * it to this link regardless of what this page shows.
 *
 * Built on the admin App's shape, and on the same `useLibrary`, so the trash
 * confirmation, the advance after a delete, the undo offer, the edit, and the
 * upload panel's reload are one implementation in both apps (decision 11).
 *
 * Whichever listing is showing stays mounted underneath the photo view rather
 * than being torn down and rebuilt around it: closing the lightbox is then a
 * reveal, not a re-render, and the page is exactly where it was left. Only ever
 * one listing is in the DOM — a tile's element id is document-unique, and both
 * scroll paths depend on it resolving to exactly one element.
 */
export function App() {
  const path = useLocationPath();
  const route = parseRoute(path, __APP_BASE__, FAMILY_PAGES);
  const onRecent = route.kind === 'recent' || route.kind === 'recent-photo';

  const library = useLibrary({ onRecent });
  const { data, timeline, orderedIds, refetch, startTrash, saveEdit } = library;
  const { trashCount, countTrashAgain } = library;

  /**
   * Curation for the family's library: edit, download, and trash, one
   * photograph at a time. No selection, so the selection members are inert
   * and `select` is false; no filename on a tile or at the photo view's
   * corner (decision 7); and no attribution, which the display API does not
   * answer, so it resolves null without a request.
   */
  const curation = useMemo<Curation>(
    () => ({
      selectedIds: NOTHING_SELECTED,
      selectOnly: () => {},
      toggle: () => {},
      extendTo: () => {},
      selectAll: () => {},
      trash: (id) => void startTrash({ kind: 'ids', photoIds: [id] }, id),
      edit: saveEdit,
      attribution: () => Promise.resolve(null),
      // The library holds no trashed photos; the trash page restores.
      restore: () => {},
      can: {
        edit: true,
        download: true,
        trash: true,
        select: false,
        restore: false,
        filename: false,
      },
    }),
    // startTrash and saveEdit read the current render's `data` and
    // `orderedIds`, which is what these dependencies stand for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedIds, data],
  );

  const unseen = useUnseenRecent(data?.recent[0]?.uploadedAt ?? null, onRecent);

  const nav = (
    <>
      {/* On the trash page neither view is current, so both are links. */}
      <ViewToggle
        current={route.kind === 'page' ? null : onRecent ? 'recent' : 'library'}
        unseen={unseen}
      />
      <Link to={routes.trash()}>
        Trash{trashCount === null ? '' : ` (${trashCount})`}
      </Link>
    </>
  );

  const libraryIsEmpty = data !== null && data.total === 0 && data.undated.count === 0;

  // The add bar stands down under either photo view, or it would pin over the
  // lightbox and invite a drop onto a view that is not a listing.
  const uploadPanel = (
    <UploadPanel
      onLibraryChanged={refetch}
      emphasized={libraryIsEmpty}
      photoViewOpen={route.kind === 'photo' || route.kind === 'recent-photo'}
    />
  );

  const main =
    route.kind === 'page' ? (
      // `parseRoute` refuses any name not in FAMILY_PAGES, so this is the trash.
      <TrashPage
        nav={nav}
        onChanged={countTrashAgain}
        selection={null}
        bar={null}
        permanentDelete={null}
        filenames={false}
      />
    ) : route.kind === 'not-found' ? (
      <CurationContext.Provider value={curation}>
        <Layout nav={nav}>
          <NotFound />
        </Layout>
      </CurationContext.Provider>
    ) : (
      <CurationContext.Provider value={curation}>
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
            // A photo route must not move the page underneath the lightbox.
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
            // The arrows traverse the recent set in its own order, and both
            // are disabled for a photograph whose sitting has aged out of it.
            orderedIds={orderedIds}
            backHref={routes.recent()}
            photoHref={routes.recentPhoto}
          />
        ) : null}
      </CurationContext.Provider>
    );

  return (
    <>
      {main}
      <LibraryChrome library={library} />
    </>
  );
}
