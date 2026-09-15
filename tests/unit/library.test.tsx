/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLibrary } from '../../src/shared/ui/library.ts';
import { timelineResponse } from '../../src/shared/display-api.ts';
import { fixtureCatalog, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * The library hook both apps curate through (family-tier.md #11).
 *
 * What is worth pinning is the undo offer, which the hook generalised when it
 * moved out of the admin App: the trash offer restores through the API and
 * reloads, a second offer replaces the first, and one offer performs once
 * however many times Undo is pressed.
 */

const ID = FIXTURE_PHOTO_IDS['beach-early']!;
const TIMELINE = timelineResponse(fixtureCatalog(), 'Family Photos', Date.now());

let calls: { method: string; path: string; body: unknown }[];

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });

      switch (`${method} ${path}`) {
        case 'GET /timeline':
          return reply(TIMELINE);
        case 'GET /trash/count':
          return reply({ count: 0 });
        case 'POST /trash/preview':
          return reply({ photoIds: [ID], count: 1, expiresAt: 1, token: 't' });
        case 'POST /trash/confirm':
          return reply({ trashed: [ID], count: 1 });
        case 'POST /restore':
          return reply({ restored: [ID], count: 1 });
        default:
          return new Response('Not Found', { status: 404 });
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function count(method: string, path: string): number {
  return calls.filter((call) => call.method === method && call.path === path).length;
}

async function loadedLibrary() {
  const hook = renderHook(() => useLibrary({ onRecent: false }));
  await waitFor(() => expect(hook.result.current.data).not.toBeNull());
  return hook;
}

describe('useLibrary', () => {
  it('offers to undo a trash, and the undo restores and reloads', async () => {
    const { result } = await loadedLibrary();

    await act(() => result.current.startTrash({ kind: 'ids', photoIds: [ID] }, null));
    expect(result.current.preview?.result.photoIds).toEqual([ID]);

    await act(() => result.current.confirmTrash());
    expect(result.current.preview).toBeNull();
    // The patch itself is timeline-patch's, tested there; this fake's refetch
    // still lists the photo, so what is asserted is the request.
    expect(calls.filter((call) => call.path === '/trash/confirm')).toEqual([
      {
        method: 'POST',
        path: '/trash/confirm',
        body: { photoIds: [ID], expiresAt: 1, token: 't' },
      },
    ]);
    expect(result.current.undoOffer?.message).toBe('1 photo deleted.');

    const timelinesBefore = count('GET', '/timeline');
    await act(() => result.current.undo());

    expect(calls.filter((call) => call.path === '/restore')).toEqual([
      { method: 'POST', path: '/restore', body: { photoIds: [ID] } },
    ]);
    await waitFor(() =>
      expect(count('GET', '/timeline')).toBeGreaterThan(timelinesBefore),
    );
    expect(result.current.undoOffer).toBeNull();
  });

  it('replaces a standing offer with a later one', async () => {
    const { result } = await loadedLibrary();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    act(() => result.current.offerUndo({ message: 'first', perform: first }));
    const firstSerial = result.current.undoOffer!.serial;
    act(() => result.current.offerUndo({ message: 'second', perform: second }));

    expect(result.current.undoOffer?.message).toBe('second');
    expect(result.current.undoOffer!.serial).toBeGreaterThan(firstSerial);

    await act(() => result.current.undo());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('performs one offer once, however many times Undo is pressed', async () => {
    const { result } = await loadedLibrary();
    let finish!: () => void;
    const perform = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

    act(() => result.current.offerUndo({ message: 'undoable', perform }));

    const undo = result.current.undo;
    let pending!: Promise<void>;
    act(() => {
      pending = undo();
      void undo();
    });
    await act(async () => {
      finish();
      await pending;
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.current.undoOffer).toBeNull();
  });

  it('leaves the offer standing, and says why, when the undo fails', async () => {
    const { result } = await loadedLibrary();

    act(() =>
      result.current.offerUndo({
        message: 'undoable',
        perform: () => Promise.reject(new Error('The server said no.')),
      }),
    );
    await act(() => result.current.undo());

    expect(result.current.undoOffer?.message).toBe('undoable');
    expect(result.current.error).toBe('The server said no.');
  });
});

/**
 * A refetch asked for while another is on its way must not be answered by
 * that one: its request left before whatever change prompted the second, so
 * an upload that waited on it would clear its tiles against a library that
 * does not have them yet, and the photographs would vanish until a reload.
 */
describe('refetch', () => {
  const EMPTY = timelineResponse(
    { ...fixtureCatalog(), photos: {} },
    'Family Photos',
    Date.now(),
  );

  function holdTimelines() {
    const held: ((response: Response) => void)[] = [];
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      calls.push({
        method: 'GET',
        path: String(url).replace(/^.*\/api/, ''),
        body: undefined,
      });
      return new Promise<Response>((resolve) => held.push(resolve));
    });
    return held;
  }

  it('asked for during another, waits for a request of its own', async () => {
    const { result } = await loadedLibrary();
    const held = holdTimelines();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refetch();
    });
    act(() => {
      second = result.current.refetch();
    });
    expect(held).toHaveLength(1);
    expect(second).not.toBe(first);
    // A burst is still one follow-up, not a request per call.
    expect(result.current.refetch()).toBe(second);

    let settled = false;
    void second.then(() => {
      settled = true;
    });

    await act(async () => {
      held[0]!(reply(EMPTY));
      await first;
    });
    await waitFor(() => expect(held).toHaveLength(2));
    expect(settled).toBe(false);

    await act(async () => {
      held[1]!(reply(TIMELINE));
      await second;
    });
    expect(settled).toBe(true);
    expect(result.current.data?.total).toBe(TIMELINE.total);
  });

  it('asked for when nothing is on its way, starts one at once', async () => {
    const { result } = await loadedLibrary();
    const before = count('GET', '/timeline');
    await act(() => result.current.refetch());
    await act(() => result.current.refetch());
    expect(count('GET', '/timeline')).toBe(before + 2);
  });
});

describe('trashChanged', () => {
  it('recounts the trash and reloads the library, which a restore changed', async () => {
    const { result } = await loadedLibrary();
    const timelines = count('GET', '/timeline');
    const counts = count('GET', '/trash/count');

    act(() => result.current.trashChanged());

    await waitFor(() => expect(count('GET', '/timeline')).toBe(timelines + 1));
    await waitFor(() => expect(count('GET', '/trash/count')).toBe(counts + 1));
  });
});
