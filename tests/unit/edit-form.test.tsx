/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EditForm } from '../../src/shared/ui/EditForm.tsx';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import type { PublicPhoto } from '../../src/shared/display-api.ts';
import { makePhoto } from '../../fixtures/photos.ts';

/**
 * The photo view's form when the stored record changes under it without a
 * save — which Undo on a bulk caption does, from a banner above the view.
 */

const photo = toPublicPhoto(
  makePhoto({
    id: 'a'.repeat(32),
    captureDate: '2026-07-04',
    captureTime: '21:03:11',
    caption: 'Beach',
  }),
);

function mount() {
  const onDirtyChange = vi.fn();
  const form = (current: PublicPhoto) => (
    <EditForm
      photo={current}
      onSave={async () => current}
      onDirtyChange={onDirtyChange}
    />
  );
  const { rerender } = render(form(photo));
  return {
    onDirtyChange,
    update: (next: PublicPhoto) => rerender(form(next)),
    caption: () => screen.getByLabelText('Caption') as HTMLTextAreaElement,
    date: () => screen.getByLabelText('Capture date') as HTMLInputElement,
  };
}

describe('the edit form, when the stored photo changes', () => {
  it('lets an untouched caption follow the record, and reports nothing unsaved', () => {
    const { update, caption, onDirtyChange } = mount();

    update({ ...photo, caption: 'First rocket up.' });

    expect(caption().value).toBe('First rocket up.');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('follows a caption cleared to nothing', () => {
    const { update, caption } = mount();
    update({ ...photo, caption: null });
    expect(caption().value).toBe('');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps an edit made before the change, and follows the fields not edited', () => {
    const { update, caption, date } = mount();
    fireEvent.change(caption(), { target: { value: 'Typed by hand' } });

    update({ ...photo, caption: 'First rocket up.', captureDate: '2026-07-05' });

    expect(caption().value).toBe('Typed by hand');
    expect(date().value).toBe('2026-07-05');
    // Still an edit, measured against the new record.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });
});
