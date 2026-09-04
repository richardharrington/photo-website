import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ACCEPTED_EXTENSIONS } from '../../shared/constants.ts';
import { hasAcceptedExtension } from '../../pipeline/validate.ts';
import { processFile, readSourceMetadata } from '../../pipeline/index.ts';
import { UploadQueue, isInFlight, summarize } from '../upload/queue.ts';
import type { QueueItem, QueueSnapshot } from '../upload/queue.ts';
import { PENDING_IMAGE, pendingPhoto } from '../upload/pending.ts';
import { adminApi, routes } from '../api.ts';
import { Link } from '../../shared/ui/Link.tsx';
import { PhotoGrid } from '../../shared/ui/PhotoGrid.tsx';
import { Lightbox } from '../../shared/ui/Lightbox.tsx';
import { CurationContext } from '../../shared/ui/curation.ts';
import type { Curation } from '../../shared/ui/curation.ts';

/**
 * PUT one artifact straight to R2 with its presigned URL.
 *
 * This is the only request in the app that leaves the site's origin. It is a
 * cors-mode fetch, so the browser sends a real Origin header even under
 * Referrer-Policy: no-referrer — which is what the bucket's CORS rule keys on.
 */
async function uploadArtifact(
  url: string,
  artifact: { bytes: Uint8Array; contentType: string },
): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': artifact.contentType },
    body: artifact.bytes as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}).`);
  }
}

function createQueue(): UploadQueue {
  return new UploadQueue({
    processFile: (file, options) =>
      processFile(file, {
        // Encoding dominates; report progress as each artifact lands.
        onArtifact: () => options.onProgress(0.5),
        // Already read, so the date on the tile and the date committed are
        // the same value rather than two parses expected to agree.
        metadata: options.metadata,
      }),
    readMetadata: (file) => readSourceMetadata(file, file.name),
    editPhoto: async (photoId, edit) => (await adminApi.edit(photoId, edit)).photo,
    beginBatch: () => adminApi.beginBatch(),
    prepare: (hash, filename) => adminApi.prepare(hash, filename),
    uploadArtifact,
    commit: (body) => adminApi.commit(body),
  });
}

const STATE_LABELS: Record<QueueItem['state'], string> = {
  queued: 'Waiting',
  processing: 'Processing',
  uploading: 'Uploading',
  committing: 'Finishing',
  done: 'Added',
  skipped: 'Already uploaded – skipped',
  failed: 'Failed',
};

/** Nothing is selectable here; see the curation below. */
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

interface UploadPanelProps {
  /**
   * Reload the library: a batch has landed, or an edit here has reached a
   * photo that is already in it. Awaited after a batch, so these tiles are
   * never cleared before the library holds what they stand for.
   */
  onLibraryChanged: () => void | Promise<void>;
  /** Larger and more prominent when the library is empty. */
  emphasized: boolean;
  /**
   * True while the library's photo view is covering the page. The drop target
   * stands down: a single photograph fills the screen, and a drop target
   * pinned over it would be inviting a drop onto a view that is not the
   * library.
   */
  photoViewOpen: boolean;
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
  onLibraryChanged,
  emphasized,
  photoViewOpen,
}: UploadPanelProps) {
  // Lazy state, not a ref: the queue is created once, and reading a ref
  // during render is unsafe.
  const [queue] = useState(createQueue);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => queue.snapshot());
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const wasActive = useRef(false);

  useEffect(() => queue.subscribe(setSnapshot), [queue]);

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
   * the ordinary case rather than a corner of one. Instead the two moments
   * that can make it safe each ask: the reload finishing, and the view
   * closing. Refs rather than state, because neither is anything to render.
   */
  const settled = useRef(false);
  const openIdRef = useRef<string | null>(null);
  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  const clearWhenNothingIsOpen = useCallback(() => {
    if (!settled.current || openIdRef.current !== null) return;
    settled.current = false;
    queue.clearCommitted();
  }, [queue]);

  // Reload the library once, on the edge from busy to idle, rather than on
  // every state change.
  useEffect(() => {
    if (wasActive.current && !snapshot.active) {
      void Promise.resolve(onLibraryChanged()).then(() => {
        settled.current = true;
        clearWhenNothingIsOpen();
      });
    }
    wasActive.current = snapshot.active;
  }, [snapshot.active, onLibraryChanged, clearWhenNothingIsOpen]);

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
   */
  const curation = useMemo<Curation>(
    () => ({
      selectedIds: NOTHING_SELECTED,
      anchorOn: () => {},
      toggle: () => {},
      extendTo: () => {},
      selectAll: () => {},
      trash: () => {},
      edit: async (id, edit) => {
        const item = await queue.edit(id, edit);
        // An edit that reached the stored photo changed the library, not just
        // this panel, and the library is showing it too by now.
        if (item.photoId) void onLibraryChanged();
        return pendingPhoto(item);
      },
      can: { edit: true, download: false, trash: false },
    }),
    [queue, onLibraryChanged],
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
          <p className="drop-target__headline">Drop photos here</p>
          <p className="drop-target__hint">
            or press to choose them. JPEG, PNG, and HEIC.
          </p>
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
                return (
                  <>
                    <span
                      className={
                        item.state === 'failed' ? 'admin-error' : 'upload__state'
                      }
                    >
                      {STATE_LABELS[item.state]}
                    </span>
                    {isInFlight(item.state) ? (
                      <progress
                        className="upload__progress"
                        value={item.progress}
                        max={1}
                      />
                    ) : null}
                    {item.state === 'skipped' && item.existingPhotoId ? (
                      <Link to={routes.photo(item.existingPhotoId)}>
                        View the existing photo
                      </Link>
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
          onClose={() => {
            setOpenId(null);
            openIdRef.current = null;
            clearWhenNothingIsOpen();
          }}
          onStep={setOpenId}
          // The encoded 1280 straight from memory, or the grey stand-in until
          // the encoders have got to it.
          imageSrc={open.preview?.displayUrl ?? PENDING_IMAGE}
        />
      ) : null}
    </CurationContext.Provider>
  );
}
