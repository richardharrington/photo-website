import { Link } from './Link.tsx';
import { altTextFor } from '../validation.ts';
import { derivativeUrl } from '../urls.ts';
import { routes } from './api.ts';
import type { PublicPhoto } from '../display-api.ts';

interface PhotoGridProps {
  photos: readonly PublicPhoto[];
}

/**
 * The element ID of a photo's tile.
 *
 * Closing the photo view scrolls to this rather than to the day's heading, so
 * a photo reached by arrowing deep into a long day is where it was left.
 */
export function tileAnchor(photoId: string): string {
  return `photo-${photoId}`;
}

/**
 * The day grid.
 *
 * Thumbnails are `loading="lazy"`, so a long day costs one request per photo
 * actually scrolled to; larger renditions are requested only when a photo
 * opens.
 *
 * Tiles keep each photo's own aspect ratio and are laid out as masonry. They
 * were square and cropped to fill, which kept rows aligned but cut the top and
 * bottom off every portrait photo — on a phone camera roll that is most of
 * them, and a beheaded thumbnail is worse than an uneven column.
 *
 * The layout is CSS columns rather than a grid, so nothing is left with the
 * dead space a grid puts under a short tile in a tall row. It does mean the
 * photos read down a column rather than across a row, which is tolerable
 * because each day is its own section.
 *
 * Space is still reserved before any image arrives: the width and height
 * attributes on the element give the browser the ratio up front, so the
 * layout does not reflow as thumbnails load.
 */
export function PhotoGrid({ photos }: PhotoGridProps) {
  return (
    <ul className="photo-grid">
      {photos.map((photo) => {
        const thumb = photo.derivatives.thumb;
        return (
          <li key={photo.id} id={tileAnchor(photo.id)} className="photo-grid__item">
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
