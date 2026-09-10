import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { Link } from './Link.tsx';
import { altTextFor } from '../validation.ts';
import { derivativeUrl } from '../urls.ts';
import { routes } from './api.ts';
import { navigate } from './navigation.ts';
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
 * What a tile's tooltip says where a click selects. The gesture is not one the
 * tiles can show, so it is written down — here and in each listing's own
 * intro line, which is the half of it that touch can read.
 */
const SELECTING_TILE_TITLE = 'Click to select. Double-click to open.';

/**
 * About the length of a system long-press, and how far a finger may drift
 * before the press is a scroll instead. The grid is one page years long, so a
 * press that becomes a scroll must open nothing.
 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

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
 * Which gesture a click on a tile is, in a listing that selects.
 *
 * The same three as in every file manager: shift extends the range, the
 * platform's toggle key (Command, or Control away from a Mac) marks one photo,
 * and a plain click makes this photograph the whole selection. All three
 * `preventDefault`, including the plain one — that is what stops the tile's own
 * anchor from navigating, and it is why a single click no longer opens.
 *
 * The clicked tile becomes the anchor in every case, the plain click included:
 * click one photo, shift-click another is the commonest range there is, and
 * without it that gesture finds no anchor and marks a single tile.
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
    event.preventDefault();
    curation.selectOnly(photoId);
  }
}

/**
 * Enter opens, Space selects.
 *
 * Both keys also arrive at `onClick` as a click — with `detail === 0`, which is
 * how that handler tells them from a mouse and stands aside — so the keyboard
 * is decided here. Space must be `preventDefault`ed or the page scrolls.
 *
 * `open` is `null` on the library's tiles, which are real anchors: Enter there
 * is left to the browser, which follows the tile's own `href`. That is the
 * whole reason the tiles are anchors rather than buttons, and it keeps a
 * photograph's URL copyable, middle-clickable, and openable in a new tab.
 */
function onTileKeyDown(
  curation: Curation,
  photoId: string,
  event: KeyboardEvent<HTMLElement>,
  open: (() => void) | null,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  if (event.key === ' ') {
    event.preventDefault();
    curation.selectOnly(photoId);
  } else if (event.key === 'Enter' && open) {
    event.preventDefault();
    open();
  }
}

/**
 * Long-press to open, on touch only.
 *
 * Touch gets both actions this way: a tap selects, a press opens. Double-tap is
 * not available — it fights the browser's zoom gesture — and there is no
 * modifier on a touchscreen, so without this an iPad could open a photograph
 * and never select one.
 *
 * Everything here is about *not* firing. The grid is a long scrolling list, so
 * the press is abandoned as soon as the finger drifts past a slop radius, on
 * `pointerup`, on `pointercancel`, and on any scroll — `pointercancel` alone
 * does not reliably arrive, and a press that turns into a scroll and opens a
 * photograph is what makes long-press feel broken.
 *
 * One press at a time, so one ref covers the whole grid.
 */
function useLongPress(enabled: boolean) {
  /**
   * The press in flight. Its `abandon` carries both the timer and the scroll
   * listener away — an `AbortController` rather than a matching
   * `removeEventListener`, so nothing has to hold on to the listener's own
   * identity to take it off again.
   */
  const pending = useRef<{ x: number; y: number; abandon: () => void } | null>(null);
  /** A press that opened; the `click` behind it must not also select. */
  const fired = useRef(false);
  /** A finger is down, which is how `contextmenu` tells iOS's callout from a
      right-click on a mouse — the latter must keep working. */
  const touching = useRef(false);

  const cancel = useCallback(() => {
    const press = pending.current;
    if (!press) return;
    pending.current = null;
    press.abandon();
  }, []);

  // A tile can be unmounted mid-press by a refetch; the timer must go with it.
  useEffect(() => cancel, [cancel]);

  return {
    /** True once, for the click that a press which opened leaves behind. */
    consume(): boolean {
      const opened = fired.current;
      fired.current = false;
      return opened;
    },
    onPointerDown(event: PointerEvent<HTMLElement>, open: () => void): void {
      if (!enabled || event.pointerType !== 'touch') return;
      cancel();
      touching.current = true;
      fired.current = false;
      const { clientX: x, clientY: y } = event;
      const timer = window.setTimeout(() => {
        cancel();
        fired.current = true;
        open();
      }, LONG_PRESS_MS);
      const listening = new AbortController();
      // Capturing, so a scroll on any container counts, not just the window.
      window.addEventListener('scroll', cancel, {
        capture: true,
        signal: listening.signal,
      });
      pending.current = {
        x,
        y,
        abandon: () => {
          window.clearTimeout(timer);
          listening.abort();
        },
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>): void {
      const press = pending.current;
      if (!press) return;
      if (
        Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP_PX
      ) {
        cancel();
      }
    },
    onPointerEnd(): void {
      touching.current = false;
      cancel();
    },
    /**
     * iOS raises its own link-and-image sheet on the press we are using, which
     * would cover the gesture. Refused only while a finger is down, so a
     * right-click on a mouse still reaches Open in New Tab.
     */
    onContextMenu(event: MouseEvent<HTMLElement>): void {
      if (touching.current) event.preventDefault();
    },
  };
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
 * carries the selection's marking. The viewer's tiles never do — a filename
 * says nothing to the family, and there is nothing to select.
 *
 * Which gestures a tile has is `can.select`, not the presence of a context
 * (decisions.md #78). Where it is true — the library, Recently added, the
 * trash — a click selects and a double-click, a long-press, or Enter opens.
 * Where it is false, and in the viewer, a single click opens exactly as it
 * always has: the files still uploading have nothing to select, so their tiles
 * keep the old rule on the same screen as the library's new one.
 */
export function PhotoGrid({
  photos,
  imageSrc,
  note,
  open,
  photoHref = routes.photo,
}: PhotoGridProps) {
  const curation = useCuration();
  const selects = curation?.can.select ?? false;
  const press = useLongPress(selects);

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

        /** Opening this photograph, whichever way this listing does it. */
        const openPhoto = open
          ? () => open(photo)
          : () => navigate(photoHref(photo.id));

        /**
         * The gestures a selecting tile adds. Absent entirely without
         * `can.select`, so the viewer's and the upload panel's tiles carry no
         * handler at all rather than one that checks a flag and returns.
         */
        const gestures =
          selects && curation
            ? {
                title: SELECTING_TILE_TITLE,
                // Native `dblclick`, so it respects the system's own
                // double-click speed; a hand-rolled timer would not. Only the
                // unmodified gesture opens: two quick Command-clicks on one
                // tile are a mark and an unmark, not a request to open, and a
                // modifier's job here is building a selection.
                onDoubleClick: (event: MouseEvent<HTMLElement>) => {
                  if (
                    event.shiftKey ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  openPhoto();
                },
                onKeyDown: (event: KeyboardEvent<HTMLElement>) =>
                  onTileKeyDown(curation, photo.id, event, open ? openPhoto : null),
                onPointerDown: (event: PointerEvent<HTMLElement>) =>
                  press.onPointerDown(event, openPhoto),
                onPointerMove: press.onPointerMove,
                onPointerUp: press.onPointerEnd,
                onPointerCancel: press.onPointerEnd,
                onContextMenu: press.onContextMenu,
              }
            : {};

        /**
         * A selecting tile only ever selects on a single click. Keyboard
         * activation reaches here as a click too (`detail === 0`), and
         * `onKeyDown` above owns those.
         */
        const onClick = (event: MouseEvent<HTMLElement>) => {
          if (!selects || !curation) {
            if (open) open(photo);
            return;
          }
          if (press.consume()) {
            event.preventDefault();
            return;
          }
          if (event.detail === 0) return;
          onTileClick(curation, photo.id, event);
        };

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
                {...gestures}
                onClick={onClick}
              >
                {image}
              </button>
            ) : (
              <Link
                to={photoHref(photo.id)}
                className={tileClass}
                {...marks}
                {...gestures}
                onClick={onClick}
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
