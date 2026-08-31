/**
 * The storage seam.
 *
 * Two very different clients reach R2 — the S3 API from Netlify Functions and
 * the native binding from the Cloudflare Worker — and they report a failed
 * conditional write in structurally different ways: the S3 path throws an
 * HTTP 412, while the binding *returns `null` without throwing*
 * (decisions.md #22). A bare try/catch is therefore wrong on the binding
 * path, and a bare "did it throw?" check is wrong on the S3 path.
 *
 * This interface normalizes that difference to one value, so the retry logic
 * above it never has to know which client it is talking to. Each adapter is
 * responsible for its own translation, and each is tested for it.
 */

export interface StoredObject {
  body: Uint8Array;
  etag: string;
}

export interface ObjectSummary {
  key: string;
  size: number;
  uploadedAt: Date;
}

/**
 * The precondition for a conditional write.
 *
 * `ifMatch` guards an update against a concurrent change; `ifAbsent` creates
 * an object only when nothing is there, which is how the very first catalog
 * is written without racing a second writer doing the same.
 */
export type WriteCondition = { ifMatch: string } | { ifAbsent: true };

export type ConditionalWriteResult =
  | { ok: true; etag: string }
  /**
   * The precondition failed: someone else wrote first. Not an error — it is
   * the expected outcome of a race, and the caller's job is to reload and
   * retry against what is now there.
   */
  | { ok: false };

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;

  /** Unconditional write. Used for snapshots and audit records, which are
   * written to fresh, uniquely named keys and cannot collide. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;

  putConditional(
    key: string,
    body: Uint8Array,
    condition: WriteCondition,
    contentType: string,
  ): Promise<ConditionalWriteResult>;

  list(prefix: string): Promise<ObjectSummary[]>;
  delete(keys: readonly string[]): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

/**
 * R2 and S3 quote ETags, and sometimes prefix a weak validator with `W/`.
 * Comparisons must survive that, or every conditional write would look like a
 * conflict against an ETag the same store just handed out.
 */
export function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

export function etagsMatch(a: string, b: string): boolean {
  return normalizeEtag(a) === normalizeEtag(b);
}
