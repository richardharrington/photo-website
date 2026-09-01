import { altTextFor } from '../../shared/validation.ts';
import { derivativeUrl } from '../../shared/urls.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

interface AdminGridProps {
  photos: readonly PublicPhoto[];
  /** The photo the detail panel is showing, if any. Marked in the grid. */
  openPhotoId: string | null;
  onOpen: (photoId: string) => void;
}

/**
 * The admin grid.
 *
 * Two differences from the viewer's grid: every thumbnail shows its original
 * filename (design.md), and the tile is a button rather than a link. The
 * masonry layout is shared; see PhotoGrid for why. A click opens the detail panel, and that is
 * the only thing a click does — see selection.ts for why the marquee and
 * modifier-click selection that used to live here is gone.
 */
export function AdminGrid({ photos, openPhotoId, onOpen }: AdminGridProps) {
  return (
    <ul className="admin-grid">
      {photos.map((photo) => {
        const open = photo.id === openPhotoId;
        return (
          <li key={photo.id} className="admin-grid__item">
            <button
              type="button"
              data-photo-id={photo.id}
              className={`admin-grid__tile ${open ? 'admin-grid__tile--open' : ''}`}
              aria-expanded={open}
              onClick={() => onOpen(photo.id)}
            >
              <img
                className="admin-grid__image"
                src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'thumb')}
                width={photo.derivatives.thumb.width}
                height={photo.derivatives.thumb.height}
                loading="lazy"
                decoding="async"
                alt={altTextFor(photo)}
              />
            </button>
            {/* Shown on every admin thumbnail, unlike the viewer's grid. */}
            <span className="admin-grid__filename" title={photo.originalFilename}>
              {photo.originalFilename}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
