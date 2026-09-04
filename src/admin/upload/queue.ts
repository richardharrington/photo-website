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
 *
 * The queue is also what the administrator sees and edits during an upload.
 * Every dropped file's EXIF is read up front, before the serial loop reaches
 * it, so a tile can show its capture date within a moment of the drop rather
 * than when its turn comes round; and a date or caption typed while a file is
 * still in flight is carried into that file's own commit, so the photograph is
 * never stored with a date its owner has already corrected. See `pending.ts`
 * for the projection the grid renders.
 */

import { UPLOAD_CONCURRENCY } from '../../shared/constants.ts';
import type { Rendition } from '../../shared/constants.ts';
import type { DerivativeDescriptor } from '../../shared/catalog.ts';
import type { EncodedArtifact, SourceMetadata } from '../../pipeline/index.ts';
import type { ProcessOutcome, ProcessedPhoto } from '../../pipeline/index.ts';
import type { PhotoEdit } from '../../shared/ui/curation.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';
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

/**
 * The encoded artifacts, held as object URLs so the tile and the photo view
 * can show the picture before it has been uploaded.
 *
 * Two renditions rather than four: the thumbnail for the grid and the 1280 for
 * the photo view. The `full` and 2560 artifacts are the large ones and are
 * dropped as soon as they are uploaded, so what a batch keeps alive is roughly
 * a quarter of a megabyte a photograph, until it is cleared.
 */
export interface PendingPreview {
  thumbUrl: string;
  displayUrl: string;
  /** The true shapes, replacing the placeholder the tile started with. */
  derivatives: Record<Rendition, DerivativeDescriptor>;
}

export interface QueueItem {
  id: string;
  file: File;
  /** Position in the drop or selection, which becomes selectionIndex. */
  selectionIndex: number;
  state: ItemState;
  /** 0 to 1 across processing and uploading, for the per-file bar. */
  progress: number;
  /**
   * What the photograph says about itself, read ahead of the serial loop so a
   * tile can show its date immediately. `null` only in the moment between the
   * drop and that read.
   */
  source: SourceMetadata | null;
  /**
   * What the administrator typed and saved, which outranks `source` and is
   * carried into this file's commit — or applied as an ordinary edit, if the
   * commit has already happened.
   */
  edit: PhotoEdit | null;
  /** The picture, once the encoders have produced it. */
  preview: PendingPreview | null;
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
    options: { onProgress(fraction: number): void; metadata: SourceMetadata },
  ): Promise<ProcessOutcome>;
  /** Read ahead of processing, and handed back to it rather than read twice. */
  readMetadata(file: File): Promise<SourceMetadata>;
  /** For an edit typed after this file's own commit has already gone. */
  editPhoto(photoId: string, edit: PhotoEdit): Promise<PublicPhoto>;
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
    const added: string[] = [];
    for (const [index, file] of files.entries()) {
      const id = `item-${(nextItemId += 1)}`;
      added.push(id);
      this.items.push({
        id,
        file,
        selectionIndex: offset + index,
        state: 'queued',
        progress: 0,
        source: null,
        edit: null,
        preview: null,
      });
    }
    this.emit();

    // Before the work starts, not as part of it. Reading EXIF is a header
    // parse, not a decode, so the whole drop can be read in the time one file
    // takes to encode — and until it is read, a tile has a filename and no
    // date, which is exactly the photo whose date most needs correcting.
    await this.readSources(added);
    await this.run();
  }

  /** Read what each of these files says about itself, in order, ignoring
   *  anything already read by a processing loop that got there first. */
  private async readSources(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item || item.source) continue;
      // `readSourceMetadata` reports absent or malformed EXIF as an empty
      // timestamp rather than throwing, so there is nothing to catch here.
      this.update(id, { source: await this.deps.readMetadata(item.file) });
    }
  }

  /**
   * Record what the administrator typed for one file, wherever it has got to.
   *
   * Two cases, and the difference is meant to be invisible. A file that has
   * not committed yet simply carries the values into its own commit, so what
   * was typed during the upload is what lands — no second request, and no
   * window in which the photograph exists with a date already known to be
   * wrong. A file that has committed is an ordinary edit of an ordinary photo.
   *
   * The one moment it refuses is while the commit is actually in flight: the
   * body has been built by then and cannot be amended, and saying so is better
   * than either losing the edit or claiming to have stored it.
   */
  async edit(id: string, edit: PhotoEdit): Promise<QueueItem> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error('That file is no longer in the queue.');
    if (item.state === 'committing') {
      throw new Error('That photo is being saved right now. Try again in a moment.');
    }

    if (!item.photoId) {
      this.update(id, { edit });
      return this.require(id);
    }

    const photo = await this.deps.editPhoto(item.photoId, edit);
    // What was stored, which is not always what was typed: a caption is
    // trimmed, and clearing the date clears the time.
    this.update(id, {
      edit: {
        date: photo.captureDate,
        time: photo.captureTime,
        caption: photo.caption,
      },
    });
    return this.require(id);
  }

  /**
   * Forget the files that are now in the library.
   *
   * Called once a batch has settled *and* the timeline has been reloaded, so
   * the photographs never disappear from the page between the two. What is
   * left behind is the exceptions — a failure with its Retry, a duplicate with
   * its link — which are the only rows still worth a glance.
   */
  clearCommitted(): void {
    this.remove((item) => item.state === 'done');
  }

  /** Forget everything that is not still in flight. */
  clear(): void {
    this.remove((item) => !IN_FLIGHT.has(item.state));
  }

  private remove(matches: (item: QueueItem) => boolean): void {
    const kept: QueueItem[] = [];
    for (const item of this.items) {
      if (matches(item)) revokePreview(item);
      else kept.push(item);
    }
    if (kept.length === this.items.length) return;
    this.items = kept;
    this.emit();
  }

  private require(id: string): QueueItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error('That file is no longer in the queue.');
    return item;
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

        // Normally already read by `add`. Not so for a file added to a batch
        // that was already running, which this loop can reach first.
        if (!item.source) await this.readSources([item.id]);
        const metadata = this.require(item.id).source!;

        let outcome: ProcessOutcome;
        try {
          outcome = await this.deps.processFile(item.file, {
            onProgress: (fraction) =>
              this.update(item.id, { progress: fraction * 0.5 }),
            metadata,
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

        // The picture, from the artifacts about to be uploaded. Held from
        // here until the item is cleared, so the tile stops being a grey
        // rectangle well before the PUTs finish.
        revokePreview(item);
        this.update(item.id, { preview: previewOf(outcome.photo) });

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

      // Set before the edit is read, and `edit` refuses while it is set, so
      // nothing can be typed into the gap between reading it and sending it.
      this.update(item.id, { state: 'committing', progress: 0.95 });

      // What the administrator typed while this file was in flight, if
      // anything, in place of what the photograph said about itself.
      const typed = this.require(item.id).edit;
      const captureDate = typed ? typed.date : photo.captureDate;
      const captureTime = typed ? typed.time : photo.captureTime;

      const result = await this.deps.commit({
        photoId: prepared.photoId!,
        contentHash: photo.contentHash,
        originalFilename: photo.originalFilename,
        sourceMimeType: photo.sourceMimeType,
        captureDate,
        captureTime,
        captureUtcOffset: photo.captureUtcOffset,
        // The same rule the edit endpoint applies: a correction outranks
        // whatever was read at ingest, and recording that keeps a later
        // re-derivation from silently undoing it.
        timestampSource:
          captureDate === photo.captureDate && captureTime === photo.captureTime
            ? photo.timestampSource
            : 'manual',
        caption: typed?.caption ?? null,
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

/** States in which a file is still on its way into the library. */
const IN_FLIGHT: ReadonlySet<ItemState> = new Set<ItemState>([
  'queued',
  'processing',
  'uploading',
  'committing',
]);

/** Whether this file is still working, for the tile's progress bar. */
export function isInFlight(state: ItemState): boolean {
  return IN_FLIGHT.has(state);
}

/** The two renditions worth keeping in memory; see `PendingPreview`. */
function previewOf(photo: ProcessedPhoto): PendingPreview {
  const blobUrl = (rendition: Rendition): string => {
    const artifact = photo.artifacts.find((each) => each.rendition === rendition);
    if (!artifact) throw new Error(`The pipeline produced no ${rendition}.`);
    return URL.createObjectURL(
      new Blob([artifact.bytes as BlobPart], { type: artifact.contentType }),
    );
  };
  return {
    thumbUrl: blobUrl('thumb'),
    displayUrl: blobUrl('display-1280'),
    derivatives: photo.derivatives,
  };
}

/** An object URL is a document-lifetime reference; dropping the item is not
 *  enough to release the bytes behind it. */
function revokePreview(item: QueueItem): void {
  if (!item.preview) return;
  URL.revokeObjectURL(item.preview.thumbUrl);
  URL.revokeObjectURL(item.preview.displayUrl);
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
