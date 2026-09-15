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
