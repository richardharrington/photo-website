import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { altTextFor, validatePhotoEdit } from '../../shared/validation.ts';
import { formatCaptureTimeForAdmin } from '../../shared/datetime.ts';
import { derivativeSrcSet, derivativeUrl } from '../../shared/urls.ts';
import { adminApi } from '../api.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

interface DetailPanelProps {
  photo: PublicPhoto;
  onClose: () => void;
  onSaved: (photo: PublicPhoto) => void;
  onTrash: (photoId: string) => void;
}

/**
 * Per-photo curation: download, delete, date, time, caption, information.
 *
 * Download, Delete, and the [x] close all sit in the header, above the
 * preview, so no control is ever below the fold.
 *
 * Bulk metadata editing is deliberately out of scope; date, time, and caption
 * are per-photo only.
 */
export function DetailPanel({ photo, onClose, onSaved, onTrash }: DetailPanelProps) {
  const [date, setDate] = useState(photo.captureDate ?? '');
  const [time, setTime] = useState(photo.captureTime ?? '');
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  const closeZoomRef = useRef<HTMLButtonElement>(null);

  /**
   * Which photo is being shown enlarged, rather than whether one is.
   *
   * Holding the ID means a panel that switches photos underneath the overlay
   * cannot leave it showing the previous one.
   */
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const zoomed = zoomedId === photo.id;

  // Switching photos must reset the form, not carry the previous edit over.
  //
  // Keyed on the ID alone. Keying on the metadata fields too would re-run this
  // the moment a save came back with the updated record, wiping the "Saved"
  // confirmation the user was meant to see.
  const shownPhotoId = useRef(photo.id);
  useEffect(() => {
    if (shownPhotoId.current === photo.id) return;
    shownPhotoId.current = photo.id;
    setDate(photo.captureDate ?? '');
    setTime(photo.captureTime ?? '');
    setCaption(photo.caption ?? '');
    setError(null);
    setSaved(false);
  }, [photo.id, photo.captureDate, photo.captureTime, photo.caption]);

  // Escape closes the enlarged photo first, and the panel only once there is
  // no photo over it: one key, the topmost thing first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (zoomed) setZoomedId(null);
      else onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, zoomed]);

  // The page behind must not scroll under the overlay.
  useEffect(() => {
    if (!zoomed) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [zoomed]);

  // Focus follows the overlay in and back out again, so a keyboard user is
  // never left on a control that is now behind a scrim.
  useLayoutEffect(() => {
    if (zoomed) closeZoomRef.current?.focus();
    else previewRef.current?.focus();
  }, [zoomed]);

  /**
   * Click anywhere outside to close.
   *
   * A click on another thumbnail is left alone on purpose: the grid's own
   * handler switches the panel to that photo, which is one click rather than
   * the close-then-reopen a blanket rule would force. Bound on pointerdown so
   * the panel is gone before the click lands, and unsaved edits are discarded
   * silently — the same as Escape.
   *
   * There is nothing outside the panel to click on a narrow phone, where it
   * covers the viewport; `[x]` is the way out there.
   */
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      // The enlarged photo is over everything; outside it is its own business,
      // not a click outside the panel.
      if (zoomed) return;
      const target = event.target as Element | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-photo-id]')) return;
      onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose, zoomed]);

  async function save() {
    // The same validator the API runs. Checking here too means an obvious
    // mistake is caught without a round trip, not that the server trusts it.
    const validated = validatePhotoEdit({ date, time, caption });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await adminApi.edit(photo.id, {
        date: validated.value.moment.date,
        time: validated.value.moment.time,
        caption: validated.value.caption,
      });
      // Clearing the date clears the time; reflect what was actually stored
      // rather than what was typed.
      setDate(result.photo.captureDate ?? '');
      setTime(result.photo.captureTime ?? '');
      setSaved(true);
      onSaved(result.photo);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That change could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function download() {
    // Requested at click time, because the signed link lasts five minutes and
    // would go stale sitting in the page.
    try {
      const link = await adminApi.downloadLink(photo.id);
      window.location.assign(link.url);
    } catch {
      setError('That download link could not be created.');
    }
  }

  return (
    <aside
      ref={panelRef}
      className="detail"
      aria-label={`Details for ${photo.originalFilename}`}
    >
      <div className="detail__header">
        <h2 className="detail__title">{photo.originalFilename}</h2>
        {/* Every control at the top, so none of them is ever scrolled past. */}
        <div className="detail__header-actions">
          <button type="button" onClick={() => void download()}>
            Download
          </button>
          <button
            type="button"
            className="detail__delete"
            onClick={() => onTrash(photo.id)}
          >
            Delete
          </button>
          <button
            type="button"
            className="detail__close"
            onClick={onClose}
            aria-label="Close details"
          >
            [x]
          </button>
        </div>
      </div>

      {/* Neither a thumbnail nor a preview this size always settles whether a
          photograph is worth keeping, so the preview opens a bigger one. */}
      <button
        type="button"
        ref={previewRef}
        className="detail__preview-button"
        onClick={() => setZoomedId(photo.id)}
        aria-label="Show this photo larger"
      >
        <img
          className="detail__preview"
          src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'display-1280')}
          alt=""
          decoding="async"
        />
      </button>

      {zoomed ? (
        <div
          className="zoom"
          // Only a click on the backdrop itself: one that lands on the picture
          // or the [x] is not a click outside.
          onClick={(event) => {
            if (event.target === event.currentTarget) setZoomedId(null);
          }}
        >
          <div
            className="zoom__figure"
            role="dialog"
            aria-modal="true"
            aria-label={photo.originalFilename}
          >
            <img
              className="zoom__image"
              src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'display-1280')}
              srcSet={derivativeSrcSet(__WORKER_BASE_URL__, photo.id, [
                {
                  rendition: 'display-1280',
                  width: photo.derivatives['display-1280'].width,
                },
                {
                  rendition: 'display-2560',
                  width: photo.derivatives['display-2560'].width,
                },
              ])}
              sizes="92vw"
              alt={altTextFor(photo)}
              decoding="async"
            />
            <button
              type="button"
              ref={closeZoomRef}
              className="zoom__close"
              onClick={() => setZoomedId(null)}
              aria-label="Close the enlarged photo"
            >
              [x]
            </button>
          </div>
        </div>
      ) : null}

      <form
        className="detail__form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="detail__field">
          <span>Capture date</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="YYYY-MM-DD"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>

        <label className="detail__field">
          <span>Capture time</span>
          <input
            type="text"
            placeholder="HH:MM"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            // A time is meaningful only alongside a date; clearing the date
            // clears the time when the edit is saved.
            disabled={date.trim() === ''}
          />
        </label>

        <label className="detail__field">
          <span>Caption</span>
          <textarea
            rows={4}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Plain text. Line breaks are kept."
          />
        </label>

        {error ? (
          <p className="detail__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="detail__actions">
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {saved ? <span className="detail__saved">Saved</span> : null}
        </div>
      </form>

      <dl className="photo-info">
        <dt>Stored capture time</dt>
        <dd>
          {photo.captureTime ? formatCaptureTimeForAdmin(photo.captureTime) : '—'}
        </dd>
        <dt>Camera UTC offset</dt>
        <dd>{photo.captureUtcOffset ?? '—'}</dd>
        <dt>Full-size dimensions</dt>
        <dd>
          {photo.derivatives.full.width} &times; {photo.derivatives.full.height}
        </dd>
      </dl>
    </aside>
  );
}
