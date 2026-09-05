import type { MouseEvent, ReactNode } from 'react';
import { Link } from './Link.tsx';
import { altTextFor } from '../validation.ts';
import { derivativeUrl } from '../urls.ts';
import { routes } from './api.ts';
import { useCuration } from './curation.ts';
import type { Curation } from './curation.ts';
import type { PublicPhoto } from '../display-api.ts';

interface PhotoGridProps {
  photos: readonly PublicPhoto[];
  /**
   * Where a tile's thumbnail comes from. The default is the photo's permanent
   * capability URL; the trash overrides it, because the Worker refuses
   * capability access to a trashed photo and the listing signs one instead.
   */
  imageSrc?: (photo: PublicPhoto) => string;
  /** A second line beneath the filename. The trash's deletion dates use it. */
  note?: (photo: PublicPhoto) => ReactNode;
  /**
   * Open a photo in place rather than by navigating to its route.
   *
   * The trash needs this: a trashed photo's `/photo/<id>` is a 404 by design,
   * so there is no address to link a tile to, and its tile is a button.
   */
  open?: (photo: PublicPhoto) => void;
  /**
   * Where a tile links to. The default is the photograph's place in the
   * library; the Recently Uploaded view passes its own route, or the very
   * first click on a tile would leave the view being read.
   */
  photoHref?: (id: string) => string;
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
 * Which gesture a click on a tile is.
 *
 * The same three in the admin as in every file manager: shift extends the
 * range, the platform's toggle key (Command, or Control away from a Mac)
 * marks one photo, and a plain click clears the selection and opens the
 * photo. Both selecting gestures call `preventDefault`, so the browser does
 * not follow the tile's own link — and a plain click leaves the link alone,
 * which is what opens the photo.
 *
 * The plain-clicked tile stays the anchor: click one photo, shift-click
 * another is the commonest range there is, and without it that gesture finds
 * no anchor and marks a single tile.
 */
function onTileClick(
  curation: Curation,
  photoId: string,
  event: MouseEvent<HTMLElement>,
): void {
  if (event.shiftKey) {
    event.preventDefault();
    curation.extendTo(photoId);
  } else if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    curation.toggle(photoId);
  } else {
    curation.anchorOn(photoId);
  }
}

/**
 * The photo grid.
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
 *
 * Under a curation context the same tile also shows its original filename and
 * carries the selection's marking and gestures. The viewer's tiles never do —
 * a filename says nothing to the family, and there is nothing to select.
 */
export function PhotoGrid({
  photos,
  imageSrc,
  note,
  open,
  photoHref = routes.photo,
}: PhotoGridProps) {
  const curation = useCuration();

  return (
    <ul className="photo-grid">
      {photos.map((photo) => {
        const thumb = photo.derivatives.thumb;
        const selected = curation?.selectedIds.has(photo.id) ?? false;
        const tileClass = selected
          ? 'photo-grid__link photo-grid__link--selected'
          : 'photo-grid__link';
        const marks = curation
          ? {
              'data-photo-id': photo.id,
              'data-selected': selected ? 'true' : undefined,
            }
          : {};
        const image = (
          <img
            className="photo-grid__image"
            src={
              imageSrc
                ? imageSrc(photo)
                : derivativeUrl(__WORKER_BASE_URL__, photo.id, 'thumb')
            }
            width={thumb.width}
            height={thumb.height}
            loading="lazy"
            decoding="async"
            alt={altTextFor(photo)}
          />
        );

        return (
          <li key={photo.id} id={tileAnchor(photo.id)} className="photo-grid__item">
            {open ? (
              <button
                type="button"
                className={tileClass}
                {...marks}
                onClick={(event) => {
                  if (!curation) return;
                  onTileClick(curation, photo.id, event);
                  if (!event.defaultPrevented) open(photo);
                }}
              >
                {image}
              </button>
            ) : (
              <Link
                to={photoHref(photo.id)}
                className={tileClass}
                {...marks}
                onClick={(event) => {
                  if (curation) onTileClick(curation, photo.id, event);
                }}
              >
                {image}
              </Link>
            )}

            {/* Shown on every admin thumbnail, unlike the viewer's. */}
            {curation ? (
              <span className="photo-grid__filename" title={photo.originalFilename}>
                {photo.originalFilename}
              </span>
            ) : null}
            {note ? <span className="photo-grid__note">{note(photo)}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
