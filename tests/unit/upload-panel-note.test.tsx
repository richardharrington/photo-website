/** @vitest-environment happy-dom */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * The add bar's note (family-own-trash.md 7.4, 11.2): the family app passes
 * the storage warning when this browser cannot keep its uploader token, and
 * both apps otherwise pass null.
 *
 * The queue is replaced with an idle one, so rendering the panel loads no
 * part of the pipeline; the note is all this is about.
 */

vi.mock('../../src/shared/ui/upload/create.ts', () => ({
  createQueue: () => ({
    snapshot: () => ({ items: [], active: false }),
    subscribe: () => () => {},
    add: async () => {},
    clear: () => {},
    clearCommitted: () => {},
    edit: async () => {
      throw new Error('not in this test');
    },
  }),
}));

const { UploadPanel } = await import('../../src/shared/ui/Upload.tsx');

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

afterEach(() => {
  cleanup();
});

function panel(note: string | null) {
  return render(
    <UploadPanel
      onLibraryChanged={() => {}}
      emphasized={false}
      photoViewOpen={false}
      note={note}
    />,
  );
}

describe("the add bar's note", () => {
  it('renders the note it is given, inside the add bar', () => {
    const { container } = panel('This browser cannot remember.');
    const note = container.querySelector('.drop-target .drop-target__note');
    expect(note?.tagName).toBe('P');
    expect(note?.textContent).toBe('This browser cannot remember.');
  });

  it('renders nothing for null', () => {
    const { container } = panel(null);
    expect(container.querySelector('.drop-target')).not.toBeNull();
    expect(container.querySelector('.drop-target__note')).toBeNull();
  });
});
