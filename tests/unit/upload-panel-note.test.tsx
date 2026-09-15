/** @vitest-environment happy-dom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ItemState, QueueItem } from '../../src/shared/ui/upload/queue.ts';

/**
 * The add bar's queue, its note, and what a skipped file's tile says.
 *
 * The queue is replaced with a fake whose busy state and items the test
 * drives, so no part of the pipeline loads. What is pinned is that the
 * app-held queue reloads the library when a batch settles whether or not a
 * panel is mounted (the panel unmounts with each listing), and says the batch
 * has landed only once that reload has finished; that the note renders or
 * does not; and that a file skipped because its twin is in the trash links to
 * the trash only when that trash will show it.
 */

const fake = vi.hoisted(() => {
  const listeners = new Set<(snapshot: unknown) => void>();
  const state = { active: false, items: [] as unknown[] };
  const snapshot = () => ({
    items: state.items,
    batchSeq: null,
    active: state.active,
    counts: {
      queued: 0,
      processing: 0,
      uploading: 0,
      committing: 0,
      done: 0,
      skipped: state.items.length,
      failed: 0,
    },
  });
  return {
    reset() {
      state.active = false;
      state.items = [];
      listeners.clear();
    },
    setActive(active: boolean) {
      state.active = active;
      for (const listener of listeners) listener(snapshot());
    },
    setItems(items: unknown[]) {
      state.items = items;
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

const { DELETED_ELSEWHERE, UploadPanel, useUploads } =
  await import('../../src/shared/ui/Upload.tsx');

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

function Panel({
  note = null,
  trashShows = () => true,
}: {
  note?: string | null;
  trashShows?: (photoId: string) => boolean;
}) {
  const uploads = useUploads(() => {});
  return (
    <UploadPanel
      uploads={uploads}
      emphasized={false}
      photoViewOpen={false}
      note={note}
      addedFrom={false}
      trashShows={trashShows}
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

const EXISTING = 'a'.repeat(32);

/** A file the queue skipped because the same photograph is already stored. */
function skipped(trashed: boolean): QueueItem {
  const state: ItemState = 'skipped';
  return {
    id: 'item-1',
    file: new File([], 'beach.jpg'),
    selectionIndex: 0,
    state,
    progress: 1,
    source: null,
    edit: null,
    caption: null,
    preview: null,
    existingPhotoId: EXISTING,
    existingPhotoTrashed: trashed,
  };
}

function tile(container: HTMLElement) {
  const note = container.querySelector('.upload__pending .photo-grid__note');
  return {
    text: note?.textContent ?? '',
    links: [...(note?.querySelectorAll('a') ?? [])].map((link) => link.textContent),
  };
}

describe('a file skipped because its twin is in the trash', () => {
  it('says who can restore it, with no link, when this trash does not list it', () => {
    fake.setItems([skipped(true)]);
    const trashShows = vi.fn(() => false);
    const { container } = render(<Panel trashShows={trashShows} />);

    expect(trashShows).toHaveBeenCalledWith(EXISTING);
    expect(tile(container)).toEqual({ text: DELETED_ELSEWHERE, links: [] });
    expect(DELETED_ELSEWHERE).toBe(
      'This photo was added before and then later deleted. Ask the site admin if you want it to be restored.',
    );
  });

  it('points at the trash when this trash lists it', () => {
    fake.setItems([skipped(true)]);
    const { container } = render(<Panel trashShows={() => true} />);

    const { text, links } = tile(container);
    expect(text).toContain('Already uploaded, now in the trash – skipped');
    expect(text).not.toContain(DELETED_ELSEWHERE);
    expect(links).toEqual(['Find it in the trash']);
  });

  it('links a live duplicate to its photo, without asking about the trash', () => {
    fake.setItems([skipped(false)]);
    const trashShows = vi.fn(() => false);
    const { container } = render(<Panel trashShows={trashShows} />);

    expect(trashShows).not.toHaveBeenCalled();
    const { text, links } = tile(container);
    expect(text).toContain('Already uploaded – skipped');
    expect(links).toEqual(['View the existing photo']);
  });
});
