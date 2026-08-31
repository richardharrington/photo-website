import { describe, it, expect, vi } from 'vitest';
import { UploadQueue, summarize } from '../../src/admin/upload/queue.ts';
import type { QueueDependencies, QueueSnapshot } from '../../src/admin/upload/queue.ts';
import type { ProcessOutcome } from '../../src/pipeline/index.ts';
import { RENDITIONS } from '../../src/shared/constants.ts';
import type { Rendition } from '../../src/shared/constants.ts';
import type { DerivativeDescriptor } from '../../src/shared/catalog.ts';

function fakeFile(name: string): File {
  return { name, size: 1000, type: 'image/heic' } as unknown as File;
}

const DERIVATIVES = Object.fromEntries(
  RENDITIONS.map((rendition) => [rendition, { width: 100, height: 100, bytes: 500 }]),
) as Record<Rendition, DerivativeDescriptor>;

function processed(hash: string): ProcessOutcome {
  return {
    ok: true,
    photo: {
      contentHash: hash,
      originalFilename: 'IMG.HEIC',
      sourceMimeType: 'image/heic',
      captureDate: '2026-08-02',
      captureTime: '12:00:00',
      captureUtcOffset: null,
      timestampSource: 'exif-datetimeoriginal',
      artifacts: RENDITIONS.map((rendition) => ({
        rendition,
        bytes: new Uint8Array(10),
        descriptor: DERIVATIVES[rendition],
        contentType: 'image/webp',
      })),
      derivatives: DERIVATIVES,
      hadGpsData: false,
    },
  };
}

interface Harness {
  deps: QueueDependencies;
  /** Every dependency call, in order. Lets a test assert on interleaving. */
  events: string[];
}

function makeDeps(overrides: Partial<QueueDependencies> = {}): Harness {
  const events: string[] = [];

  const deps: QueueDependencies = {
    processFile: vi.fn(async (file: File) => {
      events.push(`process:start:${file.name}`);
      await Promise.resolve();
      events.push(`process:end:${file.name}`);
      return processed(`hash-${file.name}`);
    }),
    beginBatch: vi.fn(async () => {
      events.push('beginBatch');
      return { batchSeq: 7 };
    }),
    prepare: vi.fn(async (hash: string) => {
      events.push(`prepare:${hash}`);
      return {
        status: 'ready' as const,
        photoId: `photo-${hash}`,
        uploads: Object.fromEntries(
          RENDITIONS.map((r) => [r, `https://r2.test/${hash}/${r}`]),
        ) as Record<Rendition, string>,
      };
    }),
    uploadArtifact: vi.fn(async (url: string) => {
      events.push(`upload:${url}`);
    }),
    commit: vi.fn(async (body) => {
      events.push(`commit:${body.contentHash}`);
      return { status: 'created' as const, photo: { id: body.photoId } as never };
    }),
    ...overrides,
  };

  return { deps, events };
}

async function drain(queue: UploadQueue, files: File[]): Promise<QueueSnapshot> {
  await queue.add(files);
  return queue.snapshot();
}

describe('processing is serial', () => {
  /**
   * decisions.md #21. Several simultaneous large decodes are a memory risk,
   * and Firefox's crash on a fourth consecutive file showed per-file memory
   * release cannot be assumed. Only uploads may overlap.
   */
  it('never has two files decoding at once', async () => {
    let inFlight = 0;
    let peak = 0;

    const { deps } = makeDeps({
      processFile: vi.fn(async (file: File) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return processed(`hash-${file.name}`);
      }),
    });

    const queue = new UploadQueue(deps);
    await drain(queue, ['a', 'b', 'c', 'd', 'e'].map(fakeFile));

    expect(peak).toBe(1);
  });

  it('processes files in the order they were dropped', async () => {
    const { deps, events } = makeDeps();
    const queue = new UploadQueue(deps);

    await drain(queue, ['a', 'b', 'c'].map(fakeFile));

    const starts = events.filter((e) => e.startsWith('process:start'));
    expect(starts).toEqual(['process:start:a', 'process:start:b', 'process:start:c']);
  });
});

describe('uploads are concurrent', () => {
  it('runs several uploads at once, up to the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    const { deps } = makeDeps({
      uploadArtifact: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }),
    });

    const queue = new UploadQueue(deps, 3);
    await drain(queue, ['a', 'b', 'c', 'd', 'e', 'f'].map(fakeFile));

    // More than one file's artifacts in flight, but never more files than the
    // configured concurrency.
    expect(peak).toBeGreaterThan(1);
  });

  it('does not exceed the configured file concurrency', async () => {
    let filesUploading = 0;
    let peak = 0;

    const { deps } = makeDeps({
      prepare: vi.fn(async (hash: string) => {
        filesUploading += 1;
        peak = Math.max(peak, filesUploading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          status: 'ready' as const,
          photoId: `photo-${hash}`,
          uploads: Object.fromEntries(
            RENDITIONS.map((r) => [r, `https://r2.test/${r}`]),
          ) as Record<Rendition, string>,
        };
      }),
      commit: vi.fn(async (body) => {
        filesUploading -= 1;
        return { status: 'created' as const, photo: { id: body.photoId } as never };
      }),
    });

    const queue = new UploadQueue(deps, 2);
    await drain(queue, ['a', 'b', 'c', 'd', 'e'].map(fakeFile));

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('batch and ordering', () => {
  it('reserves exactly one batch number for a whole drop', async () => {
    const { deps, events } = makeDeps();
    const queue = new UploadQueue(deps);

    await drain(queue, ['a', 'b', 'c'].map(fakeFile));

    expect(events.filter((e) => e === 'beginBatch')).toHaveLength(1);
  });

  it('assigns selection indexes from the drop order', async () => {
    const seen: number[] = [];
    const { deps } = makeDeps({
      commit: vi.fn(async (body) => {
        seen.push(body.selectionIndex);
        return { status: 'created' as const, photo: { id: body.photoId } as never };
      }),
    });

    const queue = new UploadQueue(deps);
    await drain(queue, ['a', 'b', 'c'].map(fakeFile));

    expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('continues numbering across a second drop', async () => {
    const seen: number[] = [];
    const { deps } = makeDeps({
      commit: vi.fn(async (body) => {
        seen.push(body.selectionIndex);
        return { status: 'created' as const, photo: { id: body.photoId } as never };
      }),
    });

    const queue = new UploadQueue(deps);
    await drain(queue, ['a', 'b'].map(fakeFile));
    await drain(queue, ['c'].map(fakeFile));

    expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('does not reserve a batch number when every file is a duplicate', async () => {
    // The counter is the only pre-commit write; spending one for a drop that
    // uploads nothing would be a pointless gap.
    const { deps, events } = makeDeps({
      prepare: vi.fn(async () => ({ status: 'duplicate' as const, existingId: 'old' })),
    });

    const queue = new UploadQueue(deps);
    await drain(queue, ['a', 'b'].map(fakeFile));

    expect(events).not.toContain('beginBatch');
  });
});

describe('duplicates', () => {
  it('marks a known file skipped, with a link, not as an error', async () => {
    // Re-dropping a folder is the documented way to resume an interrupted
    // batch (decisions.md #7), so this must read as neutral.
    const { deps } = makeDeps({
      prepare: vi.fn(async () => ({
        status: 'duplicate' as const,
        existingId: 'existing-photo',
      })),
    });

    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, [fakeFile('a')]);

    expect(snapshot.items[0]!.state).toBe('skipped');
    expect(snapshot.items[0]!.existingPhotoId).toBe('existing-photo');
    expect(snapshot.items[0]!.error).toBeUndefined();
    expect(snapshot.counts.failed).toBe(0);
  });

  it('uploads nothing for a duplicate', async () => {
    const { deps, events } = makeDeps({
      prepare: vi.fn(async () => ({ status: 'duplicate' as const, existingId: 'x' })),
    });

    const queue = new UploadQueue(deps);
    await drain(queue, [fakeFile('a')]);

    expect(events.some((e) => e.startsWith('upload:'))).toBe(false);
  });

  it('handles a duplicate discovered only at commit', async () => {
    // The authoritative check happens inside the conditional catalog write,
    // which catches a race the advisory prepare check cannot (decisions.md #6).
    const { deps } = makeDeps({
      commit: vi.fn(async () => ({
        status: 'duplicate' as const,
        existingId: 'raced-winner',
      })),
    });

    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, [fakeFile('a')]);

    expect(snapshot.items[0]!.state).toBe('skipped');
    expect(snapshot.items[0]!.existingPhotoId).toBe('raced-winner');
  });
});

describe('failures', () => {
  it('reports a rejected file with its reason and does not upload it', async () => {
    const { deps, events } = makeDeps({
      processFile: vi.fn(async () => ({
        ok: false as const,
        code: 'too-many-pixels' as const,
        message: 'That image is 60.0 MP, over the 50 MP limit.',
      })),
    });

    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, [fakeFile('huge.heic')]);

    expect(snapshot.items[0]!.state).toBe('failed');
    expect(snapshot.items[0]!.error).toContain('60.0 MP');
    expect(events.some((e) => e.startsWith('upload:'))).toBe(false);
  });

  it('keeps going after one file fails', async () => {
    let call = 0;
    const { deps } = makeDeps({
      processFile: vi.fn(async (file: File) => {
        call += 1;
        if (call === 2) throw new Error('decoder gave up');
        return processed(`hash-${file.name}`);
      }),
    });

    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, ['a', 'b', 'c'].map(fakeFile));

    expect(snapshot.counts.done).toBe(2);
    expect(snapshot.counts.failed).toBe(1);
  });

  it('reports an upload failure against the right file', async () => {
    const { deps } = makeDeps({
      uploadArtifact: vi.fn(async (url: string) => {
        if (url.includes('hash-b')) throw new Error('network died');
      }),
    });

    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, ['a', 'b'].map(fakeFile));

    const failed = snapshot.items.filter((item) => item.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.file.name).toBe('b');
    expect(failed[0]!.error).toBe('network died');
  });

  it('retries a failed file and can succeed the second time', async () => {
    let attempts = 0;
    const { deps } = makeDeps({
      processFile: vi.fn(async (file: File) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return processed(`hash-${file.name}`);
      }),
    });

    const queue = new UploadQueue(deps);
    let snapshot = await drain(queue, [fakeFile('a')]);
    expect(snapshot.items[0]!.state).toBe('failed');

    await queue.retry(snapshot.items[0]!.id);
    snapshot = queue.snapshot();

    expect(snapshot.items[0]!.state).toBe('done');
    expect(snapshot.items[0]!.retried).toBe(true);
  });

  it('ignores a retry for a file that did not fail', async () => {
    const { deps } = makeDeps();
    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, [fakeFile('a')]);

    await queue.retry(snapshot.items[0]!.id);
    expect(queue.snapshot().items[0]!.state).toBe('done');
  });
});

describe('snapshots', () => {
  it('notifies subscribers as work progresses', async () => {
    const { deps } = makeDeps();
    const queue = new UploadQueue(deps);
    const states: string[][] = [];

    const unsubscribe = queue.subscribe((snapshot) => {
      states.push(snapshot.items.map((item) => item.state));
    });

    await drain(queue, [fakeFile('a')]);
    unsubscribe();

    expect(states[0]).toEqual([]);
    expect(states.at(-1)).toEqual(['done']);
    expect(states.flat()).toContain('processing');
    expect(states.flat()).toContain('uploading');
  });

  it('reports the queue as idle once everything settles', async () => {
    const { deps } = makeDeps();
    const queue = new UploadQueue(deps);
    const snapshot = await drain(queue, ['a', 'b'].map(fakeFile));

    expect(snapshot.active).toBe(false);
    expect(snapshot.counts.queued).toBe(0);
  });
});

describe('summarize', () => {
  it('describes a mixed batch', () => {
    const snapshot = {
      items: [],
      batchSeq: 1,
      active: false,
      counts: {
        queued: 0,
        processing: 0,
        uploading: 0,
        committing: 0,
        done: 3,
        skipped: 2,
        failed: 1,
      },
    };

    expect(summarize(snapshot)).toBe('3 added, 2 already uploaded, 1 failed');
  });

  it('omits categories with nothing in them', () => {
    const snapshot = {
      items: [],
      batchSeq: 1,
      active: false,
      counts: {
        queued: 0,
        processing: 0,
        uploading: 0,
        committing: 0,
        done: 1,
        skipped: 0,
        failed: 0,
      },
    };

    expect(summarize(snapshot)).toBe('1 added');
  });
});
