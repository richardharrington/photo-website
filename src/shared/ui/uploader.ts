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
  readonly token: string;
  /** False when local storage refused the token; everything lives in memory. */
  readonly persistent: boolean;
  /** This browser committed a photograph with this ID. */
  addedHere(photoId: string): boolean;
  remember(photoId: string): void;
}

let current: Uploader | null = null;

/** One per page, created on first call. */
export function getUploader(): Uploader {
  current ??= createUploader();
  return current;
}

interface StoredToken {
  token: string;
  persistent: boolean;
  /** A token made just now: any ID list in storage belongs to another. */
  fresh: boolean;
}

function readToken(): StoredToken {
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

function writeIds(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // The token is kept, so the server still honours it; this browser just
    // stops offering Delete on these after the page closes.
  }
}

function createUploader(): Uploader {
  const { token, persistent, fresh } = readToken();

  // A list left behind by a token that is gone would offer Delete on
  // photographs the server now refuses, so a new token starts a new list.
  const ids = new Set(persistent && !fresh ? readIds() : []);
  if (persistent && fresh) writeIds(ids);

  return {
    token,
    persistent,
    addedHere: (photoId) => ids.has(photoId),
    remember(photoId) {
      if (ids.has(photoId)) return;
      ids.add(photoId);
      // Never pruned: a few hundred IDs a year is a few kilobytes.
      if (persistent) writeIds(ids);
    },
  };
}
