/** @vitest-environment happy-dom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';

/**
 * The add bar's queue and its note.
 *
 * The queue is replaced with a fake whose busy state the test drives, so no
 * part of the pipeline loads. What is pinned is that the app-held queue
 * reloads the library when a batch settles whether or not a panel is mounted
 * (the panel unmounts with each listing), and says the batch has landed only
 * once that reload has finished; and that the note renders or does not.
 */

const fake = vi.hoisted(() => {
  const listeners = new Set<(snapshot: unknown) => void>();
  const state = { active: false };
  const snapshot = () => ({
    items: [],
    batchSeq: null,
    active: state.active,
    counts: {},
  });
  return {
    reset() {
      state.active = false;
      listeners.clear();
    },
    setActive(active: boolean) {
      state.active = active;
      for (const listener of listeners) listener(snapshot());
    },
    queue: {
      snapshot,
      subscribe(listener: (snapshot: unknown) => void) {
        listeners.add(listener);
        listener(snapshot());
        return () => listeners.delete(listener);
      },
      add: async () => {},
      retry: async () => {},
      clear: () => {},
      clearCommitted: () => {},
      edit: async () => {
        throw new Error('not in this test');
      },
    },
  };
});

vi.mock('../../src/shared/ui/upload/create.ts', () => ({
  createQueue: () => fake.queue,
}));

const { UploadPanel, useUploads } = await import('../../src/shared/ui/Upload.tsx');

beforeAll(() => {
  // The panel publishes its height through a ResizeObserver.
  if (!('ResizeObserver' in window)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
});

beforeEach(() => {
  fake.reset();
});

afterEach(() => {
  cleanup();
});

/** A reload the test finishes when it chooses. */
function heldReloads() {
  const finishes: (() => void)[] = [];
  const reload = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
  );
  return { reload, finishes };
}

describe('useUploads', () => {
  it('reloads the library when a batch settles, and has landed only once that reload has', async () => {
    const { reload, finishes } = heldReloads();
    const { result } = renderHook(() => useUploads(reload));
    expect(result.current.landed).toBe(false);

    act(() => fake.setActive(true));
    expect(reload).not.toHaveBeenCalled();

    act(() => fake.setActive(false));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.landed).toBe(false);

    await act(async () => finishes[0]!());
    expect(result.current.landed).toBe(true);

    // A new batch is not landed.
    act(() => fake.setActive(true));
    expect(result.current.landed).toBe(false);
  });

  it('does not call a batch landed on a reload that finished after another began', async () => {
    const { reload, finishes } = heldReloads();
    const { result } = renderHook(() => useUploads(reload));

    act(() => fake.setActive(true));
    act(() => fake.setActive(false));
    act(() => fake.setActive(true));
    await act(async () => finishes[0]!());
    expect(result.current.landed).toBe(false);

    act(() => fake.setActive(false));
    expect(reload).toHaveBeenCalledTimes(2);
    await act(async () => finishes[1]!());
    expect(result.current.landed).toBe(true);
  });
});

function Panel({ note }: { note: string | null }) {
  const uploads = useUploads(() => {});
  return (
    <UploadPanel
      uploads={uploads}
      emphasized={false}
      photoViewOpen={false}
      note={note}
      addedFrom={false}
    />
  );
}

describe("the add bar's note", () => {
  it('renders the note it is given, inside the add bar', () => {
    const { container } = render(<Panel note="This browser cannot remember." />);
    const note = container.querySelector('.drop-target .drop-target__note');
    expect(note?.tagName).toBe('P');
    expect(note?.textContent).toBe('This browser cannot remember.');
  });

  it('renders nothing for null', () => {
    const { container } = render(<Panel note={null} />);
    expect(container.querySelector('.drop-target')).not.toBeNull();
    expect(container.querySelector('.drop-target__note')).toBeNull();
  });
});
