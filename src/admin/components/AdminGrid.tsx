import { useCallback, useEffect, useRef, useState } from 'react';
import { altTextFor } from '../../shared/validation.ts';
import { derivativeUrl } from '../../shared/urls.ts';
import {
  EMPTY_SELECTION,
  applyMarquee,
  intersects,
  isMarquee,
  rectFromPoints,
  toggle,
} from '../selection.ts';
import type { Rect, SelectionState } from '../selection.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

interface AdminGridProps {
  photos: readonly PublicPhoto[];
  selection: SelectionState;
  onSelectionChange: (selection: SelectionState) => void;
  onOpen: (photoId: string) => void;
}

/**
 * The admin grid.
 *
 * Differences from the viewer's grid, both from design.md: every thumbnail
 * shows its original filename, and the grid supports marquee and
 * modifier-click selection. A plain click opens the detail panel.
 */
export function AdminGrid({
  photos,
  selection,
  onSelectionChange,
  onOpen,
}: AdminGridProps) {
  const gridRef = useRef<HTMLUListElement>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number; additive: boolean } | null>(null);

  const hitTest = useCallback((rect: Rect): string[] => {
    const grid = gridRef.current;
    if (!grid) return [];
    const gridBox = grid.getBoundingClientRect();

    return [...grid.querySelectorAll('[data-photo-id]')]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return intersects(rect, {
          left: box.left - gridBox.left,
          top: box.top - gridBox.top,
          width: box.width,
          height: box.height,
        });
      })
      .map((node) => (node as HTMLElement).dataset['photoId']!);
  }, []);

  useEffect(() => {
    if (!marquee) return;

    function onPointerMove(event: PointerEvent) {
      const grid = gridRef.current;
      const start = dragStart.current;
      if (!grid || !start) return;
      const box = grid.getBoundingClientRect();
      setMarquee(
        rectFromPoints(start, {
          x: event.clientX - box.left,
          y: event.clientY - box.top,
        }),
      );
    }

    function onPointerUp() {
      const rect = marquee;
      const start = dragStart.current;
      dragStart.current = null;
      setMarquee(null);
      if (!rect || !start) return;

      // A short drag is a click that wobbled; clearing the selection on one
      // would make the grid feel broken.
      if (isMarquee(rect)) {
        onSelectionChange(applyMarquee(selection, hitTest(rect), start.additive));
      }
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [marquee, selection, onSelectionChange, hitTest]);

  return (
    <ul
      className="admin-grid"
      ref={gridRef}
      onPointerDown={(event) => {
        // Only a drag starting on empty grid area begins a marquee; one
        // starting on a thumbnail would fight with clicking it.
        if (event.target !== event.currentTarget) return;
        if (event.button !== 0) return;

        const box = event.currentTarget.getBoundingClientRect();
        const point = { x: event.clientX - box.left, y: event.clientY - box.top };
        dragStart.current = {
          ...point,
          additive: event.metaKey || event.ctrlKey || event.shiftKey,
        };
        setMarquee(rectFromPoints(point, point));

        if (!dragStart.current.additive) onSelectionChange(EMPTY_SELECTION);
      }}
    >
      {photos.map((photo) => {
        const selected = selection.ids.has(photo.id);
        return (
          <li key={photo.id} className="admin-grid__item">
            <button
              type="button"
              data-photo-id={photo.id}
              className={`admin-grid__tile ${
                selected ? 'admin-grid__tile--selected' : ''
              }`}
              aria-pressed={selected}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) {
                  onSelectionChange(toggle(selection, photo.id));
                  return;
                }
                onOpen(photo.id);
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

      {marquee && isMarquee(marquee) ? (
        <div
          className="admin-grid__marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      ) : null}
    </ul>
  );
}
