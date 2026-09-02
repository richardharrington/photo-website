import { altTextFor } from '../../shared/validation.ts';
import { derivativeUrl } from '../../shared/urls.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

interface AdminGridProps {
  photos: readonly PublicPhoto[];
  /** The photo the detail panel is showing, if any. Marked in the grid. */
  openPhotoId: string | null;
  /** The photos a bulk delete would cover. */
  selectedIds: ReadonlySet<string>;
  /** Plain click: open the detail panel, and drop whatever was selected. */
  onOpen: (photoId: string) => void;
  /** Modifier-click: add or remove this one photo. */
  onToggle: (photoId: string) => void;
  /** Shift-click: select everything from the anchor to this photo. */
  onExtend: (photoId: string) => void;
}

/**
 * The admin grid.
 *
 * Two differences from the viewer's grid: every thumbnail shows its original
 * filename (design.md), and the tile is a button rather than a link. The
 * masonry layout is shared; see PhotoGrid for why.
 *
 * A plain click opens the detail panel and clears the selection. Holding the
 * platform's toggle key (Command, or Control away from a Mac) selects instead,
 * and Shift extends the selection from the last tile toggled — the gestures
 * every file manager uses. Masonry runs top to bottom within a column, so a
 * shift-range is not always the rectangle it looks like; the selected tiles
 * say plainly what it caught, and a plain click starts over.
 */
export function AdminGrid({
  photos,
  openPhotoId,
  selectedIds,
  onOpen,
  onToggle,
  onExtend,
}: AdminGridProps) {
  return (
    <ul className="admin-grid">
      {photos.map((photo) => {
        const open = photo.id === openPhotoId;
        const selected = selectedIds.has(photo.id);
        return (
          <li key={photo.id} className="admin-grid__item">
            <button
              type="button"
              data-photo-id={photo.id}
              data-selected={selected ? 'true' : undefined}
              className={`admin-grid__tile ${open ? 'admin-grid__tile--open' : ''} ${
                selected ? 'admin-grid__tile--selected' : ''
              }`}
              aria-expanded={open}
              onClick={(event) => {
                if (event.shiftKey) onExtend(photo.id);
                else if (event.metaKey || event.ctrlKey) onToggle(photo.id);
                else onOpen(photo.id);
              }}
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
