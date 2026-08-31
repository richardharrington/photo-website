/**
 * Content hashing for duplicate detection.
 *
 * The hash is taken over the **source** bytes, not the encoded artifacts, so
 * re-dropping a folder is recognized regardless of what the encoders would
 * produce today. It stays internal to the catalog and never appears in a URL:
 * a hash of bytes the recipient may already hold would let them confirm
 * whether a particular file is in the library.
 */

interface SubtleCryptoLike {
  digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
}

function subtle(): SubtleCryptoLike {
  const webcrypto = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto;
  if (!webcrypto?.subtle) {
    throw new Error('A Web Crypto implementation is required to hash uploads.');
  }
  return webcrypto.subtle;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtle().digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}
