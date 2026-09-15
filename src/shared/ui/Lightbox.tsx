import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { navigate } from './navigation.ts';
import { altTextFor } from '../validation.ts';
import { derivativeSrcSet, derivativeUrl } from '../urls.ts';
import { formatCaptureDate, formatCaptureTimeForViewer } from '../datetime.ts';
import { readApi, routes } from './api.ts';
import { canEdit, canTrash, useCuration } from './curation.ts';
import { EditForm } from './EditForm.tsx';
import type { PublicPhoto } from '../display-api.ts';

interface LightboxProps {
  photo: PublicPhoto;
  /**
   * Every photo ID in the library, in display order.
   *
   * Passing the whole list rather than a precomputed previous/next is what
   * makes rapid navigation correct. Stepping resolves the current position
   * from `window.location`, which `history.pushState` updates synchronously,
   * so a second arrow press arriving before React has re-rendered still
   * advances — where a neighbour captured in a stale render would send it
   * back to the photo already shown.
   */
  orderedIds: readonly string[];
  /**
   * Where Escape and the back link return to — the photo's own day.
   *
   * The link's words do not name it. Arrowing through the library changes
   * where "back" goes on every step, and a label that rewrote itself under the
   * cursor was more distracting than useful.
   */
  backHref: string;
  /** Runs instead of a plain navigation, so the timeline can be told where to land. */
  onClose: () => void;
  /**
   * Step to another photo without changing the route.
   *
   * The trash needs it: a trashed photo's `/photo/<id>` is a 404 by design, so
   * its listing has no routes to step between and holds the open photo in
   * local state instead. Left out, stepping navigates, and resolves its
   * position from the address bar for the reason above.
   */
  onStep?: (id: string) => void;
  /**
   * Where the picture comes from, overriding the capability URL. The trash
   * passes its short-lived signed preview; there is no `srcset` then, because
   * only the one rendition is signed.
   */
  imageSrc?: string;
  /**
   * Where a stepped-to photograph lives. Defaults to its place in the
   * library; the Recently Uploaded view passes its own route, or the first
   * arrow press would silently drop the reader out of that view.
   */
  photoHref?: (id: string) => string;
}

/** How long "Saved" stays under the actions once a save is back in the read view. */
const SAVED_NOTE_MS = 3000;

/**
 * Neighbour images already asked for, kept alive so the browser cannot collect
 * a request that has not finished — and so arrowing back and forth over the
 * same pair does not re-issue it.
 */
const preloaded = new Map<string, HTMLImageElement>();

function preload(photoId: string): void {
  if (preloaded.has(photoId)) return;
  const image = new Image();
  image.src = derivativeUrl(__WORKER_BASE_URL__, photoId, 'display-1280');
  preloaded.set(photoId, image);
}

function captureLine(photo: PublicPhoto): string | null {
  const { captureDate, captureTime } = photo;
  if (!captureDate) return null;
  const date = formatCaptureDate(captureDate);
  return captureTime ? `${date} at ${formatCaptureTimeForViewer(captureTime)}` : date;
}

/**
 * A single photo, filling the screen over the timeline.
 *
 * There is no header bar, no rules, and no "3 of 24": with the whole library
 * in one ordered list, a position within it says nothing useful, and every
 * pixel of chrome is a pixel not showing the photograph. What is left sits in
 * the corners — the way back at the top left, and at the bottom left a stack
 * of date, caption, and actions — with the photo's box running exactly
 * between them. The filename and the capture *time* live one click away, in
 * the info panel.
 *
 * It opens to read, in every context and at every width
 * (read-first-photo-view.md): the date, or "Undated"; the caption, clamped
 * with More when it runs long; and Download, Edit where the context can edit
 * this photograph, Delete where it can trash it, Restore and Delete
 * permanently in a trash, and Photo info. Edit puts the edit form in place of
 * the date and caption, hides Download and the arrows, and on a wide screen
 * slides the picture over to make room; Save or Cancel comes back. Where the
 * context shows filenames — the admin's listings and the files still
 * uploading — the filename is at the top right. There is no side panel and no
 * separate enlarged preview, because this is the enlarged preview.
 */
export function Lightbox({
  photo,
  orderedIds,
  backHref,
  onClose,
  onStep,
  imageSrc,
  photoHref = routes.photo,
}: LightboxProps) {
  const curation = useCuration();
  const editable = curation ? canEdit(curation, photo.id) : false;

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  /** The info panel and its toggle, so a pointer outside both can dismiss it. */
  const infoRef = useRef<HTMLDListElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * Which photo the info panel is open for, rather than whether it is open.
   *
   * The panel names one photograph's filename, clock time, and dimensions, so
   * arrowing to the next one has to close it. Holding the ID closes it as a
   * matter of arithmetic — no effect resetting a boolean after the fact, and
   * so no frame in which the panel describes the wrong photograph.
   */
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const showInfo = infoFor === photo.id;

  /**
   * Which photo the edit view is open for, by the same arithmetic.
   *
   * Every arrival — a step after Save or Cancel, the advance after a delete,
   * reopening a photograph — is in the read view, with no effect resetting a
   * flag (read-first-photo-view.md #17).
   */
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const editing = editable && editingFor === photo.id;

  /**
   * Which photo "Saved" is showing for. An object rather than the ID, so a
   * second save of the same photograph restarts the note's clock.
   */
  const [savedFor, setSavedFor] = useState<{ id: string } | null>(null);
  const showSaved = savedFor?.id === photo.id && !editing;

  /** Which photo's caption is expanded past its clamp; stepping collapses it. */
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === photo.id;
  /** Whether the collapsed caption is actually cut short, so More means something. */
  const [clamped, setClamped] = useState(false);

  /**
   * Where focus goes once the view has switched, because the button that
   * switched it has just unmounted: into the dialog on entering the edit view
   * — never a field, which on a phone raises the keyboard over a form not yet
   * seen — and back to Edit on leaving it.
   */
  const focusAfterSwitch = useRef<'dialog' | 'edit' | null>(null);

  /**
   * Who emailed this photograph in, asked for only when the panel is open.
   *
   * Keyed by photo id rather than held as a bare string, so arrowing to the
   * next photograph with the panel open never shows the previous one's sender
   * while the new answer is in flight. Only the admin's library asks the
   * server; every other context answers null without a request, and the fact
   * is not in the projection the page receives.
   */
  const [emailedBy, setEmailedBy] = useState<{ id: string; email: string } | null>(
    null,
  );

  useEffect(() => {
    if (!showInfo || !curation) return;
    let live = true;
    void curation
      .attribution(photo.id)
      .then((email) => {
        if (live && email) setEmailedBy({ id: photo.id, email });
      })
      // A photograph with no answer simply has no line; there is nothing here
      // worth interrupting the view for.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [showInfo, photo.id, curation]);

  const sender = emailedBy?.id === photo.id ? emailedBy.email : null;
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  /**
   * Whether the edit form is holding something that has not been saved.
   *
   * The form reports it, because only the form knows; the view acts on it,
   * because Escape is the view's, and will not leave the edit view while this
   * is true. See the key handler below.
   */
  const [dirty, setDirty] = useState(false);

  const large = photo.derivatives['display-2560'];
  const aspect = large.width / large.height;

  /**
   * Move by one position from wherever the current photo is.
   *
   * Refused outright in the edit view, where the arrows are not rendered
   * either. Stepping would leave the form behind on the photograph it was
   * for, and a caption typed into a photograph and then silently dropped is
   * worse than an arrow key that does nothing. Save or Cancel, then step.
   */
  const step = useCallback(
    (delta: number) => {
      if (editing) return;
      const currentId = onStep
        ? photo.id
        : (window.location.pathname.split('/').pop() ?? '');
      const position = orderedIds.indexOf(currentId);
      if (position === -1) return;
      const target = orderedIds[position + delta];
      if (!target) return;
      if (onStep) onStep(target);
      else navigate(photoHref(target));
    },
    [orderedIds, onStep, photo.id, editing, photoHref],
  );

  const currentPosition = orderedIds.indexOf(photo.id);
  const hasPrevious = currentPosition > 0;
  const hasNext = currentPosition !== -1 && currentPosition < orderedIds.length - 1;

  function openEditor() {
    focusAfterSwitch.current = 'dialog';
    setEditingFor(photo.id);
  }

  /** Back to the read view, from Cancel or from a save that succeeded. */
  function closeEditor(saved: boolean) {
    focusAfterSwitch.current = 'edit';
    setEditingFor(null);
    if (saved) setSavedFor({ id: photo.id });
  }

  // Move focus into the dialog when it opens, so a keyboard user is not left
  // behind on the timeline.
  useLayoutEffect(() => {
    dialogRef.current?.focus();
  }, [photo.id]);

  // And wherever the switch between reading and editing asked for, before
  // paint, so focus never rests on `body`.
  useLayoutEffect(() => {
    const target = focusAfterSwitch.current;
    focusAfterSwitch.current = null;
    if (target === 'edit') editButtonRef.current?.focus();
    else if (target === 'dialog') dialogRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (savedFor === null) return;
    const timer = window.setTimeout(() => setSavedFor(null), SAVED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [savedFor]);

  /**
   * Where the picture's left edge actually is, in pixels, published to CSS as
   * `--photo-left`.
   *
   * The bottom-left stack hangs a fixed distance off that edge, and no
   * stylesheet can find it: the margin beside the picture changes with every
   * photo and every window size. Nor is the `img` element's own box the
   * answer — it is stretched to the space available and `object-fit: contain`
   * centres the picture inside it, so the edge has to be derived from the
   * aspect ratio. A layout effect measures before paint, and the ratio comes
   * from the catalog, so nothing waits for the bitmap.
   */
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!dialog || !stage || !image) return;

    const measure = () => {
      const box = image.getBoundingClientRect();
      const shown = Math.min(box.width, box.height * aspect);
      dialog.style.setProperty(
        '--photo-left',
        `${box.left + (box.width - shown) / 2}px`,
      );
    };
    measure();

    // Watch the stage rather than the image: a picture constrained by the
    // window's height keeps its size when the window widens and only moves,
    // which an observer on the image itself would never hear about. It is
    // also what lets the stack follow the picture frame by frame while the
    // stage slides back from the edit view.
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [photo.id, aspect]);

  /*
   * Whether the caption is cut short by its clamp, so More appears only when
   * there is more.
   *
   * Measured only while collapsed — expanded, it is not clamped, and Less
   * stays — and re-measured by an observer on the caption itself, because the
   * clamp's line count changes at the breakpoint and the column's width with
   * the window.
   */
  useLayoutEffect(() => {
    const caption = captionRef.current;
    if (!caption || expanded) return;
    const measure = () => setClamped(caption.scrollHeight > caption.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(caption);
    return () => observer.disconnect();
  }, [photo.id, photo.caption, expanded, editing]);

  // A layout effect, not a passive one. Passive effects run *after* paint, so
  // with useEffect the dialog is on screen and looks interactive for a frame
  // before its key handler exists — and any key pressed in that window is
  // silently dropped.
  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const active = document.activeElement;

      /*
       * A field owns the keyboard while it has focus.
       *
       * This is a correctness rule rather than a preference: the handler is on
       * `window`, so without it ArrowLeft would change photo while the caret
       * was meant to move, and Backspace would delete the photograph instead
       * of a character. Escape leaves the field — or Save or Cancel, which are
       * in the form too; the next Escape, with focus outside the form, is
       * handled below.
       */
      if (active && formRef.current?.contains(active)) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (active instanceof HTMLElement) active.blur();
        }
        return;
      }

      // Something over the lightbox has taken focus — the confirmation dialog,
      // which focuses its own button — so the keyboard is not ours. Without
      // this, Escape would cancel the dialog *and* close the view behind it,
      // and an arrow press would move to a photo the pending token is not for.
      const dialog = dialogRef.current;
      if (active && active !== document.body && dialog && !dialog.contains(active)) {
        return;
      }

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          // Escape dismisses the innermost thing that is open: the panel, then
          // the edit view, then the photograph. It never leaves the edit view
          // over unsaved typing, which would drop it while leaving the reader
          // on the same photograph; "Unsaved changes" says why nothing
          // happened (read-first-photo-view.md #15).
          if (showInfo) {
            setInfoFor(null);
          } else if (editing) {
            if (!dirty) {
              focusAfterSwitch.current = 'edit';
              setEditingFor(null);
            }
          } else {
            onClose();
          }
          break;
        case 'ArrowLeft':
          event.preventDefault();
          step(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          step(1);
          break;
        // Triage of a bad day is Delete, confirm, Delete, confirm: the key is
        // the button, and the app advances to the next photo after each one.
        case 'Delete':
        case 'Backspace':
          if (curation && canTrash(curation, photo.id)) {
            event.preventDefault();
            curation.trash(photo.id);
          }
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, step, curation, photo.id, showInfo, editing, dirty]);

  /*
   * The info panel is a layer, so a pointer outside it dismisses it.
   *
   * A passive effect is right here: nothing about it races the paint, unlike
   * the key handler and the scroll lock beside it.
   */
  useEffect(() => {
    if (!showInfo) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Containment on the panel itself, so dragging its scrollbar — it is
      // `overflow-y: auto` under a `max-height` — does not dismiss it.
      if (infoRef.current?.contains(target)) return;
      // The toggle counts as inside, though geometrically it is not. Closing
      // here on pointerdown would leave the button's own onClick running
      // against a `showInfo` of false, reopening the panel on the very click
      // meant to close it. Excluding it leaves the toggle as the only thing
      // acting on that click.
      if (infoButtonRef.current?.contains(target)) return;
      setInfoFor(null);
    }
    // `pointerdown`, not `click`: it covers touch, and it fires at the start
    // of a drag, so selecting text in the panel and releasing over the
    // photograph is not a click outside.
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [showInfo]);

  /*
   * The page behind the lightbox must not scroll while it is open.
   *
   * A layout effect, not a passive one, for the *cleanup* rather than the
   * setup: closing asks the listing underneath to scroll to the tile just
   * left, and that runs in a layout effect too. A passive cleanup runs after
   * every layout effect in the commit, so the scroll would happen while the
   * body was still locked — which WebKit answers by scrolling to the bottom of
   * the page instead of to the tile.
   */
  useLayoutEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /**
   * Fetch the neighbours once this photo is on screen, so holding an arrow key
   * lands on a warm cache. Waiting for the current image keeps the preload
   * from competing with it for the connection; `complete` covers the case where
   * it was already cached and no load event is coming.
   *
   * Not in the trash, whose images are behind short-lived signed URLs the
   * listing minted for exactly the renditions it holds.
   */
  useEffect(() => {
    const image = imageRef.current;
    if (!image || imageSrc) return;

    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      const position = orderedIds.indexOf(photo.id);
      if (position === -1) return;
      for (const neighbour of [orderedIds[position - 1], orderedIds[position + 1]]) {
        if (neighbour) preload(neighbour);
      }
    };

    if (image.complete) {
      start();
      return;
    }
    image.addEventListener('load', start, { once: true });
    image.addEventListener('error', start, { once: true });
    return () => {
      cancelled = true;
      image.removeEventListener('load', start);
      image.removeEventListener('error', start);
    };
  }, [photo.id, orderedIds, imageSrc]);

  async function onDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      // Requested at click time: a five-minute signed link would otherwise go
      // stale while someone reads the caption.
      const link = await readApi.downloadLink(photo.id);
      window.location.assign(link.url);
    } catch {
      setDownloadError('That download link could not be created. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  const capture = captureLine(photo);
  const dateLine = photo.captureDate ? formatCaptureDate(photo.captureDate) : null;
  const alt = altTextFor(photo);

  return (
    <div
      // The form needs room the read view's narrow caption column does not,
      // so while editing the stage makes way for it; see curation.css.
      className={editing ? 'lightbox lightbox--editing' : 'lightbox'}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      ref={dialogRef}
    >
      <a
        href={backHref}
        className="lightbox__back"
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <span aria-hidden="true">&larr;</span> Lightbox
      </a>

      {/* Which file this is, without opening Photo info: an administrator
          working through a batch needs it at a glance. Never the family's
          library or trash (family-tier.md #7). */}
      {curation?.can.filename ? (
        <span className="lightbox__filename" title={photo.originalFilename}>
          {photo.originalFilename}
        </span>
      ) : null}

      <div className="lightbox__stage" ref={stageRef}>
        {/* Absent in the edit view rather than disabled: to move on, Save or
            Cancel, then step (read-first-photo-view.md #14). */}
        {editing ? null : (
          <button
            type="button"
            className="lightbox__nav lightbox__nav--previous"
            onClick={() => step(-1)}
            disabled={!hasPrevious}
            aria-label="Previous photo"
          >
            <span aria-hidden="true">&#8249;</span>
          </button>
        )}

        <img
          className="lightbox__image"
          key={photo.id}
          ref={imageRef}
          src={imageSrc ?? derivativeUrl(__WORKER_BASE_URL__, photo.id, 'display-1280')}
          srcSet={
            imageSrc
              ? undefined
              : derivativeSrcSet(__WORKER_BASE_URL__, photo.id, [
                  {
                    rendition: 'display-1280',
                    width: photo.derivatives['display-1280'].width,
                  },
                  { rendition: 'display-2560', width: large.width },
                ])
          }
          sizes={imageSrc ? undefined : '100vw'}
          width={large.width}
          height={large.height}
          alt={alt}
          decoding="async"
        />

        {editing ? null : (
          <button
            type="button"
            className="lightbox__nav lightbox__nav--next"
            onClick={() => step(1)}
            disabled={!hasNext}
            aria-label="Next photo"
          >
            <span aria-hidden="true">&#8250;</span>
          </button>
        )}
      </div>

      <div className="lightbox__foot">
        {showInfo ? (
          <dl
            className="photo-info lightbox__info"
            id="photo-information"
            ref={infoRef}
          >
            <dt>Original filename</dt>
            <dd>{photo.originalFilename}</dd>
            {curation?.can.addedFrom ? (
              <>
                {/* On every photograph the family sees, so a missing Edit and
                    Delete explain themselves (family-own-trash.md #4). */}
                <dt>Added from</dt>
                <dd>
                  {curation.addedHere(photo.id) ? 'This device' : 'Another device'}
                </dd>
              </>
            ) : null}
            {sender ? (
              <>
                {/* Only for a photograph that arrived by email, and only in
                    the admin. The address is resolved server-side against the
                    account's list; nothing about a sender is stored here. */}
                <dt>Emailed by</dt>
                <dd>{sender}</dd>
              </>
            ) : null}
            <dt>Capture date</dt>
            <dd>{capture ?? 'No date recorded'}</dd>
            {photo.captureUtcOffset ? (
              <>
                <dt>Camera UTC offset</dt>
                <dd>{photo.captureUtcOffset}</dd>
              </>
            ) : null}
            <dt>Full-size dimensions</dt>
            <dd>
              {photo.derivatives.full.width} &times; {photo.derivatives.full.height}
            </dd>
          </dl>
        ) : null}

        {/* Date, caption, and the actions are one stack, ordered by how much
            they say about the photograph. On a wide screen they share a right
            edge, which is the only alignment in the view that the photo's own
            box does not provide. In the edit view the form takes the date's
            and caption's place. */}
        <div className="lightbox__bottom">
          {editing && curation ? (
            <EditForm
              ref={formRef}
              // Remounted per photo, so no edit can survive onto another.
              key={photo.id}
              photo={photo}
              onSave={(edit) => curation.edit(photo.id, edit)}
              onSaved={() => closeEditor(true)}
              onCancel={() => closeEditor(false)}
              onDirtyChange={setDirty}
            />
          ) : (
            <div className="lightbox__meta">
              {/* First in the document, so a screen reader hears one order;
                  the wide layout lifts the caption above it with `order`. */}
              <p className="lightbox__date">{dateLine ?? 'Undated'}</p>
              {/* The only hand-written words about a photograph; they stay on
                  screen while everything else moves behind a button. */}
              {photo.caption ? (
                <div className="lightbox__caption-block">
                  <p
                    ref={captionRef}
                    id="photo-caption"
                    className={
                      expanded
                        ? 'lightbox__caption lightbox__caption--expanded'
                        : 'lightbox__caption'
                    }
                  >
                    {photo.caption}
                  </p>
                  {clamped || expanded ? (
                    <button
                      type="button"
                      className="lightbox__more"
                      aria-expanded={expanded}
                      aria-controls="photo-caption"
                      onClick={() => setExpandedFor(expanded ? null : photo.id)}
                    >
                      {expanded ? 'Less' : 'More'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {downloadError ? (
            <p className="lightbox__error" role="alert">
              {downloadError}
            </p>
          ) : null}

          <div className="lightbox__actions">
            {/* A trashed photo shows enough to be identified and nothing
                more: no download of any kind and no delete — only Restore,
                which puts it back, and in the family's trash Delete
                permanently. The admin deletes permanently from its bar, for a
                selection. The edit view has no Download either. */}
            {editing || (curation && !curation.can.download) ? null : (
              <button type="button" onClick={onDownload} disabled={downloading}>
                {downloading ? 'Preparing download…' : 'Download'}
              </button>
            )}
            {editable && !editing ? (
              <button type="button" ref={editButtonRef} onClick={openEditor}>
                Edit
              </button>
            ) : null}
            {curation && canTrash(curation, photo.id) ? (
              <button
                type="button"
                className="admin-danger"
                onClick={() => curation.trash(photo.id)}
              >
                Delete
              </button>
            ) : null}
            {curation?.can.restore ? (
              <button type="button" onClick={() => curation.restore(photo.id)}>
                Restore
              </button>
            ) : null}
            {curation?.can.purge ? (
              <button
                type="button"
                className="admin-danger"
                onClick={() => curation.purge(photo.id)}
              >
                Delete permanently
              </button>
            ) : null}
            <button
              type="button"
              ref={infoButtonRef}
              onClick={() => setInfoFor(showInfo ? null : photo.id)}
              aria-expanded={showInfo}
              aria-controls="photo-information"
            >
              Photo info
            </button>
          </div>

          {/* Here rather than in the form, which is gone by the time a save
              has succeeded. */}
          {showSaved ? (
            <p className="lightbox__saved" role="status">
              Saved
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
