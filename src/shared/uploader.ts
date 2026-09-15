/**
 * Which browser added a photograph, as far as the family link can tell
 * (docs/specs/family-own-trash.md).
 *
 * The family app keeps a random token in local storage and sends it on every
 * curation request. A commit through the family link records the token's
 * SHA-256 on the photograph, and in display mode a trash or a restore reaches
 * only photographs whose recorded hash matches the request's. That is the
 * whole of "ownership": no account, no person, no address, no fingerprint —
 * a browser, identified by a secret only it holds (decision 1).
 *
 * Runtime-neutral, because both Functions and the fixture server apply these
 * rules and the Worker compiles everything under `src/shared/`. Web Crypto is
 * reached through `globalThis`, as `ids.ts` and `signing.ts` reach it.
 */

import type { PhotoRecord } from './catalog.ts';
import { secureEquals } from './signing.ts';

/** The request header a family browser sends its token in. */
export const UPLOADER_HEADER = 'x-photo-uploader';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** 64 lowercase hex characters. */
export function isUploaderToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/** Structural type for the one Web Crypto method used here; see `ids.ts`. */
interface CryptoLike {
  subtle: {
    digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
  };
}

const encoder = new TextEncoder();

/** SHA-256 of the token's characters, lowercase hex. */
export async function hashUploaderToken(token: string): Promise<string> {
  const webcrypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!webcrypto?.subtle) {
    throw new Error('A Web Crypto implementation is required to hash a token.');
  }
  const digest = new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', encoder.encode(token)),
  );
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * True only when the photo carries a hash and it equals `hash`.
 *
 * A photograph with no hash — everything the administrator added, everything
 * accepted from the Inbox, and everything that predates this — is owned by
 * nobody, so the family can never trash it (decision 3).
 */
export function isOwnedBy(photo: PhotoRecord, hash: string | null): boolean {
  if (hash === null || !photo.uploaderHash) return false;
  return secureEquals(photo.uploaderHash, hash);
}
