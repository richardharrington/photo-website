/**
 * Source-file validation, run before anything expensive.
 *
 * The order matters: size, then format, then header dimensions, and only then
 * a decode. Each check is cheaper than the one after it, and the megapixel
 * check specifically must complete before the decode it is protecting
 * (decisions.md #21).
 */

import {
  ACCEPTED_EXTENSIONS,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
} from '../shared/constants.ts';
import { detectFormat, readDimensions } from './dimensions.ts';
import type { SourceDimensions, SourceFormat } from './dimensions.ts';

export type RejectionCode =
  'too-large' | 'unsupported-format' | 'too-many-pixels' | 'unreadable';

export interface Rejection {
  ok: false;
  code: RejectionCode;
  /** Shown to the administrator, so it says what to do about it. */
  message: string;
}

export interface Accepted {
  ok: true;
  format: SourceFormat;
  dimensions: SourceDimensions;
}

export type ValidationOutcome = Accepted | Rejection;

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatMegapixels(pixels: number): string {
  return `${(pixels / 1_000_000).toFixed(1)} MP`;
}

/** Extension check, for the file picker and an early drop-target rejection. */
export function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Bytes needed for the header checks.
 *
 * A JPEG's frame header sits after its EXIF block, which can carry an
 * embedded thumbnail, and a HEIC's `iprp` box follows its item tables — so
 * this is generous rather than minimal. It is still a small read compared
 * with a 50 MB file.
 */
export const HEADER_PROBE_BYTES = 512 * 1024;

/**
 * Validate a source file from its size and a prefix of its bytes.
 *
 * Takes a prefix rather than a File so it can be tested without a browser,
 * and so a caller can avoid reading a 50 MB file into memory just to learn
 * that it is too large.
 */
export function validateSource(
  byteLength: number,
  headerBytes: Uint8Array,
): ValidationOutcome {
  if (byteLength > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      message:
        `That file is ${formatMegabytes(byteLength)}, over the ` +
        `${formatMegabytes(MAX_SOURCE_BYTES)} limit.`,
    };
  }

  const format = detectFormat(headerBytes);
  if (format === null) {
    return {
      ok: false,
      code: 'unsupported-format',
      message:
        'Only JPEG, PNG, and HEIC images can be uploaded. Video is not supported.',
    };
  }

  const dimensions = readDimensions(headerBytes);
  if (!dimensions.ok) {
    return { ok: false, code: 'unreadable', message: dimensions.reason };
  }

  const pixels = dimensions.dimensions.width * dimensions.dimensions.height;
  if (pixels > MAX_SOURCE_PIXELS) {
    return {
      ok: false,
      code: 'too-many-pixels',
      message:
        `That image is ${formatMegapixels(pixels)} ` +
        `(${dimensions.dimensions.width}x${dimensions.dimensions.height}), over the ` +
        `${formatMegapixels(MAX_SOURCE_PIXELS)} limit. Downsize it before uploading.`,
    };
  }

  return { ok: true, format, dimensions: dimensions.dimensions };
}
