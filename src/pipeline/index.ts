/**
 * The browser image pipeline: one file in, four finished artifacts out.
 *
 * Everything here runs in the administrator's browser. The original source
 * file never leaves the machine — only the re-encoded artifacts are uploaded —
 * and because every artifact is re-encoded from decoded pixels, no EXIF or GPS
 * data survives into anything stored.
 *
 * Processing is **strictly serial, one file at a time** (decisions.md #21).
 * Several simultaneous large decodes are a memory risk, and Firefox's crash on
 * a fourth consecutive file showed that per-file memory release cannot be
 * assumed. The concurrency in the upload queue governs uploads only.
 */

import type { Rendition } from '../shared/constants.ts';
import type { DerivativeDescriptor, TimestampSource } from '../shared/catalog.ts';
import { downloadFilenameFor } from '../shared/filename.ts';
import { decodeToSrgb } from './decode.ts';
import { encodeArtifacts } from './encode.ts';
import type { EncodedArtifact } from './encode.ts';
import { sha256Hex } from './hash.ts';
import { readSourceMetadata } from './metadata.ts';
import { HEADER_PROBE_BYTES, validateSource } from './validate.ts';
import type { Rejection } from './validate.ts';

export interface ProcessedPhoto {
  contentHash: string;
  originalFilename: string;
  sourceMimeType: string;
  captureDate: string | null;
  captureTime: string | null;
  captureUtcOffset: string | null;
  timestampSource: TimestampSource;
  artifacts: EncodedArtifact[];
  derivatives: Record<Rendition, DerivativeDescriptor>;
  /** Whether the source carried GPS coordinates that were discarded. */
  hadGpsData: boolean;
}

export type ProcessOutcome = { ok: true; photo: ProcessedPhoto } | Rejection;

export type ProcessStage =
  'validating' | 'reading-metadata' | 'hashing' | 'decoding' | 'encoding';

export interface ProcessOptions {
  onStage?: (stage: ProcessStage) => void;
  onArtifact?: (rendition: Rendition) => void;
}

const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  heif: 'image/heic',
} as const;

/**
 * Process one file.
 *
 * Rejections are returned rather than thrown, because "this file is too big"
 * is an expected outcome for one item in a batch, not a failure of the batch.
 * Genuine faults — a corrupt file that gets past validation, a decoder that
 * cannot cope — still throw, and the queue reports them with a retry control.
 */
export async function processFile(
  file: File,
  options: ProcessOptions = {},
): Promise<ProcessOutcome> {
  const { onStage, onArtifact } = options;

  // 1. Validate from the header alone, before reading the whole file and long
  //    before decoding it. An oversized image must be rejected without first
  //    exhausting memory (decisions.md #21).
  onStage?.('validating');
  const headerBytes = new Uint8Array(
    await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer(),
  );
  const validation = validateSource(file.size, headerBytes);
  if (!validation.ok) return validation;

  // 2. Now that the size is known to be sane, read the whole file once and
  //    reuse those bytes for the hash and the decode.
  const bytes = new Uint8Array(await file.arrayBuffer());

  onStage?.('reading-metadata');
  const metadata = await readSourceMetadata(file, file.name);

  onStage?.('hashing');
  // Hashed from the *source* bytes, so re-dropping the same file is detected
  // regardless of what the encoders would produce today.
  const contentHash = await sha256Hex(bytes);

  onStage?.('decoding');
  const decoded = await decodeToSrgb(file, bytes, {
    format: validation.format,
    storedDimensions: validation.dimensions,
    orientation: metadata.orientation,
    colorProfile: metadata.colorProfile,
  });

  onStage?.('encoding');
  const artifacts = await encodeArtifacts(decoded.data, onArtifact);

  const derivatives = Object.fromEntries(
    artifacts.map((artifact) => [artifact.rendition, artifact.descriptor]),
  ) as Record<Rendition, DerivativeDescriptor>;

  return {
    ok: true,
    photo: {
      contentHash,
      originalFilename: file.name,
      sourceMimeType: MIME_BY_FORMAT[validation.format],
      captureDate: metadata.timestamp.date,
      captureTime: metadata.timestamp.time,
      captureUtcOffset: metadata.timestamp.utcOffset,
      timestampSource: metadata.timestamp.source,
      artifacts,
      derivatives,
      hadGpsData: metadata.hadGpsData,
    },
  };
}

export { downloadFilenameFor };
export type { EncodedArtifact, Rejection };
