import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ACCEPTED_EXTENSIONS } from '../constants.ts';
import { hasAcceptedExtension } from '../../pipeline/validate.ts';
import { isInFlight, summarize } from './upload/queue.ts';
import type { QueueItem, QueueSnapshot, UploadQueue } from './upload/queue.ts';
import { createQueue } from './upload/create.ts';
import { PENDING_IMAGE, pendingPhoto } from './upload/pending.ts';
import { routes } from './api.ts';
import { Link } from './Link.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { Lightbox } from './Lightbox.tsx';
import { CurationContext } from './curation.ts';
import type { Curation } from './curation.ts';

const STATE_LABELS: Record<QueueItem['state'], string> = {
  queued: 'Waiting',
  processing: 'Processing',
  uploading: 'Uploading',
  committing: 'Finishing',
  done: 'Added',
  skipped: 'Already uploaded – skipped',
  failed: 'Failed',
};

/**
 * What a tile says about itself.
 *
 * A skipped file whose twin is in the trash is the one state the label alone
 * gets wrong: "already uploaded" sends whoever added it looking for a
 * photograph the library does not show.
 */
function stateLabel(item: QueueItem): string {
  if (item.state === 'skipped' && item.existingPhotoTrashed) {
    return 'Already uploaded, now in the trash – skipped';
  }
  return STATE_LABELS[item.state];
}

/**
 * A skipped file whose twin is in a trash this page cannot show.
 *
 * The family's trash lists only what this browser added (family-own-trash.md
 * #6), so for somebody else's photograph — or one no family browser added —
 * "Find it in the trash" would lead to a trash that does not list it, and the
 * file cannot be added again while its twin is there. This says who can bring
 * it back instead.
 */
export const DELETED_ELSEWHERE =
  'This photo was added before and then later deleted. Ask the site admin if you want it to be restored.';

/** Nothing is selectable here; see the curation below. */
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

interface UploadPanelProps {
  /** The app's add-bar queue; see `useUploads`. */
  uploads: Uploads;
  /** Larger and more prominent when the library is empty. */
  emphasized: boolean;
  /**
   * True while the library's photo view is covering the page. The drop target
   * stands down: a single photograph fills the screen, and a drop target
   * pinned over it would be inviting a drop onto a view that is not the
   * library.
   */
  photoViewOpen: boolean;
  /**
   * One line under the hints, at every width, or null. The family app passes
   * the warning that this browser cannot keep its uploader token, so what it
   * adds can be deleted only until the page closes (family-own-trash.md #9).
   */
  note: string | null;
  /**
   * Photo info's "Added from" line on these files, which are all on their way
   * in from this browser. The family's; the admin passes false.
   */
  addedFrom: boolean;
  /**
   * Whether this app's trash page lists the photograph with this ID. The
   * admin's lists everything; the family's only what this browser added. A
   * file skipped because its twin is in the trash links there only when the
   * trash will show it, and otherwise says `DELETED_ELSEWHERE`.
   */
  trashShows: (photoId: string) => boolean;
}

/** The add bar's queue as the app holds it. */
export interface Uploads {
  queue: UploadQueue;
  snapshot: QueueSnapshot;
  /**
   * The last batch has settled and the library the page holds has since been
   * reloaded with it, so the files that landed can leave the add bar.
   */
  landed: boolean;
  /** Reload the library, as an edit that reached a stored photograph needs. */
  libraryChanged: () => void | Promise<void>;
}

/**
 * The add bar's queue, for the life of the app rather than of the panel.
 *
 * The panel is rendered inside whichever listing is showing, so switching
 * between All photos and Recently added — or visiting the trash — unmounts
 * it. A queue that lived in the panel went with it: the files still on their
 * way in vanished from the add bar, the pipeline carried on in a queue nobody
 * could see, and the library was never reloaded when they landed, so a
 * photograph added a moment ago was missing until the page was refreshed.
 *
 * So the app holds the queue, and this hook watches it whether or not a panel
 * is mounted: when a batch settles it reloads the library, and only once that
 * reload has finished does it say the batch has `landed`. A batch that starts
 * again before then is not landed, so nothing can clear its tiles early.
 */
export function useUploads(onLibraryChanged: () => void | Promise<void>): Uploads {
  // Lazy state, not a ref: the queue is created once, and reading a ref
  // during render is unsafe.
  const [queue] = useState(() => createQueue());
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => queue.snapshot());
  const [landed, setLanded] = useState(false);

  const reload = useRef(onLibraryChanged);
  useEffect(() => {
    reload.current = onLibraryChanged;
  }, [onLibraryChanged]);

  useEffect(() => {
    let wasActive = queue.snapshot().active;
    /** Every start and every settle; a reload answers only the settle it followed. */
    let edges = 0;
    return queue.subscribe((next) => {
      setSnapshot(next);
      if (next.active === wasActive) return;
      wasActive = next.active;
      edges += 1;
      if (next.active) {
        setLanded(false);
        return;
      }
      const settle = edges;
      void Promise.resolve(reload.current()).then(() => {
        if (settle === edges) setLanded(true);
      });
    });
  }, [queue]);

  return { queue, snapshot, landed, libraryChanged: onLibraryChanged };
}

/**
 * Adding photographs: the drop target, and everything on its way in.
 *
 * The drop target is pinned to the top of the page rather than sitting at the
 * head of the timeline, because the timeline is one scrolling page years long
 * and a target you have to scroll back to is a target you work around. It is
 * a slim bar once there is a library to put things in, and a large panel when
 * there is not.
 *
 * Underneath it, everything dropped is a photograph already: the same grid and
 * the same photo view as the library, so a date can be corrected and a caption
 * written while the machine is still encoding. See `upload/pending.ts`.
 */
export function UploadPanel({
  uploads,
  emphasized,
  photoViewOpen,
  note,
  addedFrom,
  trashShows,
}: UploadPanelProps) {
  const { queue, snapshot, landed, libraryChanged } = uploads;
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  const items = snapshot.items;
  const showTarget = !photoViewOpen && openId === null;

  /**
   * Publish the pinned target's height to the root.
   *
   * The timeline's year and month headings pin to the top too and have to sit
   * below it — the same arrangement, and the same reasoning, as the selection
   * bar's own variable. A layout effect rather than a passive one because the
   * page is scrolled to an anchor immediately after this mounts, and that
   * scroll's margin is computed from this number.
   */
  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty('--drop-target-height', `${target.offsetHeight}px`);
    };
    publish();

    const observer = new ResizeObserver(publish);
    observer.observe(target);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--drop-target-height');
    };
  }, [showTarget]);

  /**
   * Forget the files the library now holds — but never while one of those
   * very photographs is open.
   *
   * Clearing removes the tile the photo view is showing, which unmounts the
   * view and takes any edit being typed in it with it. A batch of a hundred
   * settles long before its first photograph has been captioned, so that is
   * the ordinary case rather than a corner of one. So this waits for both: the
   * app's reload to have landed the batch, and nothing to be open here.
   * `clearCommitted` takes only files that are done, so a batch dropped since
   * loses nothing to it.
   */
  useEffect(() => {
    if (landed && openId === null) queue.clearCommitted();
  }, [landed, openId, queue]);

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      // Filter by extension here so a stray .DS_Store or .mov from a dropped
      // folder does not fill the queue with rejections.
      const accepted = [...files].filter((file) => hasAcceptedExtension(file.name));
      if (accepted.length > 0) void queue.add(accepted);
    },
    [queue],
  );

  const photos = useMemo(() => items.map(pendingPhoto), [items]);
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  /**
   * Curation for the files on their way in: editing, and nothing else.
   *
   * There is no selection because there is no bulk action to run on a file
   * that has no catalog record yet, and nothing to download or trash for the
   * same reason. What is left is the one thing these tiles exist for, which
   * the queue applies to the commit or to the stored photo depending on where
   * the file has got to.
   *
   * `select: false` is therefore what keeps these tiles opening on a single
   * click while the library's tiles below them select — the one place on the
   * page where the two rules differ, accepted because a selection here could
   * do nothing at all (decisions.md #36).
   */
  const curation = useMemo<Curation>(
    () => ({
      selectedIds: NOTHING_SELECTED,
      selectOnly: () => {},
      toggle: () => {},
      extendTo: () => {},
      selectAll: () => {},
      trash: () => {},
      edit: async (id, edit) => {
        const item = await queue.edit(id, edit);
        // An edit that reached the stored photo changed the library, not just
        // this panel, and the library is showing it too by now.
        if (item.photoId) void libraryChanged();
        return pendingPhoto(item);
      },
      // A file on its way in has no catalog record to have arrived by email.
      attribution: () => Promise.resolve(null),
      // Nothing here is in the trash to put back, or to delete permanently.
      restore: () => {},
      purge: () => {},
      // Everything here is on its way in from this browser.
      addedHere: () => addedFrom,
      can: {
        // Unconditionally, and not through `addedHere`, which is false in the
        // admin: everything here is this browser's in either app
        // (read-first-photo-view.md #23).
        edit: 'all',
        download: false,
        trash: 'none',
        select: false,
        restore: false,
        purge: false,
        addedFrom,
        // Before a thumbnail exists the filename is the only way to tell one
        // queued file from another, in either app (family-tier.md #12).
        filename: true,
      },
    }),
    [queue, libraryChanged, addedFrom],
  );

  const open = openId ? byId.get(openId) : undefined;

  return (
    <CurationContext.Provider value={curation}>
      {showTarget ? (
        <div
          ref={targetRef}
          className={[
            'drop-target',
            dragging ? 'drop-target--active' : '',
            emphasized ? 'drop-target--empty-library' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Add photos: drop files here, or press to choose them"
        >
          {/* The words follow the 40rem breakpoint, in the stylesheet
              (family-tier.md #13): a phone has nothing to drop, so there it
              is simply "Add photos". One element, one input; only the text
              changes. */}
          <p className="drop-target__headline drop-target__headline--wide">
            Drop photos here
          </p>
          <p className="drop-target__hint drop-target__hint--wide">
            or press to choose them. JPEG, PNG, and HEIC.
          </p>
          <p className="drop-target__headline drop-target__headline--narrow">
            Add photos
          </p>
          <p className="drop-target__hint drop-target__hint--narrow">
            JPEG, PNG, and HEIC.
          </p>
          {note === null ? null : <p className="drop-target__note">{note}</p>}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS.join(',')}
            className="drop-target__input"
            onChange={(event) => {
              addFiles(event.target.files);
              // Allow re-selecting the same files, which is the documented way
              // to resume an interrupted batch.
              event.target.value = '';
            }}
          />
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="timeline upload__pending">
          <section className="timeline__year">
            {/* The library's own heading treatment, so what is arriving reads
                as part of the same page rather than a progress dialog. */}
            <h2 className="timeline__year-heading">
              <span className="timeline__anchor">
                <span>{snapshot.active ? 'Uploading' : 'Uploaded'}</span>
                <span className="timeline__count" aria-live="polite">
                  {snapshot.active
                    ? `${items.length} file${items.length === 1 ? '' : 's'}`
                    : summarize(snapshot)}
                </span>
              </span>
              {snapshot.active ? null : (
                <button
                  type="button"
                  className="timeline__select-all"
                  onClick={() => queue.clear()}
                >
                  Clear
                </button>
              )}
            </h2>

            <PhotoGrid
              photos={photos}
              imageSrc={(photo) =>
                byId.get(photo.id)?.preview?.thumbUrl ?? PENDING_IMAGE
              }
              note={(photo) => {
                const item = byId.get(photo.id);
                if (!item) return null;
                if (
                  item.state === 'skipped' &&
                  item.existingPhotoTrashed &&
                  item.existingPhotoId !== undefined &&
                  !trashShows(item.existingPhotoId)
                ) {
                  // No link: the trash this page can reach does not list it.
                  return <span className="upload__state">{DELETED_ELSEWHERE}</span>;
                }
                return (
                  <>
                    <span
                      className={
                        item.state === 'failed' ? 'admin-error' : 'upload__state'
                      }
                    >
                      {stateLabel(item)}
                    </span>
                    {isInFlight(item.state) ? (
                      <progress
                        className="upload__progress"
                        value={item.progress}
                        max={1}
                      />
                    ) : null}
                    {item.state === 'skipped' && item.existingPhotoId ? (
                      // A trashed photo has no `/photo/<id>` address — that
                      // route is a 404 by design — so the only honest link is
                      // to the trash, where it can be found and restored.
                      item.existingPhotoTrashed ? (
                        <Link to={routes.trash()}>Find it in the trash</Link>
                      ) : (
                        <Link to={routes.photo(item.existingPhotoId)}>
                          View the existing photo
                        </Link>
                      )
                    ) : null}
                    {item.state === 'failed' ? (
                      <>
                        <span className="admin-error">{item.error}</span>
                        <button type="button" onClick={() => void queue.retry(item.id)}>
                          Retry
                        </button>
                      </>
                    ) : null}
                  </>
                );
              }}
              // No route to link to: there is no catalog record yet, so these
              // open in place the way the trash's tiles do.
              open={(photo) => setOpenId(photo.id)}
            />
          </section>
        </div>
      ) : null}

      {open ? (
        <Lightbox
          photo={pendingPhoto(open)}
          orderedIds={ids}
          backHref={routes.home()}
          onClose={() => setOpenId(null)}
          onStep={setOpenId}
          // The encoded 1280 straight from memory, or the grey stand-in until
          // the encoders have got to it.
          imageSrc={open.preview?.displayUrl ?? PENDING_IMAGE}
        />
      ) : null}
    </CurationContext.Provider>
  );
}
