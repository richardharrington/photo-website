/**
 * The upload queue.
 *
 * The concurrency split here is the whole point, and it is not an
 * optimization detail (decisions.md #21):
 *
 *   - **Processing is strictly serial.** Decode and encode run one file at a
 *     time. Several simultaneous large decodes are a memory risk, and
 *     Firefox's crash on a fourth consecutive file showed that per-file memory
 *     release cannot be assumed.
 *   - **Uploads are concurrent.** Once a file's artifacts exist they are just
 *     bytes; several PUTs in flight is what makes a batch finish in reasonable
 *     time.
 *
 * So one processing loop feeds a bounded pool of uploaders.
 */

import { UPLOAD_CONCURRENCY } from '../../shared/constants.ts';
import type { Rendition } from '../../shared/constants.ts';
import type { DerivativeDescriptor } from '../../shared/catalog.ts';
import type { EncodedArtifact } from '../../pipeline/index.ts';
import type { ProcessOutcome } from '../../pipeline/index.ts';
import type { PrepareResult, CommitResult } from '../api.ts';

export type ItemState =
  | 'queued'
  | 'processing'
  | 'uploading'
  | 'committing'
  | 'done'
  /** Already in the catalog. Neutral, with a link — not an error. */
  | 'skipped'
  | 'failed';

export interface QueueItem {
  id: string;
  file: File;
  /** Position in the drop or selection, which becomes selectionIndex. */
  selectionIndex: number;
  state: ItemState;
  /** 0 to 1 across processing and uploading, for the per-file bar. */
  progress: number;
  /** Set for `skipped`: the photo already in the catalog. */
  existingPhotoId?: string;
  /** Set for `done`. */
  photoId?: string;
  /** Set for `failed`, and shown to the administrator. */
  error?: string;
  /** True once a failure has been retried, so the UI can say so. */
  retried?: boolean;
}

export interface QueueSnapshot {
  items: QueueItem[];
  batchSeq: number | null;
  /** True while anything is still in flight. */
  active: boolean;
  counts: Record<ItemState, number>;
}

/**
 * Everything the queue talks to. Injected so the whole state machine can be
 * tested without a browser, a network, or a WASM codec.
 */
export interface QueueDependencies {
  processFile(
    file: File,
    options: { onProgress(fraction: number): void },
  ): Promise<ProcessOutcome>;
  beginBatch(): Promise<{ batchSeq: number }>;
  prepare(contentHash: string, originalFilename: string): Promise<PrepareResult>;
  uploadArtifact(url: string, artifact: EncodedArtifact): Promise<void>;
  commit(body: CommitBody): Promise<CommitResult>;
}

export interface CommitBody {
  photoId: string;
  contentHash: string;
  originalFilename: string;
  sourceMimeType: string;
  captureDate: string | null;
  captureTime: string | null;
  captureUtcOffset: string | null;
  timestampSource: string;
  caption: string | null;
  batchSeq: number;
  selectionIndex: number;
  derivatives: Record<Rendition, DerivativeDescriptor>;
}

const EMPTY_COUNTS: Record<ItemState, number> = {
  queued: 0,
  processing: 0,
  uploading: 0,
  committing: 0,
  done: 0,
  skipped: 0,
  failed: 0,
};

let nextItemId = 0;

export class UploadQueue {
  private items: QueueItem[] = [];
  private batchSeq: number | null = null;
  private running = false;
  private readonly listeners = new Set<(snapshot: QueueSnapshot) => void>();

  constructor(
    private readonly deps: QueueDependencies,
    private readonly uploadConcurrency = UPLOAD_CONCURRENCY,
  ) {}

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): QueueSnapshot {
    const counts = { ...EMPTY_COUNTS };
    for (const item of this.items) counts[item.state] += 1;
    return {
      items: [...this.items],
      batchSeq: this.batchSeq,
      active: this.running,
      counts,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private update(id: string, patch: Partial<QueueItem>): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    this.items[index] = { ...this.items[index]!, ...patch };
    this.emit();
  }

  /**
   * Add files and start working through them.
   *
   * `selectionIndex` comes from position in this drop, and combines with the
   * server-assigned batch number to give date-only photos a stable order
   * across batches (decisions.md #10).
   */
  async add(files: readonly File[]): Promise<void> {
    const offset = this.items.length;
    for (const [index, file] of files.entries()) {
      this.items.push({
        id: `item-${(nextItemId += 1)}`,
        file,
        selectionIndex: offset + index,
        state: 'queued',
        progress: 0,
      });
    }
    this.emit();
    await this.run();
  }

  /** Retry one failed file. */
  async retry(id: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.state !== 'failed') return;
    this.update(id, { state: 'queued', progress: 0, error: undefined, retried: true });
    await this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit();

    const uploads: Promise<void>[] = [];

    try {
      let next = this.items.find((item) => item.state === 'queued');
      while (next) {
        const item = next;

        // --- Serial half: decode, orient, convert, encode, hash.
        this.update(item.id, { state: 'processing', progress: 0 });
        let outcome: ProcessOutcome;
        try {
          outcome = await this.deps.processFile(item.file, {
            onProgress: (fraction) =>
              this.update(item.id, { progress: fraction * 0.5 }),
          });
        } catch (error) {
          this.fail(item.id, error);
          next = this.items.find((candidate) => candidate.state === 'queued');
          continue;
        }

        if (!outcome.ok) {
          this.update(item.id, { state: 'failed', error: outcome.message });
          next = this.items.find((candidate) => candidate.state === 'queued');
          continue;
        }

        // --- Concurrent half: upload and commit.
        //
        // Bounded so a large drop does not open hundreds of connections. The
        // await happens *before* starting the next upload, not before
        // processing the next file, so the serial loop keeps running.
        if (uploads.length >= this.uploadConcurrency) {
          await Promise.race(uploads);
        }

        const upload = this.uploadAndCommit(item, outcome.photo).finally(() => {
          const index = uploads.indexOf(upload);
          if (index !== -1) uploads.splice(index, 1);
        });
        uploads.push(upload);

        next = this.items.find((candidate) => candidate.state === 'queued');
      }

      await Promise.all(uploads);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private async uploadAndCommit(
    item: QueueItem,
    photo: Extract<ProcessOutcome, { ok: true }>['photo'],
  ): Promise<void> {
    try {
      this.update(item.id, { state: 'uploading', progress: 0.5 });

      const prepared = await this.deps.prepare(
        photo.contentHash,
        photo.originalFilename,
      );
      if (prepared.status === 'duplicate') {
        // Neutral, not an error: re-dropping a folder is the documented way
        // to resume an interrupted batch (decisions.md #7).
        this.update(item.id, {
          state: 'skipped',
          progress: 1,
          existingPhotoId: prepared.existingId!,
        });
        return;
      }

      this.batchSeq ??= (await this.deps.beginBatch()).batchSeq;

      const uploads = prepared.uploads!;
      let uploaded = 0;
      for (const artifact of photo.artifacts) {
        await this.deps.uploadArtifact(uploads[artifact.rendition]!, artifact);
        uploaded += 1;
        this.update(item.id, {
          progress: 0.5 + (uploaded / photo.artifacts.length) * 0.45,
        });
      }

      this.update(item.id, { state: 'committing', progress: 0.95 });

      const result = await this.deps.commit({
        photoId: prepared.photoId!,
        contentHash: photo.contentHash,
        originalFilename: photo.originalFilename,
        sourceMimeType: photo.sourceMimeType,
        captureDate: photo.captureDate,
        captureTime: photo.captureTime,
        captureUtcOffset: photo.captureUtcOffset,
        timestampSource: photo.timestampSource,
        caption: null,
        batchSeq: this.batchSeq,
        selectionIndex: item.selectionIndex,
        derivatives: photo.derivatives,
      });

      if (result.status === 'duplicate') {
        // The authoritative hash check, inside the conditional catalog write,
        // caught a race the advisory prepare check could not.
        this.update(item.id, {
          state: 'skipped',
          progress: 1,
          existingPhotoId: result.existingId!,
        });
        return;
      }

      this.update(item.id, {
        state: 'done',
        progress: 1,
        photoId: result.photo!.id,
      });
    } catch (error) {
      this.fail(item.id, error);
    }
  }

  private fail(id: string, error: unknown): void {
    this.update(id, {
      state: 'failed',
      error: error instanceof Error ? error.message : 'Something went wrong.',
    });
  }
}

/** Files that finished cleanly, for the "N added" summary. */
export function summarize(snapshot: QueueSnapshot): string {
  const { done, skipped, failed } = snapshot.counts;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} added`);
  if (skipped > 0) parts.push(`${skipped} already uploaded`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(', ');
}
