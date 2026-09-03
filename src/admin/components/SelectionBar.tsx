import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface SelectionBarProps {
  count: number;
  /** The actions for this page: Delete selected, or Restore and Delete permanently. */
  children: ReactNode;
  onDeselectAll: () => void;
}

/**
 * What a bulk action would cover, and the actions themselves.
 *
 * Pinned to the top of the viewport and present only while something is
 * selected, so the page carries no toolbar of buttons with nothing to act on
 * (decisions.md #36) — with nothing selected there is no bar at all.
 *
 * It publishes its own height to the root as `--selection-bar-height` while
 * it is shown, because the timeline's year and month headings pin to the top
 * too and have to move down out from under it. Measured rather than declared:
 * the bar wraps on a narrow window, and a number written twice is a number
 * that disagrees with itself.
 */
export function SelectionBar({ count, children, onDeselectAll }: SelectionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty('--selection-bar-height', `${bar.offsetHeight}px`);
    };
    publish();

    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--selection-bar-height');
    };
  }, []);

  return (
    <div className="selection-bar" ref={barRef} role="toolbar" aria-label="Selection">
      <span className="selection-bar__count">{count} selected</span>
      {children}
      <button type="button" onClick={onDeselectAll}>
        Deselect all
      </button>
    </div>
  );
}
