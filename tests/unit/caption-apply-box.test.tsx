/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaptionApply } from '../../src/admin/components/CaptionApply.tsx';
import type { CaptionApplyResult } from '../../src/admin/components/CaptionApply.tsx';
import type { CaptionPlan } from '../../src/admin/caption-apply.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import type { PublicPhoto } from '../../src/shared/display-api.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

/** The selection bar's caption box: its keys, and when it offers Apply. */

const uncaptioned = ['a', 'b'].map((seed) =>
  toPublicPhoto(makePhoto({ id: testPhotoId(seed), caption: null })),
);

function mount(
  onApply: (
    plan: CaptionPlan,
    sending: () => void,
  ) => Promise<CaptionApplyResult> = vi.fn(async () => 'applied' as const),
) {
  const box = (selected: readonly PublicPhoto[]) => (
    <CaptionApply selected={selected} onApply={onApply} />
  );
  const { rerender } = render(box(uncaptioned));
  const input = screen.getByLabelText('Apply caption to selected') as HTMLInputElement;
  return {
    input,
    onApply,
    select: (selected: readonly PublicPhoto[]) => rerender(box(selected)),
    type: (text: string) => fireEvent.change(input, { target: { value: text } }),
    enter: (init: KeyboardEventInit = {}) =>
      fireEvent.keyDown(input, { key: 'Enter', ...init }),
    applyButton: () => screen.queryByRole('button', { name: 'Apply' }),
  };
}

describe('the caption box', () => {
  const listeners: ((event: KeyboardEvent) => void)[] = [];
  afterEach(() => {
    for (const listener of listeners.splice(0)) {
      window.removeEventListener('keydown', listener);
    }
  });

  it('has no Apply button while it is empty or holds only spaces', () => {
    const { type, applyButton } = mount();
    expect(applyButton()).toBeNull();
    type('   ');
    expect(applyButton()).toBeNull();
    type('Beach');
    expect(applyButton()).not.toBeNull();
  });

  it('applies on Enter only while the slot offers Apply', async () => {
    const { type, enter, onApply, select } = mount();

    enter();
    expect(onApply).not.toHaveBeenCalled();

    type('Beach');
    enter();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onApply).mock.calls[0]![0]).toMatchObject({
      caption: 'Beach',
      selected: 2,
    });

    // The photos now carry it, so the slot confirms rather than offers.
    select(uncaptioned.map((photo) => ({ ...photo, caption: 'Beach' })));
    await screen.findByText('Applied');
    enter();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('ignores Enter while a request is out, and while an IME is composing', async () => {
    let finish: (result: CaptionApplyResult) => void = () => {};
    const onApply = vi.fn((_plan: CaptionPlan, sending: () => void) => {
      sending();
      return new Promise<CaptionApplyResult>((resolve) => (finish = resolve));
    });
    const { type, enter } = mount(onApply);
    type('Beach');

    enter({ isComposing: true });
    expect(onApply).not.toHaveBeenCalled();

    enter();
    expect(screen.getByText('Applying…')).toBeTruthy();
    enter();
    expect(onApply).toHaveBeenCalledTimes(1);

    await act(async () => finish('cancelled'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeNull(),
    );
  });

  it('does not say Applying… while a confirmation is still asking', async () => {
    // Nothing has been sent until the dialog is answered, so the slot still
    // offers Apply behind it — but a second press cannot start another apply.
    let answer: (result: CaptionApplyResult) => void = () => {};
    const onApply = vi.fn(
      () => new Promise<CaptionApplyResult>((resolve) => (answer = resolve)),
    );
    const { type, enter, applyButton } = mount(onApply);
    type('Beach');

    enter();
    expect(screen.queryByText('Applying…')).toBeNull();
    expect(applyButton()).not.toBeNull();

    enter();
    fireEvent.click(applyButton()!);
    expect(onApply).toHaveBeenCalledTimes(1);

    await act(async () => answer('cancelled'));
    enter();
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('does not show Applied after a cancel or a failure', async () => {
    const onApply = vi.fn(async (): Promise<CaptionApplyResult> => 'cancelled');
    const { type, enter, select } = mount(onApply);
    select(uncaptioned.map((photo) => ({ ...photo, caption: 'Beach' })));
    type('Beach');
    enter();
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(screen.queryByText('Applied')).toBeNull();
  });

  it('blurs on Escape, and the press goes no further than the box', () => {
    const onWindowKey = vi.fn();
    listeners.push(onWindowKey);
    window.addEventListener('keydown', onWindowKey);

    const { input, type } = mount();
    type('Half typed');
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(document.activeElement).not.toBe(input);
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(input.value).toBe('Half typed');
  });
});
