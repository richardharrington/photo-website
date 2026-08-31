/**
 * An in-memory ObjectStore with deliberately explicit conditional-write
 * semantics.
 *
 * implementation-plan.md requires that conflict-retry tests run against this
 * rather than Miniflare's emulated R2, whose `onlyIf` handling has been
 * reported inverted (workers-sdk#6411, closed as not planned). Testing against
 * an emulator with backwards semantics would let a backwards implementation
 * pass (decisions.md #22).
 *
 * The semantics asserted here, which the tests pin directly:
 *
 *   - `{ ifMatch }` succeeds only when the stored ETag matches, and the
 *     object exists.
 *   - `{ ifAbsent: true }` succeeds only when no object exists.
 *   - A failed precondition returns `{ ok: false }`. It never throws, and it
 *     never writes.
 *   - Every successful write produces a *new* ETag, so a stale one is
 *     detectably stale.
 */

import { etagsMatch } from '../src/shared/store.ts';
import type {
  ConditionalWriteResult,
  ObjectStore,
  ObjectSummary,
  StoredObject,
  WriteCondition,
} from '../src/shared/store.ts';

interface Entry {
  body: Uint8Array;
  etag: string;
  contentType: string;
  uploadedAt: Date;
}

export interface InMemoryStoreOptions {
  /** Fixed clock, so uploadedAt values are deterministic in tests. */
  now?: () => Date;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly entries = new Map<string, Entry>();
  private etagCounter = 0;
  private readonly now: () => Date;

  /** Every call, in order. Lets a test assert that a retry actually retried. */
  readonly calls: string[] = [];

  /**
   * Runs immediately before a conditional write is evaluated. A test uses this
   * to slip a competing write in between another writer's read and its write,
   * which is the race the retry loop exists for.
   */
  onBeforeConditionalWrite: (() => void | Promise<void>) | null = null;

  constructor(options: InMemoryStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    // Quoted, like a real S3/R2 ETag, so callers that forget to normalize are
    // caught here rather than in production.
    return `"etag-${this.etagCounter}"`;
  }

  async get(key: string): Promise<StoredObject | null> {
    this.calls.push(`get ${key}`);
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { body: entry.body, etag: entry.etag };
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    this.calls.push(`head ${key}`);
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { size: entry.body.byteLength, etag: entry.etag };
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.calls.push(`put ${key}`);
    this.entries.set(key, {
      body,
      contentType,
      etag: this.nextEtag(),
      uploadedAt: this.now(),
    });
  }

  async putConditional(
    key: string,
    body: Uint8Array,
    condition: WriteCondition,
    contentType: string,
  ): Promise<ConditionalWriteResult> {
    this.calls.push(`putConditional ${key}`);
    if (this.onBeforeConditionalWrite) await this.onBeforeConditionalWrite();

    const existing = this.entries.get(key);

    if ('ifAbsent' in condition) {
      if (existing) return { ok: false };
    } else if (!existing || !etagsMatch(existing.etag, condition.ifMatch)) {
      return { ok: false };
    }

    const etag = this.nextEtag();
    this.entries.set(key, { body, contentType, etag, uploadedAt: this.now() });
    return { ok: true, etag };
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    this.calls.push(`list ${prefix}`);
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({
        key,
        size: entry.body.byteLength,
        uploadedAt: entry.uploadedAt,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async delete(keys: readonly string[]): Promise<void> {
    this.calls.push(`delete ${keys.join(',')}`);
    for (const key of keys) this.entries.delete(key);
  }

  // ---- Test helpers -----------------------------------------------------

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  etagOf(key: string): string | null {
    return this.entries.get(key)?.etag ?? null;
  }

  /** Writes an object directly, bypassing conditions. Sets up a scenario. */
  seed(key: string, body: Uint8Array, uploadedAt?: Date): void {
    this.entries.set(key, {
      body,
      contentType: 'application/json; charset=utf-8',
      etag: this.nextEtag(),
      uploadedAt: uploadedAt ?? this.now(),
    });
  }

  readJson<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return JSON.parse(new TextDecoder().decode(entry.body)) as T;
  }
}
