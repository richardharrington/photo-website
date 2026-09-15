/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUploaderToken } from '../../src/shared/uploader.ts';

/**
 * The browser's half of "added from this browser" (family-own-trash.md 6.2).
 *
 * `getUploader` holds one uploader per page in module state, so a page load is
 * simulated by resetting the module registry and importing it again.
 */

const TOKEN_KEY = 'photo-uploader-token';
const IDS_KEY = 'photo-uploaded-ids';
const PHOTO = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

async function loadPage() {
  vi.resetModules();
  const { getUploader } = await import('../../src/shared/ui/uploader.ts');
  return getUploader();
}

/** A storage whose chosen methods throw, like a private window or a full quota. */
function refusingStorage(refuse: { get?: boolean; set?: boolean }): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    getItem(key) {
      if (refuse.get) throw new Error('SecurityError');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (refuse.set) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
  };
}

const realStorage = window.localStorage;

function useStorage(storage: Storage) {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

beforeEach(() => {
  realStorage.clear();
});

afterEach(() => {
  useStorage(realStorage);
  realStorage.clear();
});

describe('getUploader', () => {
  it('generates and keeps a token, and a second page load reads the same one', async () => {
    const first = await loadPage();
    expect(isUploaderToken(first.token)).toBe(true);
    expect(first.persistent).toBe(true);
    expect(realStorage.getItem(TOKEN_KEY)).toBe(first.token);

    const second = await loadPage();
    expect(second.token).toBe(first.token);
    expect(second.persistent).toBe(true);
  });

  it('is one uploader per page', async () => {
    const first = await loadPage();
    const { getUploader } = await import('../../src/shared/ui/uploader.ts');
    expect(getUploader()).toBe(first);
  });

  it('remembers what this browser added, across page loads', async () => {
    const first = await loadPage();
    expect(first.addedHere(PHOTO)).toBe(false);
    first.remember(PHOTO);
    expect(first.addedHere(PHOTO)).toBe(true);

    const second = await loadPage();
    expect(second.addedHere(PHOTO)).toBe(true);
    expect(second.addedHere(OTHER)).toBe(false);
  });

  it('replaces a malformed token', async () => {
    realStorage.setItem(TOKEN_KEY, 'not a token');
    const uploader = await loadPage();
    expect(isUploaderToken(uploader.token)).toBe(true);
    expect(realStorage.getItem(TOKEN_KEY)).toBe(uploader.token);
  });

  it('treats an unparseable ID list as empty, and drops entries that are not photo IDs', async () => {
    const token = (await loadPage()).token;

    realStorage.setItem(IDS_KEY, '{not json');
    let uploader = await loadPage();
    expect(uploader.token).toBe(token);
    expect(uploader.addedHere(PHOTO)).toBe(false);

    realStorage.setItem(
      IDS_KEY,
      JSON.stringify([PHOTO, 'nope', 42, OTHER.toUpperCase()]),
    );
    uploader = await loadPage();
    expect(uploader.addedHere(PHOTO)).toBe(true);
    expect(uploader.addedHere('nope')).toBe(false);
    expect(uploader.addedHere(OTHER.toUpperCase())).toBe(false);
  });

  it('forgets a list left behind by a token that is gone', async () => {
    realStorage.setItem(IDS_KEY, JSON.stringify([PHOTO]));
    const uploader = await loadPage();
    expect(uploader.addedHere(PHOTO)).toBe(false);
  });

  it.each([
    ['writing throws', { set: true }],
    ['reading throws', { get: true }],
  ])('keeps everything for the page when %s', async (_name, refuse) => {
    useStorage(refusingStorage(refuse));

    const uploader = await loadPage();
    expect(uploader.persistent).toBe(false);
    expect(isUploaderToken(uploader.token)).toBe(true);

    uploader.remember(PHOTO);
    expect(uploader.addedHere(PHOTO)).toBe(true);
  });
});

/**
 * Several tabs of the family app in one browser. Each `loadPage()` is a new
 * module instance over the same storage, so an earlier result stands for a tab
 * that is still open.
 */
describe('several tabs of one browser', () => {
  it('keeps what each tab added, whichever wrote last', async () => {
    const tabA = await loadPage();
    const tabB = await loadPage();
    expect(tabB.token).toBe(tabA.token);

    tabA.remember(PHOTO);
    tabB.remember(OTHER);

    // Each open tab sees the other's upload without a reload…
    expect(tabA.addedHere(OTHER)).toBe(true);
    expect(tabB.addedHere(PHOTO)).toBe(true);

    // …and so does the next page load.
    const reloaded = await loadPage();
    expect(reloaded.addedHere(PHOTO)).toBe(true);
    expect(reloaded.addedHere(OTHER)).toBe(true);
  });

  it("adopts a token another tab's first visit put in storage, and drops what the old one added", async () => {
    const tabA = await loadPage();
    const oldToken = tabA.token;
    tabA.remember(PHOTO);

    // Another tab that read storage before this one wrote, as two tabs opening
    // a browser's very first visit at the same moment can.
    realStorage.removeItem(TOKEN_KEY);
    const tabB = await loadPage();
    expect(tabB.token).not.toBe(oldToken);

    expect(tabA.token).toBe(tabB.token);
    expect(tabA.addedHere(PHOTO)).toBe(false);

    tabA.remember(OTHER);
    expect(tabB.addedHere(OTHER)).toBe(true);
  });

  it('puts its token and its uploads back when storage loses them', async () => {
    const tab = await loadPage();
    const token = tab.token;
    tab.remember(PHOTO);

    realStorage.clear();

    expect(tab.token).toBe(token);
    expect(realStorage.getItem(TOKEN_KEY)).toBe(token);
    expect(JSON.parse(realStorage.getItem(IDS_KEY) ?? '[]')).toEqual([PHOTO]);

    const reloaded = await loadPage();
    expect(reloaded.token).toBe(token);
    expect(reloaded.addedHere(PHOTO)).toBe(true);
  });
});
