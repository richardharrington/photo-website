/**
 * Decoding one file far enough to look at it, and no further.
 *
 * The Inbox previews an emailed part from the thumbnail its camera embedded,
 * which costs a Range request and no decode at all. A HEIC has no such
 * thumbnail — it keeps one as an HEVC item in the ISO container, which is not
 * something a browser can paint (decisions.md #84) — so for those, and for
 * PNGs and screenshots, the only way to see the picture is to decode it.
 *
 * That is what this is: an explicit, one-at-a-time, administrator-initiated
 * decode. It is **not** the upload pipeline and produces nothing that is
 * stored. It decodes, orients, converts colour, shrinks to a preview size, and
 * hands back an object URL — skipping the four WASM encodes entirely, and the
 * full-resolution JPEG in particular, which dominates the pipeline's cost.
 *
 * Two rules carry over from `processFile` and neither is optional:
 *
 *  - **Validate from the header before decoding.** An oversized image must be
 *    refused without first exhausting memory (decisions.md #21). The Worker
 *    already caps a stored part at `MAX_SOURCE_BYTES`, but nothing has yet
 *    looked at its pixel dimensions.
 *  - **One decode at a time, ever.** Several simultaneous large decodes are the
 *    memory risk that crashed Firefox on a fourth consecutive file
 *    (decisions.md #20, #21). Every call here queues behind the last, whether
 *    it came from one Show button, six of them, or a Show all.
 */

import { decodeToSrgb } from './decode.ts';
import { scaledSize } from './encode.ts';
import { readSourceMetadata } from './metadata.ts';
import { HEADER_PROBE_BYTES, validateSource } from './validate.ts';
import type { Rejection } from './validate.ts';

/**
 * Longest edge of a decoded preview.
 *
 * Larger than the stored thumbnail's 400 px, because this one has to answer
 * "is this the photograph I think it is" on a card rather than fill a grid
 * cell, and because having paid for the decode there is no reason to throw the
 * detail away. Still small enough that the object URL behind it is tens of
 * kilobytes.
 */
export const PREVIEW_MAX_EDGE = 640;

export interface DecodedPreview {
  /** Object URL for a JPEG of the decoded image. The caller revokes it. */
  url: string;
  width: number;
  height: number;
}

export type PreviewOutcome = { ok: true; preview: DecodedPreview } | Rejection;

/**
 * The queue that keeps decodes serial.
 *
 * A promise chain rather than a worker pool, because the pool size is one and
 * always will be. Each call links onto the tail; a failure is caught so one
 * rejected decode cannot break the chain for everything queued behind it.
 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` after everything already queued, whatever became of it.
 *
 * Exported as a test seam: the serial rule is the load-bearing part of this
 * module (decisions.md #21) and it is the one piece of it that can be
 * exercised without a browser, a WASM decoder, or a real photograph.
 */
export function runSerially<T>(work: () => Promise<T>): Promise<T> {
  // `then(work, work)` rather than `then(work)`: a rejected predecessor must
  // still let its successor start, or one failed decode would wedge the queue
  // for the rest of the session.
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}

/**
 * Decode one file and hand back a small picture of it.
 *
 * Rejections are returned rather than thrown, exactly as `processFile` returns
 * them: "that image is 80 megapixels" is an answer about this file, not a
 * failure of the page. A genuinely broken decoder still throws.
 */
export function decodePreview(file: File): Promise<PreviewOutcome> {
  return runSerially(() => decodeOne(file));
}

async function decodeOne(file: File): Promise<PreviewOutcome> {
  // Header first, and the whole file only once the size is known to be sane.
  const headerBytes = new Uint8Array(
    await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer(),
  );
  const validation = validateSource(file.size, headerBytes);
  if (!validation.ok) return validation;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await readSourceMetadata(file, file.name);

  const decoded = await decodeToSrgb(file, bytes, {
    format: validation.format,
    storedDimensions: validation.dimensions,
    orientation: metadata.orientation,
    colorProfile: metadata.colorProfile,
  });

  const size = scaledSize(decoded.width, decoded.height, PREVIEW_MAX_EDGE);

  // The browser's own scaler and encoder, not the WASM ones. Nothing here is
  // stored, so byte-for-byte reproducibility across machines — the reason
  // decisions.md #2 chose mozjpeg and libwebp — buys nothing, and this way the
  // codecs are not loaded at all for an administrator who only wants a look.
  const bitmap = await createImageBitmap(decoded.data, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high',
  });

  let blob: Blob;
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a 2D drawing context.');
    context.drawImage(bitmap, 0, 0);
    // JPEG rather than WebP: Safari cannot encode WebP through a canvas
    // (decisions.md #2), and this one is thrown away when the card closes.
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  } finally {
    // Per-file memory release cannot be assumed across a run of these; drop
    // the decoded bitmap the moment it has been drawn.
    bitmap.close();
  }

  return {
    ok: true,
    preview: {
      url: URL.createObjectURL(blob),
      width: size.width,
      height: size.height,
    },
  };
}
