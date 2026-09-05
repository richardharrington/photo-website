/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Lightbox } from '../../src/shared/ui/Lightbox.tsx';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import { appRoutes } from '../../src/shared/urls.ts';
import { makePhoto } from '../../fixtures/photos.ts';

/**
 * The Photo info panel as a layer that can be dismissed on its own: Escape
 * unwinds it before the photograph, and a pointer outside it closes it.
 */

const routes = appRoutes('/test-base');
const photo = toPublicPhoto(makePhoto({ id: 'a'.repeat(32) }));

function open(onClose = () => {}) {
  render(
    <Lightbox
      photo={photo}
      orderedIds={[photo.id]}
      backHref={routes.home()}
      onClose={onClose}
    />,
  );
  return {
    toggle: screen.getByRole('button', { name: 'Photo info' }),
    dialog: screen.getByRole('dialog'),
  };
}

function escape() {
  fireEvent.keyDown(window, { key: 'Escape' });
}

/** A real press: pointerdown then click, which is what the bug needs to show. */
function press(target: Element) {
  fireEvent.pointerDown(target);
  fireEvent.click(target);
}

function panel() {
  return document.getElementById('photo-information');
}

describe('the photo info panel', () => {
  it('closes on Escape and leaves the photograph open', () => {
    const onClose = vi.fn();
    const { toggle } = open(onClose);
    press(toggle);
    expect(panel()).not.toBeNull();

    escape();
    expect(panel()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // The second press has nothing left to unwind, so it closes the view.
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close the view when the panel is shut', () => {
    const onClose = vi.fn();
    open(onClose);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when a pointer goes down outside it', () => {
    const { toggle, dialog } = open();
    press(toggle);
    fireEvent.pointerDown(dialog);
    expect(panel()).toBeNull();
  });

  it('stays open when a pointer goes down inside it', () => {
    const { toggle } = open();
    press(toggle);
    fireEvent.pointerDown(panel()!);
    expect(panel()).not.toBeNull();
  });

  /**
   * The regression the button-is-inside rule exists for: closing on the
   * outside handler's `pointerdown` would leave the toggle's own `onClick`
   * running against a `showInfo` of false, reopening the panel on the very
   * click meant to close it.
   */
  it('closes for good when the toggle itself is pressed', () => {
    const { toggle } = open();
    press(toggle);
    expect(panel()).not.toBeNull();

    press(toggle);
    expect(panel()).toBeNull();
  });
});
