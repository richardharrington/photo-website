/**
 * Reading pixel dimensions from container headers, **before** decoding.
 *
 * decisions.md #21: the megapixel guard has to read header dimensions before a
 * full decode, or an oversized file exhausts memory before the check meant to
 * prevent exactly that can fire. Decoding first and measuring afterwards is
 * not a guard, it is a report on the crash.
 *
 * So this parses just enough of each container to find the image size, and
 * touches no pixel data at all.
 */

export interface SourceDimensions {
  width: number;
  height: number;
}

export type DimensionResult =
  { ok: true; dimensions: SourceDimensions } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** IHDR is required to be the first chunk, so width/height sit at a fixed offset. */
function readPngDimensions(view: DataView, bytes: Uint8Array): DimensionResult {
  if (bytes.byteLength < 24) return { ok: false, reason: 'PNG header is truncated.' };
  const ihdr = String.fromCharCode(...bytes.slice(12, 16));
  if (ihdr !== 'IHDR') return { ok: false, reason: 'PNG is missing its IHDR chunk.' };
  return {
    ok: true,
    dimensions: { width: view.getUint32(16), height: view.getUint32(20) },
  };
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * Frame markers that carry dimensions. SOF4 (0xC4, DHT), SOF8 (0xC8,
 * reserved), and SOF12 (0xCC, DAC) are *not* start-of-frame markers despite
 * sitting in the same numeric range, and reading dimensions from them would
 * produce nonsense.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegDimensions(view: DataView, bytes: Uint8Array): DimensionResult {
  let offset = 2;

  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      // Resynchronize rather than give up: padding bytes between segments are
      // legal and common.
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data begins, and no frame header follows.
    if (marker === 0xda) break;

    const length = view.getUint16(offset + 2);
    if (length < 2) return { ok: false, reason: 'JPEG segment length is invalid.' };

    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.byteLength) {
        return { ok: false, reason: 'JPEG frame header is truncated.' };
      }
      return {
        ok: true,
        dimensions: {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        },
      };
    }

    offset += 2 + length;
  }

  return { ok: false, reason: 'JPEG has no frame header.' };
}

// ---------------------------------------------------------------------------
// HEIF / HEIC (ISO base media file format)
// ---------------------------------------------------------------------------

export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  if (String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return false;
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  return [
    'heic',
    'heix',
    'hevc',
    'hevx',
    'heim',
    'heis',
    'hevm',
    'hevs',
    'mif1',
    'msf1',
  ].includes(brand);
}

/** Boxes that contain other boxes and must be descended into. */
const CONTAINER_BOXES = new Set(['meta', 'iprp', 'ipco']);

/**
 * Collect every `ispe` (image spatial extents) box.
 *
 * An Apple HEIC holds several: the composited `grid` image, each of its
 * tiles, and sometimes a thumbnail or an HDR gain map. The largest is the one
 * the decoder will produce, and taking the maximum is also the conservative
 * choice for a guard — it can only over-estimate, never under-estimate, so it
 * cannot let an oversized image through.
 */
function collectIspeBoxes(
  view: DataView,
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  found: SourceDimensions[],
): void {
  // Malformed input must not drive this into unbounded recursion.
  if (depth > 8) return;

  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    let headerSize = 8;

    if (size === 1) {
      // 64-bit extended size. Anything above 2^32 is beyond what a photo needs
      // and beyond what a browser can address here, so refuse rather than
      // silently truncate.
      if (offset + 16 > end) return;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      if (high !== 0) return;
      size = low;
      headerSize = 16;
    } else if (size === 0) {
      // Extends to the end of the file.
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) return;

    if (type === 'ispe') {
      // FullBox: a version byte and three flag bytes precede the fields.
      if (offset + headerSize + 12 <= end) {
        found.push({
          width: view.getUint32(offset + headerSize + 4),
          height: view.getUint32(offset + headerSize + 8),
        });
      }
    } else if (CONTAINER_BOXES.has(type)) {
      // `meta` is a FullBox, so its children start four bytes later.
      const childStart = offset + headerSize + (type === 'meta' ? 4 : 0);
      collectIspeBoxes(view, bytes, childStart, offset + size, depth + 1, found);
    }

    offset += size;
  }
}

function readHeifDimensions(view: DataView, bytes: Uint8Array): DimensionResult {
  const found: SourceDimensions[] = [];
  collectIspeBoxes(view, bytes, 0, bytes.byteLength, 0, found);

  if (found.length === 0) {
    return { ok: false, reason: 'HEIF file has no image size box.' };
  }

  const largest = found.reduce((best, candidate) =>
    candidate.width * candidate.height > best.width * best.height ? candidate : best,
  );
  return { ok: true, dimensions: largest };
}

// ---------------------------------------------------------------------------

export type SourceFormat = 'jpeg' | 'png' | 'heif';

export function detectFormat(bytes: Uint8Array): SourceFormat | null {
  if (isJpeg(bytes)) return 'jpeg';
  if (isPng(bytes)) return 'png';
  if (isHeif(bytes)) return 'heif';
  return null;
}

/**
 * Read dimensions from a container header.
 *
 * Only the first part of the file is needed — a few kilobytes covers every
 * format here — so a caller can pass a prefix rather than the whole file.
 */
export function readDimensions(bytes: Uint8Array): DimensionResult {
  if (bytes.byteLength < 16)
    return { ok: false, reason: 'File is too short to be an image.' };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = detectFormat(bytes);

  switch (format) {
    case 'png':
      return readPngDimensions(view, bytes);
    case 'jpeg':
      return readJpegDimensions(view, bytes);
    case 'heif':
      return readHeifDimensions(view, bytes);
    default:
      return {
        ok: false,
        reason: 'That file is not a JPEG, PNG, or HEIC image.',
      };
  }
}
