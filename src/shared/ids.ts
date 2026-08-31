/**
 * Identifier generation.
 *
 * Photo IDs are not merely unique, they are unguessable: `/p/<id>/thumb.webp`
 * is a capability URL, and the ID is the whole of the secret protecting that
 * photo (decisions.md #8). They therefore come from a CSPRNG, never from a
 * counter, a timestamp, or the content hash.
 */

/** 128 bits, hex-encoded. */
const PHOTO_ID_BYTES = 16;
const AUDIT_ID_BYTES = 8;

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }
  return out;
}

/**
 * Structural type for the one Web Crypto method used here.
 *
 * Declared locally rather than relying on a `lib` global, because this module
 * is compiled under three different TypeScript configurations — browser,
 * Node, and Workers — that disagree about how `globalThis.crypto` is typed.
 */
interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/**
 * `crypto.getRandomValues` is present in browsers, in Node 20+, and in
 * Workers. There is deliberately no `Math.random` fallback: silently
 * downgrading to a predictable generator would make every photo URL guessable,
 * with no visible failure to notice.
 */
function randomBytes(length: number): Uint8Array {
  const webcrypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (typeof webcrypto?.getRandomValues !== 'function') {
    throw new Error('A Web Crypto implementation is required to generate IDs.');
  }
  return webcrypto.getRandomValues(new Uint8Array(length));
}

export function generatePhotoId(): string {
  return toHex(randomBytes(PHOTO_ID_BYTES));
}

export function generateAuditId(): string {
  return toHex(randomBytes(AUDIT_ID_BYTES));
}

/** 32 lowercase hex characters. Used to reject malformed IDs before any I/O. */
const PHOTO_ID_RE = /^[0-9a-f]{32}$/;

export function isValidPhotoId(value: string): boolean {
  return PHOTO_ID_RE.test(value);
}

/**
 * A confirmation token for a destructive operation. Bound to an explicit photo
 * ID list by the caller, never to a re-runnable query (decisions.md #12).
 */
export function generateConfirmationToken(): string {
  return toHex(randomBytes(24));
}
