import { useEffect } from 'react';

/**
 * The two ways out of a selection that are not the bar's Deselect all.
 *
 * A plain click no longer clears the selection — it makes one — so the gesture
 * that used to get out of a selection gone wrong has to exist somewhere else.
 * Escape is the keyboard's, and a click on the page background is the mouse's.
 *
 * "The background" is the page margins either side of the grid and the band of
 * padding inside them, which are `Layout`'s own two elements — not the empty
 * space inside the masonry columns, which belongs to no tile and is not
 * dependable (decisions.md #35). The test is therefore that the click landed on
 * one of those elements itself and not on anything within, which is why this
 * reads their class names rather than taking a handler down through two shared
 * page components that the viewer also renders.
 *
 * Both stand down while any dialog is on screen — the photo view, or a
 * confirmation over it. Escape dismisses the innermost thing that is open
 * (#43), and clearing the selection behind a delete confirmation would empty
 * the very thing the dialog is asking about. Escape also stands down with focus
 * in a field, where it belongs to the field: it blurs, and only a second press
 * gets here.
 */
export function useDeselectGestures(clear: () => void): void {
  useEffect(() => {
    function dialogIsOpen(): boolean {
      return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || dialogIsOpen()) return;
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        (focused.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName))
      ) {
        return;
      }
      clear();
    }

    function onClick(event: MouseEvent): void {
      if (dialogIsOpen()) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (
        target.classList.contains('layout') ||
        target.classList.contains('layout__main')
      ) {
        clear();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onClick);
    };
  }, [clear]);
}
