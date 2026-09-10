/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhotoGrid } from '../../src/shared/ui/PhotoGrid.tsx';
import { CurationContext } from '../../src/shared/ui/curation.ts';
import type { Curation } from '../../src/shared/ui/curation.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import { appRoutes } from '../../src/shared/urls.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

/**
 * A tile's gestures: click selects, double-click opens, and where a listing
 * cannot select — the files still on their way up — a single click opens as it
 * always did.
 *
 * `can.select` is the whole switch, so every test here names it. What is being
 * checked is the wiring, not the algebra: which callback a gesture reaches, and
 * whether the photograph opened. `selection.test.ts` owns what the callbacks
 * then do, including the idempotency the double-click rests on.
 */

const routes = appRoutes('/test-base');

const first = toPublicPhoto(makePhoto({ id: testPhotoId('first') }));
const second = toPublicPhoto(makePhoto({ id: testPhotoId('second') }));
const photos = [first, second];

interface Calls {
  selectOnly: string[];
  toggle: string[];
  extendTo: string[];
  opened: string[];
}

function harness(select: boolean, selected: readonly string[] = []) {
  const calls: Calls = { selectOnly: [], toggle: [], extendTo: [], opened: [] };
  const curation: Curation = {
    selectedIds: new Set(selected),
    selectOnly: (id) => calls.selectOnly.push(id),
    toggle: (id) => calls.toggle.push(id),
    extendTo: (id) => calls.extendTo.push(id),
    selectAll: () => {},
    trash: () => {},
    edit: () => Promise.reject(new Error('not in this test')),
    can: { edit: true, download: true, trash: true, select },
  };
  return { calls, curation };
}

/** The library's grid: tiles are real anchors and opening is a navigation. */
function linked(select: boolean, selected: readonly string[] = []) {
  const { calls, curation } = harness(select, selected);
  render(
    <CurationContext.Provider value={curation}>
      <PhotoGrid photos={photos} />
    </CurationContext.Provider>,
  );
  return { calls, tile: screen.getAllByRole('link')[0]! };
}

/** The trash's and the upload panel's grid: tiles are buttons that open in place. */
function buttoned(select: boolean, selected: readonly string[] = []) {
  const { calls, curation } = harness(select, selected);
  render(
    <CurationContext.Provider value={curation}>
      <PhotoGrid photos={photos} open={(photo) => calls.opened.push(photo.id)} />
    </CurationContext.Provider>,
  );
  return { calls, tile: screen.getAllByRole('button')[0]! };
}

describe('a tile that selects', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/test-base/');
  });

  it('selects on a plain click and opens nothing', () => {
    const { calls, tile } = linked(true);
    fireEvent.click(tile, { detail: 1 });

    expect(calls.selectOnly).toEqual([first.id]);
    expect(calls.toggle).toEqual([]);
    expect(calls.extendTo).toEqual([]);
    // The anchor's own navigation is prevented; that is what stops the open.
    expect(window.location.pathname).toBe('/test-base/');
  });

  it('opens on a double-click, and asks for no other selection change', () => {
    const { calls, tile } = linked(true, [first.id]);
    // The real sequence: click, click, dblclick. Both clicks land on a photo
    // the first one selected, which is why nothing has to be put back.
    fireEvent.click(tile, { detail: 1 });
    fireEvent.click(tile, { detail: 2 });
    fireEvent.dblClick(tile);

    expect(calls.selectOnly).toEqual([first.id, first.id]);
    expect(calls.toggle).toEqual([]);
    expect(calls.extendTo).toEqual([]);
    expect(window.location.pathname).toBe(routes.photo(first.id));
  });

  it('opens in place on a double-click where the listing opens in place', () => {
    const { calls, tile } = buttoned(true);
    fireEvent.click(tile, { detail: 1 });
    expect(calls.opened).toEqual([]);

    fireEvent.dblClick(tile);
    expect(calls.opened).toEqual([first.id]);
  });

  it('leaves the modifiers alone', () => {
    const { calls, tile } = linked(true);
    fireEvent.click(tile, { detail: 1, metaKey: true });
    fireEvent.click(tile, { detail: 1, shiftKey: true });

    expect(calls.toggle).toEqual([first.id]);
    expect(calls.extendTo).toEqual([first.id]);
    expect(calls.selectOnly).toEqual([]);
    expect(window.location.pathname).toBe('/test-base/');
  });

  it('opens on Enter and selects on Space', () => {
    const { calls, tile } = linked(true);

    // Enter on a real anchor is the browser's: it follows the tile's own href,
    // which is why these tiles are anchors and not buttons.
    fireEvent.keyDown(tile, { key: 'Enter' });
    fireEvent.click(tile, { detail: 0 });
    expect(window.location.pathname).toBe(routes.photo(first.id));
    // And it did not also select. A keyboard-activated click is still a click.
    expect(calls.selectOnly).toEqual([]);

    fireEvent.keyDown(tile, { key: ' ' });
    expect(calls.selectOnly).toEqual([first.id]);
  });

  it('opens on Enter where the listing opens in place', () => {
    const { calls, tile } = buttoned(true);

    fireEvent.keyDown(tile, { key: 'Enter' });
    // The button's own activation click follows, and must not select either.
    fireEvent.click(tile, { detail: 0 });
    expect(calls.opened).toEqual([first.id]);
    expect(calls.selectOnly).toEqual([]);

    fireEvent.keyDown(tile, { key: ' ' });
    expect(calls.selectOnly).toEqual([first.id]);
    expect(calls.opened).toEqual([first.id]);
  });

  it('says both gestures in a tooltip', () => {
    const { tile } = linked(true);
    expect(tile).toHaveAttribute('title', 'Click to select. Double-click to open.');
  });
});

describe('a tile that cannot select', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/test-base/');
  });

  it('opens on a single click and marks nothing', () => {
    const { calls, tile } = buttoned(false);
    fireEvent.click(tile, { detail: 1 });

    expect(calls.opened).toEqual([first.id]);
    expect(calls.selectOnly).toEqual([]);
    expect(calls.toggle).toEqual([]);
  });

  it('carries none of the selecting listing’s gestures', () => {
    const { calls, tile } = buttoned(false);
    expect(tile).not.toHaveAttribute('title');

    // Neither handler exists here, so `dblclick` and Space reach nothing at
    // all — the two constituent clicks of a real double-click are what open
    // such a tile, and they do it through `onClick` above.
    fireEvent.dblClick(tile);
    fireEvent.keyDown(tile, { key: ' ' });
    expect(calls.selectOnly).toEqual([]);
    expect(calls.opened).toEqual([]);
  });
});
