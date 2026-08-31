import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../../shared/ui/navigation.ts';
import { altTextFor } from '../../shared/validation.ts';
import { derivativeSrcSet, derivativeUrl } from '../../shared/urls.ts';
import {
  formatCaptureDate,
  formatCaptureTimeForViewer,
} from '../../shared/datetime.ts';
import { displayApi, routes } from '../api.ts';
import type { PhotoResponse } from '../../shared/display-api.ts';

interface LightboxProps {
  detail: PhotoResponse;
  /** Where Escape and the close button return to. */
  groupHref: string;
  groupLabel: string;
}

function captureLine(detail: PhotoResponse): string | null {
  const { captureDate, captureTime } = detail.photo;
  if (!captureDate) return null;
  const date = formatCaptureDate(captureDate);
  return captureTime ? `${date} at ${formatCaptureTimeForViewer(captureTime)}` : date;
}

export function Lightbox({ detail, groupHref, groupLabel }: LightboxProps) {
  const { photo, previousId, nextId, index, total } = detail;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const close = useCallback(() => navigate(groupHref), [groupHref]);

  const goTo = useCallback((id: string | null) => {
    if (id) navigate(routes.photo(id));
  }, []);

  // Move focus into the dialog when it opens, so a keyboard user is not left
  // behind on the grid, and arrow keys reach the handler below.
  useEffect(() => {
    dialogRef.current?.focus();
  }, [photo.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          close();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          goTo(previousId);
          break;
        case 'ArrowRight':
          event.preventDefault();
          goTo(nextId);
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, goTo, previousId, nextId]);

  // The page behind the lightbox must not scroll while it is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  async function onDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      // Requested at click time: a five-minute signed link would otherwise go
      // stale while someone reads the caption.
      const link = await displayApi.downloadLink(photo.id);
      window.location.assign(link.url);
    } catch {
      setDownloadError('That download link could not be created. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  const large = photo.derivatives['display-2560'];
  const capture = captureLine(detail);
  const alt = altTextFor(photo);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      ref={dialogRef}
    >
      <div className="lightbox__bar">
        <a
          href={groupHref}
          className="lightbox__close"
          onClick={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <span aria-hidden="true">&larr;</span> Back to {groupLabel}
        </a>
        <span className="lightbox__position">
          {index + 1} of {total}
        </span>
      </div>

      <div className="lightbox__stage">
        <button
          type="button"
          className="lightbox__nav lightbox__nav--previous"
          onClick={() => goTo(previousId)}
          disabled={previousId === null}
          aria-label="Previous photo"
        >
          <span aria-hidden="true">&#8249;</span>
        </button>

        <img
          className="lightbox__image"
          key={photo.id}
          src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'display-1280')}
          srcSet={derivativeSrcSet(__WORKER_BASE_URL__, photo.id, [
            {
              rendition: 'display-1280',
              width: photo.derivatives['display-1280'].width,
            },
            { rendition: 'display-2560', width: large.width },
          ])}
          sizes="100vw"
          width={large.width}
          height={large.height}
          alt={alt}
          decoding="async"
        />

        <button
          type="button"
          className="lightbox__nav lightbox__nav--next"
          onClick={() => goTo(nextId)}
          disabled={nextId === null}
          aria-label="Next photo"
        >
          <span aria-hidden="true">&#8250;</span>
        </button>
      </div>

      <div className="lightbox__details">
        {photo.caption ? <p className="lightbox__caption">{photo.caption}</p> : null}
        {capture ? <p className="lightbox__capture">{capture}</p> : null}

        <div className="lightbox__actions">
          <button type="button" onClick={onDownload} disabled={downloading}>
            {downloading ? 'Preparing download…' : 'Download original size'}
          </button>
          <button
            type="button"
            onClick={() => setShowInfo((shown) => !shown)}
            aria-expanded={showInfo}
            aria-controls="photo-information"
          >
            Photo information
          </button>
        </div>

        {downloadError ? (
          <p className="lightbox__error" role="alert">
            {downloadError}
          </p>
        ) : null}

        {showInfo ? (
          <dl className="photo-info" id="photo-information">
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
      </div>
    </div>
  );
}
