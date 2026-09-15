/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Lightbox } from '../../src/shared/ui/Lightbox.tsx';
import { CurationContext, canEdit } from '../../src/shared/ui/curation.ts';
import type { Capabilities, Curation } from '../../src/shared/ui/curation.ts';
import { formatCaptureDate } from '../../src/shared/datetime.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import type { PublicPhoto } from '../../src/shared/display-api.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

/**
 * The photo view opens to read, and Edit is a deliberate step
 * (read-first-photo-view.md 8.1).
 *
 * Every listing renders the same component, so what differs is only what its
 * capabilities allow; these pin the read view and the edit view under each,
 * and the rules for getting from one to the other. The caption's More button
 * needs layout, which happy-dom does not have, and is tested end to end.
 */

const first = toPublicPhoto(
  makePhoto({
    id: testPhotoId('first'),
    captureDate: '2026-07-04',
    captureTime: '21:03:11',
    caption: 'First rocket up.',
  }),
);
const second = toPublicPhoto(
  makePhoto({
    id: testPhotoId('second'),
    captureDate: '2026-07-04',
    captureTime: '21:07:45',
    caption: null,
  }),
);
const undated = toPublicPhoto(
  makePhoto({
    id: testPhotoId('undated'),
    captureDate: null,
    captureTime: null,
    caption: null,
  }),
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
const FAMILY_UPLOADING: Capabilities = {
  edit: 'all',
  download: false,
  trash: 'none',
  select: false,
  restore: false,
  purge: false,
  addedFrom: true,
  filename: true,
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
const ADMIN_UPLOADING: Capabilities = {
  edit: 'all',
  download: false,
  trash: 'none',
  select: false,
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

/** Saves by handing back the photograph with the edit applied. */
const storesEdit: Curation['edit'] = async (_id, edit) => ({
  ...first,
  captureDate: edit.date,
  captureTime: edit.time,
  caption: edit.caption,
});

function curationWith(
  can: Capabilities,
  addedHere: boolean,
  edit: Curation['edit'] = storesEdit,
): Curation {
  return {
    selectedIds: new Set(),
    selectOnly: vi.fn(),
    toggle: vi.fn(),
    extendTo: vi.fn(),
    selectAll: vi.fn(),
    trash: vi.fn(),
    edit: vi.fn(edit),
    attribution: vi.fn(() => Promise.resolve(null)),
    restore: vi.fn(),
    purge: vi.fn(),
    addedHere: vi.fn(() => addedHere),
    can,
  };
}

function mount(
  can: Capabilities,
  {
    addedHere = true,
    edit,
    photo = first,
  }: { addedHere?: boolean; edit?: Curation['edit']; photo?: PublicPhoto } = {},
) {
  const curation = curationWith(can, addedHere, edit);
  const onClose = vi.fn();
  const onStep = vi.fn();
  const view = (shown: PublicPhoto) => (
    <CurationContext.Provider value={curation}>
      <Lightbox
        photo={shown}
        orderedIds={[first.id, second.id]}
        backHref="/test-base/"
        onClose={onClose}
        onStep={onStep}
      />
    </CurationContext.Provider>
  );
  const { rerender } = render(view(photo));
  return {
    curation,
    onClose,
    onStep,
    show: (next: PublicPhoto) => rerender(view(next)),
  };
}

const button = (name: string) => screen.queryByRole('button', { name });
const form = () => document.querySelector('form');
const captionField = () => screen.getByLabelText('Caption') as HTMLTextAreaElement;
const dateLine = () => document.querySelector('.lightbox__date');
const captionText = () => document.querySelector('.lightbox__caption');
const escape = () => fireEvent.keyDown(window, { key: 'Escape' });
const openEdit = () => fireEvent.click(button('Edit')!);

function press(target: Element) {
  fireEvent.pointerDown(target);
  fireEvent.click(target);
}

afterEach(() => {
  cleanup();
});

describe('canEdit', () => {
  it.each([
    ['all', false, true],
    ['own', true, true],
    ['own', false, false],
    ['none', true, false],
  ] as const)('with edit %s and addedHere %s is %s', (edit, addedHere, expected) => {
    const curation = curationWith({ ...FAMILY_LIBRARY, edit }, addedHere);
    expect(canEdit(curation, first.id)).toBe(expected);
  });
});

describe('the read view', () => {
  it("under the family's library, on a photograph added here: text, then the form behind Edit", () => {
    mount(FAMILY_LIBRARY, { addedHere: true });

    expect(form()).toBeNull();
    for (const name of ['Download', 'Edit', 'Delete', 'Photo info']) {
      expect(button(name), name).not.toBeNull();
    }
    expect(dateLine()?.textContent).toBe(formatCaptureDate('2026-07-04'));
    expect(captionText()?.textContent).toBe('First rocket up.');

    openEdit();

    expect(form()).not.toBeNull();
    expect(button('Download')).toBeNull();
    expect(button('Edit')).toBeNull();
    expect(button('Delete')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    expect(button('Previous photo')).toBeNull();
    expect(button('Next photo')).toBeNull();
    expect(document.querySelector('.lightbox--editing')).not.toBeNull();
  });

  it("under the family's library, on any other photograph: Download and Photo info, and nothing to edit", () => {
    mount(FAMILY_LIBRARY, { addedHere: false });

    expect(button('Download')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    expect(button('Edit')).toBeNull();
    expect(button('Delete')).toBeNull();
    expect(form()).toBeNull();
  });

  it("under the admin's library, on a photograph nobody here added: Edit and Delete", () => {
    mount(ADMIN_LIBRARY, { addedHere: false });

    expect(button('Edit')).not.toBeNull();
    expect(button('Delete')).not.toBeNull();
    expect(form()).toBeNull();
  });

  it.each([
    ['family', FAMILY_UPLOADING],
    ['admin', ADMIN_UPLOADING],
  ])("under the %s's files still uploading: Edit and Photo info only", (_app, can) => {
    // False even in the family's, to show Edit does not ask.
    mount(can, { addedHere: false });

    expect(button('Edit')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    expect(button('Download')).toBeNull();
    expect(button('Delete')).toBeNull();
    expect(form()).toBeNull();
  });

  it.each([
    ['family', FAMILY_TRASH],
    ['admin', ADMIN_TRASH],
  ])("under the %s's trash: Restore, no Edit, and no form", (_app, can) => {
    mount(can, { addedHere: true });

    expect(button('Restore')).not.toBeNull();
    expect(button('Photo info')).not.toBeNull();
    expect(button('Edit')).toBeNull();
    expect(form()).toBeNull();
    expect(dateLine()).not.toBeNull();
  });

  it('says "Undated" for a photograph with no date, and has no caption line without a caption', () => {
    mount(FAMILY_LIBRARY, { photo: undated });

    expect(dateLine()?.textContent).toBe('Undated');
    expect(captionText()).toBeNull();
    expect(button('More')).toBeNull();
  });
});

describe('the edit view', () => {
  it('focuses no field on opening, and returns focus to Edit on the way back', () => {
    mount(ADMIN_LIBRARY);
    openEdit();

    const active = document.activeElement;
    expect(active).toBe(screen.getByRole('dialog'));
    expect(active?.tagName).not.toBe('INPUT');
    expect(active?.tagName).not.toBe('TEXTAREA');

    fireEvent.click(button('Cancel')!);
    expect(document.activeElement).toBe(button('Edit'));
  });

  it('keeps Save disabled until something differs from what is stored', () => {
    mount(ADMIN_LIBRARY);
    openEdit();
    const save = button('Save changes')!;

    expect(save).toBeDisabled();
    fireEvent.change(captionField(), { target: { value: 'First rocket up!' } });
    expect(save).toBeEnabled();
    fireEvent.change(captionField(), { target: { value: 'First rocket up.' } });
    expect(save).toBeDisabled();
    expect(button('Cancel')).toBeEnabled();
  });

  it('sends nothing for ⌘/Ctrl+Enter while Save is disabled', () => {
    const { curation } = mount(ADMIN_LIBRARY);
    openEdit();
    fireEvent.keyDown(captionField(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(captionField(), { key: 'Enter', ctrlKey: true });
    expect(curation.edit).not.toHaveBeenCalled();
  });

  it('discards on Cancel: Edit again shows what is stored', () => {
    const { curation } = mount(ADMIN_LIBRARY);
    openEdit();
    fireEvent.change(captionField(), { target: { value: 'Never saved' } });

    fireEvent.click(button('Cancel')!);
    expect(form()).toBeNull();
    expect(curation.edit).not.toHaveBeenCalled();

    openEdit();
    expect(captionField().value).toBe('First rocket up.');
  });

  it('returns to the read view with "Saved" after a save, and a step clears it', async () => {
    const { curation, onStep, show } = mount(ADMIN_LIBRARY);
    openEdit();
    fireEvent.change(captionField(), { target: { value: 'Launch night' } });
    fireEvent.submit(form()!);

    await waitFor(() => expect(form()).toBeNull());
    expect(curation.edit).toHaveBeenCalledWith(first.id, {
      date: '2026-07-04',
      time: '21:03:11',
      caption: 'Launch night',
    });
    expect(screen.getByRole('status').textContent).toBe('Saved');

    fireEvent.click(button('Next photo')!);
    expect(onStep).toHaveBeenCalledWith(second.id);
    show(second);

    expect(screen.queryByRole('status')).toBeNull();
    expect(form()).toBeNull();
    expect(button('Edit')).not.toBeNull();
  });

  it('stays in the edit view after a failed save, with the message and the typing', async () => {
    mount(ADMIN_LIBRARY, {
      edit: () => Promise.reject(new Error('That change could not be saved.')),
    });
    openEdit();
    fireEvent.change(captionField(), { target: { value: 'Launch night' } });
    fireEvent.submit(form()!);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That change could not be saved.',
    );
    expect(form()).not.toBeNull();
    expect(captionField().value).toBe('Launch night');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not step on ArrowRight', () => {
    const { onStep } = mount(ADMIN_LIBRARY);
    openEdit();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onStep).not.toHaveBeenCalled();
  });
});

describe('Escape', () => {
  it('leaves an edit view holding nothing unsaved, and then closes the photograph', () => {
    const { onClose } = mount(ADMIN_LIBRARY);
    openEdit();

    escape();
    expect(form()).toBeNull();
    expect(button('Edit')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does nothing in an edit view holding unsaved typing', () => {
    const { onClose } = mount(ADMIN_LIBRARY);
    openEdit();
    fireEvent.change(captionField(), { target: { value: 'Never saved' } });
    screen.getByRole('dialog').focus();

    escape();
    expect(form()).not.toBeNull();
    expect(captionField().value).toBe('Never saved');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes Photo info first, and leaves the edit view open', () => {
    const { onClose } = mount(ADMIN_LIBRARY);
    openEdit();
    press(button('Photo info')!);
    expect(document.getElementById('photo-information')).not.toBeNull();

    escape();
    expect(document.getElementById('photo-information')).toBeNull();
    expect(form()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('blurs a focused field rather than leaving', () => {
    const { onClose } = mount(ADMIN_LIBRARY);
    openEdit();
    captionField().focus();

    escape();
    expect(document.activeElement).not.toBe(captionField());
    expect(form()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
