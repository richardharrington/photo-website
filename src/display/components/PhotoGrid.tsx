import { Link } from '../../shared/ui/Link.tsx';
import { altTextFor } from '../../shared/validation.ts';
import { derivativeUrl } from '../../shared/urls.ts';
import { routes } from '../api.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

interface PhotoGridProps {
  photos: readonly PublicPhoto[];
}

/**
 * The day grid.
 *
 * Thumbnails are `loading="lazy"`, so a long day costs one request per photo
 * actually scrolled to; larger renditions are requested only when a photo
 * opens.
 *
 * Tiles are square and crop to fill. A grid that inherited each photo's own
 * aspect ratio left rows visibly ragged, and a uniform grid also reserves its
 * space before any image arrives, so nothing reflows as thumbnails load. The
 * lightbox shows the whole uncropped photo.
 */
export function PhotoGrid({ photos }: PhotoGridProps) {
  return (
    <ul className="photo-grid">
      {photos.map((photo) => {
        const thumb = photo.derivatives.thumb;
        return (
          <li key={photo.id} className="photo-grid__item">
            <Link to={routes.photo(photo.id)} className="photo-grid__link">
              <img
                className="photo-grid__image"
                src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'thumb')}
                width={thumb.width}
                height={thumb.height}
                loading="lazy"
                decoding="async"
                alt={altTextFor(photo)}
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
