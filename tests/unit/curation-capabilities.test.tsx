/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Lightbox } from '../../src/shared/ui/Lightbox.tsx';
import { PhotoGrid } from '../../src/shared/ui/PhotoGrid.tsx';
import { CurationContext } from '../../src/shared/ui/curation.ts';
import type { Capabilities, Curation } from '../../src/shared/ui/curation.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import { appRoutes } from '../../src/shared/urls.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

/**
 * What each listing's context shows (family-tier.md 7.2, 7.8).
 *
 * Both apps provide a context now, so no shared component may decide anything
 * by whether one is present — only by `can`. These pin the four lightboxes the
 * table in `curation.ts` describes and the family's grid, so a branch that
 * still tests presence shows up as an admin control in the family's view.
 */

const routes = appRoutes('/test-base');
const photo = toPublicPhoto(
  makePhoto({ id: testPhotoId('shown'), originalFilename: 'IMG_0001.HEIC' }),
);

const FAMILY_LIBRARY: Capabilities = {
  edit: 'own',
  download: true,
  trash: 'own',
  select: false,
  restore: false,
  purge: false,
  addedFrom: true,
  filename: false,
};
const FAMILY_TRASH: Capabilities = {
  edit: 'none',
  download: false,
  trash: 'none',
  select: false,
  restore: true,
  purge: true,
  addedFrom: true,
  filename: false,
};
const ADMIN_LIBRARY: Capabilities = {
  edit: 'all',
  download: true,
  trash: 'all',
  select: true,
  restore: false,
  purge: false,
  addedFrom: false,
  filename: true,
};
const ADMIN_TRASH: Capabilities = {
  edit: 'none',
  download: false,
  trash: 'none',
  select: true,
  restore: true,
  purge: false,
  addedFrom: false,
  filename: true,
};

function curationWith(can: Capabilities, addedHere = false): Curation {
  return {
    selectedIds: new Set(),
    selectOnly: vi.fn(),
    toggle: vi.fn(),
    extendTo: vi.fn(),
    selectAll: vi.fn(),
    trash: vi.fn(),
    edit: vi.fn(() => Promise.reject(new Error('not in this test'))),
    attribution: vi.fn(() => Promise.resolve(null)),
    restore: vi.fn(),
    purge: vi.fn(),
    addedHere: vi.fn(() => addedHere),
    can,
  };
}

function provided(curation: Curation, children: ReactNode) {
  return render(
    <CurationContext.Provider value={curation}>{children}</CurationContext.Provider>,
  );
}

function lightboxUnder(can: Capabilities, addedHere = false) {
  const curation = curationWith(can, addedHere);
  provided(
    curation,
    <Lightbox
      photo={photo}
      orderedIds={[photo.id]}
      backHref={routes.home()}
      onClose={() => {}}
    />,
  );
  return curation;
}

const button = (name: string) => screen.queryByRole('button', { name });
const filenameCorner = () => document.querySelector('.lightbox__filename');
const form = () => document.querySelector('form');

afterEach(() => {
  cleanup();
});

describe('the lightbox', () => {
  it("under the family's library, on a photograph added here: the read view with Edit and every action but Restore, no filename", () => {
    lightboxUnder(FAMILY_LIBRARY, true);

    expect(form()).toBeNull();
    expect(button('Edit')).not.toBeNull();
    expect(button('Download')).not.toBeNull();
    expect(button('Delete')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    expect(button('Restore')).toBeNull();
    expect(filenameCorner()).toBeNull();
  });

  it("under the family's trash: Restore, and no form, download, delete, or filename", () => {
    lightboxUnder(FAMILY_TRASH);

    expect(button('Restore')).not.toBeNull();
    expect(form()).toBeNull();
    expect(button('Download')).toBeNull();
    expect(button('Delete')).toBeNull();
    expect(filenameCorner()).toBeNull();
  });

  it("under the admin's library: unchanged, and no Restore", () => {
    lightboxUnder(ADMIN_LIBRARY);

    expect(form()).toBeNull();
    expect(button('Edit')).not.toBeNull();
    expect(button('Download')).not.toBeNull();
    expect(button('Delete')).not.toBeNull();
    expect(filenameCorner()?.textContent).toBe('IMG_0001.HEIC');
    expect(button('Restore')).toBeNull();
  });

  it("under the admin's trash: Restore, which restores this photograph, and no Delete permanently here", () => {
    const curation = lightboxUnder(ADMIN_TRASH);

    fireEvent.click(button('Restore')!);
    expect(curation.restore).toHaveBeenCalledWith(photo.id);
    expect(button('Delete')).toBeNull();
    // The admin's is on its selection bar.
    expect(button('Delete permanently')).toBeNull();
  });

  it("under the family's trash: Delete permanently, which deletes this photograph", () => {
    const curation = lightboxUnder(FAMILY_TRASH, true);

    fireEvent.click(button('Delete permanently')!);
    expect(curation.purge).toHaveBeenCalledWith(photo.id);
  });

  it("under the family's library: no Delete permanently", () => {
    lightboxUnder(FAMILY_LIBRARY, true);
    expect(button('Delete permanently')).toBeNull();
  });

  it('shows the family the filename in Photo info, and never who emailed it in', async () => {
    const curation = lightboxUnder(FAMILY_LIBRARY);

    fireEvent.pointerDown(button('Photo info')!);
    fireEvent.click(button('Photo info')!);

    const panel = document.getElementById('photo-information')!;
    expect(panel.textContent).toContain('IMG_0001.HEIC');
    // It may ask; the family's context answers null without a request.
    await waitFor(() => expect(curation.attribution).toHaveBeenCalled());
    await expect(
      (curation.attribution as ReturnType<typeof vi.fn>).mock.results[0]!.value,
    ).resolves.toBeNull();
    expect(panel.textContent).not.toContain('Emailed by');
  });

  it("sends Delete and Backspace to the family's trash flow, for a photograph added here", () => {
    const curation = lightboxUnder(FAMILY_LIBRARY, true);

    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(curation.trash).toHaveBeenCalledTimes(2);
    expect(curation.trash).toHaveBeenCalledWith(photo.id);
  });
});

/**
 * Delete only on the photographs this browser added (family-own-trash.md
 * 11.2). The server is what enforces it; these pin that the view offers
 * nothing it would refuse, and takes nothing away from the admin.
 */
describe('Delete, by who added the photograph', () => {
  function openInfo() {
    fireEvent.pointerDown(button('Photo info')!);
    fireEvent.click(button('Photo info')!);
    return document.getElementById('photo-information')!;
  }

  const addedFromLine = (panel: HTMLElement) =>
    [...panel.querySelectorAll('dt')].find((dt) => dt.textContent === 'Added from');

  it("under the family's library, on a photograph added here: Delete, the key, and the Added from line", () => {
    const curation = lightboxUnder(FAMILY_LIBRARY, true);

    expect(button('Delete')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(curation.trash).toHaveBeenCalledWith(photo.id);
    expect(curation.addedHere).toHaveBeenCalledWith(photo.id);

    const line = addedFromLine(openInfo());
    expect(line).toBeDefined();
    expect(line!.nextElementSibling?.tagName).toBe('DD');
    expect(line!.nextElementSibling?.textContent).toBe('This device');
  });

  it("under the family's library, on any other photograph: no Delete, inert keys, and Added from another device", () => {
    const curation = lightboxUnder(FAMILY_LIBRARY, false);

    expect(button('Delete')).toBeNull();
    expect(button('Download')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(curation.trash).not.toHaveBeenCalled();

    const line = addedFromLine(openInfo());
    expect(line).toBeDefined();
    expect(line!.nextElementSibling?.textContent).toBe('Another device');
  });

  it("under the family's trash: Added from this device, and still no Delete", () => {
    lightboxUnder(FAMILY_TRASH, true);

    expect(button('Delete')).toBeNull();
    expect(addedFromLine(openInfo())!.nextElementSibling?.textContent).toBe(
      'This device',
    );
  });

  it.each([true, false])(
    "under the admin's library, with addedHere %s: Delete regardless, and no Added from line",
    (addedHere) => {
      const curation = lightboxUnder(ADMIN_LIBRARY, addedHere);

      expect(button('Delete')).not.toBeNull();
      fireEvent.keyDown(window, { key: 'Backspace' });
      expect(curation.trash).toHaveBeenCalledWith(photo.id);

      expect(addedFromLine(openInfo())).toBeUndefined();
    },
  );
});

describe("the family's grid", () => {
  it('shows no filename, marks no selection, and opens on a plain click', () => {
    window.history.replaceState(null, '', '/test-base/');
    const curation = curationWith(FAMILY_LIBRARY);
    provided(curation, <PhotoGrid photos={[photo]} />);

    expect(document.querySelector('.photo-grid__filename')).toBeNull();
    expect(document.querySelector('[data-selected]')).toBeNull();
    expect(document.querySelector('[data-photo-id]')).toBeNull();

    fireEvent.click(screen.getByRole('link'));
    expect(curation.selectOnly).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(routes.photo(photo.id));
  });
});
