import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { navigate } from './navigation.ts';
import { altTextFor } from '../validation.ts';
import { derivativeSrcSet, derivativeUrl } from '../urls.ts';
import { formatCaptureDate, formatCaptureTimeForViewer } from '../datetime.ts';
import { readApi, routes } from './api.ts';
import { useCuration } from './curation.ts';
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
}

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
 * of caption, date, and the two actions — with the photo's box running exactly
 * between them. The filename and the capture *time* live one click away, in
 * the info panel.
 *
 * This is also the admin's editing view, and the whole of it: under a curation
 * context the bottom-left stack holds the date, time, and caption as fields
 * with a Save button, the action row gains Delete, and the filename shows at
 * the top right. There is no side panel and no separate enlarged preview,
 * because this is the enlarged preview.
 */
export function Lightbox({
  photo,
  orderedIds,
  backHref,
  onClose,
  onStep,
  imageSrc,
}: LightboxProps) {
  const curation = useCuration();
  const editable = curation !== null && !curation.readOnly;

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
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
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const large = photo.derivatives['display-2560'];
  const aspect = large.width / large.height;

  /** Move by one position from wherever the current photo is. */
  const step = useCallback(
    (delta: number) => {
      const currentId = onStep
        ? photo.id
        : (window.location.pathname.split('/').pop() ?? '');
      const position = orderedIds.indexOf(currentId);
      if (position === -1) return;
      const target = orderedIds[position + delta];
      if (!target) return;
      if (onStep) onStep(target);
      else navigate(routes.photo(target));
    },
    [orderedIds, onStep, photo.id],
  );

  const currentPosition = orderedIds.indexOf(photo.id);
  const hasPrevious = currentPosition > 0;
  const hasNext = currentPosition !== -1 && currentPosition < orderedIds.length - 1;

  // Move focus into the dialog when it opens, so a keyboard user is not left
  // behind on the timeline.
  useLayoutEffect(() => {
    dialogRef.current?.focus();
  }, [photo.id]);

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
    // which an observer on the image itself would never hear about.
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [photo.id, aspect]);

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
       * of a character. Escape leaves the field; a second Escape, with focus
       * outside the form, closes the view.
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
          onClose();
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
          if (editable && curation) {
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
  }, [onClose, step, editable, curation, photo.id]);

  // The page behind the lightbox must not scroll while it is open.
  useEffect(() => {
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
      // The form needs room the viewer's narrow caption column does not, so
      // the stage makes way for it; see admin.css.
      className={editable ? 'lightbox lightbox--editing' : 'lightbox'}
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
          working through a batch needs it at a glance. */}
      {curation ? (
        <span className="lightbox__filename" title={photo.originalFilename}>
          {photo.originalFilename}
        </span>
      ) : null}

      <div className="lightbox__stage" ref={stageRef}>
        <button
          type="button"
          className="lightbox__nav lightbox__nav--previous"
          onClick={() => step(-1)}
          disabled={!hasPrevious}
          aria-label="Previous photo"
        >
          <span aria-hidden="true">&#8249;</span>
        </button>

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

        <button
          type="button"
          className="lightbox__nav lightbox__nav--next"
          onClick={() => step(1)}
          disabled={!hasNext}
          aria-label="Next photo"
        >
          <span aria-hidden="true">&#8250;</span>
        </button>
      </div>

      <div className="lightbox__foot">
        {showInfo ? (
          <dl className="photo-info lightbox__info" id="photo-information">
            <dt>Original filename</dt>
            <dd>{photo.originalFilename}</dd>
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

        {/* Caption, date, and the actions are one stack, ordered by how much
            they say about the photograph. On a wide screen they share a right
            edge, which is the only alignment in the view that the photo's own
            box does not provide. In the admin the caption and date are the
            edit form's own fields, in the same place. */}
        <div className="lightbox__bottom">
          {editable && curation ? (
            <EditForm
              ref={formRef}
              // Remounted per photo, so no edit can survive an arrow press.
              key={photo.id}
              photo={photo}
              onSave={(edit) => curation.edit(photo.id, edit)}
            />
          ) : photo.caption || dateLine ? (
            <div className="lightbox__meta">
              {/* The only hand-written words about a photograph; they stay on
                  screen while everything else moves behind a button. */}
              {photo.caption ? (
                <p className="lightbox__caption">{photo.caption}</p>
              ) : null}
              {dateLine ? <p className="lightbox__date">{dateLine}</p> : null}
            </div>
          ) : null}

          {downloadError ? (
            <p className="lightbox__error" role="alert">
              {downloadError}
            </p>
          ) : null}

          <div className="lightbox__actions">
            {/* A trashed photo shows enough to be identified and nothing
                more: no download of any kind, and no second delete here — the
                trash's own bar owns Restore and Delete permanently. */}
            {curation?.readOnly ? null : (
              <button type="button" onClick={onDownload} disabled={downloading}>
                {downloading ? 'Preparing download…' : 'Download'}
              </button>
            )}
            {editable && curation ? (
              <button
                type="button"
                className="admin-danger"
                onClick={() => curation.trash(photo.id)}
              >
                Delete
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setInfoFor(showInfo ? null : photo.id)}
              aria-expanded={showInfo}
              aria-controls="photo-information"
            >
              Photo info
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
