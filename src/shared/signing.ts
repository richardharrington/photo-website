/**
 * HMAC signing, shared by the Netlify functions (which mint) and the
 * Cloudflare Worker (which verifies).
 *
 * Uses Web Crypto, which is present in Node 20+, in Workers, and in browsers,
 * so one implementation covers both tiers. `ASSET_SIGNING_KEY` is the only
 * secret the two share, and there are no service-to-service calls between
 * them — the signature travelling in a URL is the entire channel.
 */

interface CryptoLike {
  subtle: SubtleCryptoLike;
}

interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: BufferSource,
    algorithm: { name: 'HMAC'; hash: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKeyLike>;
  sign(algorithm: string, key: CryptoKeyLike, data: BufferSource): Promise<ArrayBuffer>;
}

type CryptoKeyLike = object;

const encoder = new TextEncoder();

function subtle(): SubtleCryptoLike {
  const webcrypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!webcrypto?.subtle) {
    throw new Error('A Web Crypto implementation is required for signing.');
  }
  return webcrypto.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await subtle().importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await subtle().sign('HMAC', cryptoKey, encoder.encode(message)));
}

/**
 * Constant-time comparison of two hex signatures.
 *
 * Unlike the path comparison in the gate — where a timing channel is
 * theoretical — this one compares an attacker-supplied value against a
 * computed MAC, which is the textbook case for a timing oracle.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Signed asset URLs
// ---------------------------------------------------------------------------

export interface AssetGrant {
  photoId: string;
  rendition: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * The signed payload. Every field that changes what is served is in it, so a
 * signature for a thumbnail cannot be replayed to fetch the full-resolution
 * original, and one for a trashed photo's thumbnail cannot be pointed at
 * another photo.
 */
function assetPayload(grant: AssetGrant): string {
  return `v1:${grant.photoId}:${grant.rendition}:${grant.expiresAt}`;
}

export async function signAssetGrant(key: string, grant: AssetGrant): Promise<string> {
  return hmacHex(key, assetPayload(grant));
}

/** Path and query for a signed asset URL, relative to the Worker origin. */
export function assetGrantPath(grant: AssetGrant, signature: string): string {
  const query = new URLSearchParams({
    exp: String(grant.expiresAt),
    sig: signature,
  });
  return `/d/${grant.photoId}/${grant.rendition}?${query.toString()}`;
}

export type GrantVerification =
  { ok: true } | { ok: false; reason: 'expired' | 'bad-signature' };

export async function verifyAssetGrant(
  key: string,
  grant: AssetGrant,
  signature: string,
  nowSeconds: number,
): Promise<GrantVerification> {
  const expected = await signAssetGrant(key, grant);
  // Signature first: an expiry check that short-circuits before the MAC would
  // let an attacker probe with unsigned URLs and learn from the difference.
  if (!timingSafeEqualHex(expected, signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (nowSeconds > grant.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Destructive-action confirmation tokens
// ---------------------------------------------------------------------------

/**
 * A confirmation token binds a destructive action to an **explicit list of
 * photo IDs**, never to a re-runnable query (decisions.md #12).
 *
 * The token is an HMAC over the sorted ID list and an expiry, and the confirm
 * request carries the list back. The server recomputes the MAC over what it
 * was given, so a photo committed between preview and confirm cannot be swept
 * in: it is not in the list the token covers, and adding it changes the MAC.
 *
 * This is deliberately stateless — no pending-operation records to expire,
 * clean up, or leak.
 */
export interface ConfirmationGrant {
  action: string;
  photoIds: readonly string[];
  /** Unix seconds. */
  expiresAt: number;
}

function confirmationPayload(grant: ConfirmationGrant): string {
  // Sorted so the token does not depend on the order the UI happened to
  // collect the selection in.
  const ids = [...grant.photoIds].sort().join(',');
  return `confirm:v1:${grant.action}:${grant.expiresAt}:${ids}`;
}

export async function signConfirmation(
  key: string,
  grant: ConfirmationGrant,
): Promise<string> {
  return hmacHex(key, confirmationPayload(grant));
}

export async function verifyConfirmation(
  key: string,
  grant: ConfirmationGrant,
  token: string,
  nowSeconds: number,
): Promise<GrantVerification> {
  const expected = await signConfirmation(key, grant);
  if (!timingSafeEqualHex(expected, token)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (nowSeconds > grant.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true };
}
