/**
 * This browser's uploader token, and the photographs it has added
 * (family-own-trash.md 6.2).
 *
 * Two keys in local storage: the token, which the family app sends on every
 * curation request and which the server hashes onto each photograph it
 * commits, and the IDs of the photographs this browser committed. The server
 * decides what may be trashed; the ID list only decides where the photo view
 * offers Delete, and it is kept here rather than asked for so the timeline
 * projection never learns which device added what (decision 5).
 *
 * **Storage is the source of truth, not this page.** Several tabs of the
 * family app in one browser share both keys, and each tab is its own module
 * instance. So every read goes to storage and every write re-reads, merges,
 * and writes back in one synchronous turn. An earlier version read the list
 * once per page and wrote its own copy back, and a second tab's upload erased
 * the first tab's from the list. The token is re-read on every access for the
 * same reason: when two tabs make a browser's very first visit at once, each
 * generates a token and only one survives in storage, and the other tab must
 * adopt it before it uploads anything, or what it adds is hashed with a token
 * no page will ever send again.
 *
 * Storage is an external system that may refuse, as in `unseen.ts`: every
 * read and write is wrapped. When the token cannot be kept, it lives for the
 * page and so does the list, which is enough to delete a mistake noticed
 * straight away (decision 9); `persistent` says so, and the add bar tells the
 * reader.
 *
 * Only the family's entry point may call `getUploader`. Both apps share one
 * origin and so one local storage, and an admin that recorded its uploads here
 * would have the family link show Delete on photographs the server refuses.
 */

import { generateUploaderToken, isValidPhotoId } from '../ids.ts';
import { isUploaderToken } from '../uploader.ts';

const TOKEN_KEY = 'photo-uploader-token';
const IDS_KEY = 'photo-uploaded-ids';

export interface Uploader {
  /**
   * The token to send. Read from storage on each access, so every tab of this
   * browser sends the same one.
   */
  readonly token: string;
  /** False when local storage refused the token; everything lives in memory. */
  readonly persistent: boolean;
  /** This browser committed a photograph with this ID, in any of its tabs. */
  addedHere(photoId: string): boolean;
  remember(photoId: string): void;
}

let current: Uploader | null = null;

/** One per page, created on first call. */
export function getUploader(): Uploader {
  current ??= createUploader();
  return current;
}

interface InitialToken {
  token: string;
  persistent: boolean;
  /** A token made just now: any ID list in storage belongs to another. */
  fresh: boolean;
}

function readInitialToken(): InitialToken {
  let token: string | null = null;
  let fresh = false;
  try {
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (isUploaderToken(stored)) {
      token = stored;
    } else {
      token = generateUploaderToken();
      fresh = true;
      window.localStorage.setItem(TOKEN_KEY, token);
    }
    // A write that silently went nowhere reads back as something else.
    return {
      token,
      fresh,
      persistent: window.localStorage.getItem(TOKEN_KEY) === token,
    };
  } catch {
    // A private window can throw on the accessor itself.
    return { token: token ?? generateUploaderToken(), fresh: true, persistent: false };
  }
}

/** The stored token, or null when it is missing, malformed, or unreadable. */
function readStoredToken(): string | null {
  try {
    const stored = window.localStorage.getItem(TOKEN_KEY);
    return isUploaderToken(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // This page keeps sending it regardless; see `storedUploader`.
  }
}

function readIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(IDS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === 'string' && isValidPhotoId(id),
    );
  } catch {
    return [];
  }
}

function writeIds(ids: Iterable<string>): void {
  try {
    window.localStorage.setItem(IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // The token is kept, so the server still honours it; this browser just
    // stops offering Delete on these after the page closes.
  }
}

function createUploader(): Uploader {
  const { token, persistent, fresh } = readInitialToken();
  if (!persistent) return memoryUploader(token);

  // A list left behind by a token that is gone would offer Delete on
  // photographs the server now refuses, so a new token starts a new list.
  if (fresh) writeIds([]);
  return storedUploader(token);
}

/** Storage refused the token: everything lives, and dies, with this page. */
function memoryUploader(token: string): Uploader {
  const ids = new Set<string>();
  return {
    token,
    persistent: false,
    addedHere: (photoId) => ids.has(photoId),
    remember: (photoId) => void ids.add(photoId),
  };
}

function storedUploader(initialToken: string): Uploader {
  let token = initialToken;

  /**
   * What this page committed under `token`, held here as well as in storage,
   * so that a write that fails later (a full quota) still leaves Delete on
   * this page's own uploads until it closes.
   */
  const committedHere = new Set<string>();

  /** Follow storage, which another tab of this browser may have changed. */
  function sync(): void {
    const stored = readStoredToken();
    if (stored === null) {
      // Cleared or damaged while this page was open. Put this page's token
      // back, so the next tab to open uses it rather than minting another.
      writeStoredToken(token);
      if (committedHere.size > 0) writeIds([...readIds(), ...committedHere]);
      return;
    }
    if (stored !== token) {
      // Another tab's first visit won the race for the token. Anything this
      // page committed under the old one is not deletable from here any more,
      // so stop offering it; the stored list already belongs to the new token.
      token = stored;
      committedHere.clear();
    }
  }

  return {
    get token() {
      sync();
      return token;
    },
    persistent: true,
    addedHere(photoId) {
      sync();
      return committedHere.has(photoId) || readIds().includes(photoId);
    },
    remember(photoId) {
      sync();
      committedHere.add(photoId);
      // Re-read immediately before writing, so another tab's additions since
      // this page last looked are kept. Never pruned: a few hundred IDs a year
      // is a few kilobytes.
      writeIds(new Set([...readIds(), ...committedHere]));
    },
  };
}
