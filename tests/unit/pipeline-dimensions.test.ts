import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  isHeif,
  isJpeg,
  isPng,
  readDimensions,
} from '../../src/pipeline/dimensions.ts';
import { validateSource } from '../../src/pipeline/validate.ts';
import { MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS } from '../../src/shared/constants.ts';

// ---------------------------------------------------------------------------
// Synthetic headers. Only the bytes the parser reads are meaningful.
// ---------------------------------------------------------------------------

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * A JPEG with an APP1 segment before the frame header, so the parser has to
 * walk past a segment rather than find SOF0 immediately.
 */
function jpegHeader(width: number, height: number, marker = 0xc0): Uint8Array {
  const app1Length = 40;
  const bytes = new Uint8Array(2 + 2 + app1Length + 2 + 9 + 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  bytes[offset++] = 0xff;
  bytes[offset++] = 0xd8; // SOI

  bytes[offset++] = 0xff;
  bytes[offset++] = 0xe1; // APP1
  view.setUint16(offset, app1Length);
  offset += app1Length;

  bytes[offset++] = 0xff;
  bytes[offset++] = marker;
  view.setUint16(offset, 11); // segment length
  bytes[offset + 2] = 8; // precision
  view.setUint16(offset + 3, height);
  view.setUint16(offset + 5, width);
  return bytes;
}

/** ftyp box plus a meta > iprp > ipco > ispe chain. */
function heifHeader(sizes: [number, number][]): Uint8Array {
  const ispeSize = 8 + 12;
  const ipcoSize = 8 + sizes.length * ispeSize;
  const iprpSize = 8 + ipcoSize;
  const metaSize = 8 + 4 + iprpSize;
  const ftypSize = 16;

  const bytes = new Uint8Array(ftypSize + metaSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, ftypSize);
  bytes.set([0x66, 0x74, 0x79, 0x70], offset + 4); // "ftyp"
  bytes.set([0x68, 0x65, 0x69, 0x63], offset + 8); // "heic"
  offset += ftypSize;

  view.setUint32(offset, metaSize);
  bytes.set([0x6d, 0x65, 0x74, 0x61], offset + 4); // "meta"
  offset += 12; // box header + FullBox version/flags

  view.setUint32(offset, iprpSize);
  bytes.set([0x69, 0x70, 0x72, 0x70], offset + 4); // "iprp"
  offset += 8;

  view.setUint32(offset, ipcoSize);
  bytes.set([0x69, 0x70, 0x63, 0x6f], offset + 4); // "ipco"
  offset += 8;

  for (const [width, height] of sizes) {
    view.setUint32(offset, ispeSize);
    bytes.set([0x69, 0x73, 0x70, 0x65], offset + 4); // "ispe"
    view.setUint32(offset + 12, width);
    view.setUint32(offset + 16, height);
    offset += ispeSize;
  }

  return bytes;
}

describe('format detection', () => {
  it('recognizes each accepted format', () => {
    expect(isPng(pngHeader(1, 1))).toBe(true);
    expect(isJpeg(jpegHeader(1, 1))).toBe(true);
    expect(isHeif(heifHeader([[1, 1]]))).toBe(true);

    expect(detectFormat(pngHeader(1, 1))).toBe('png');
    expect(detectFormat(jpegHeader(1, 1))).toBe('jpeg');
    expect(detectFormat(heifHeader([[1, 1]]))).toBe('heif');
  });

  it('rejects anything else', () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const mp4 = new Uint8Array(16);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    mp4.set([0x69, 0x73, 0x6f, 0x6d], 8); // "isom" — a video brand

    expect(detectFormat(gif)).toBeNull();
    expect(detectFormat(mp4)).toBeNull();
    expect(detectFormat(new Uint8Array(16))).toBeNull();
  });
});

describe('readDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readDimensions(pngHeader(4032, 3024))).toEqual({
      ok: true,
      dimensions: { width: 4032, height: 3024 },
    });
  });

  it('walks past JPEG segments to the frame header', () => {
    expect(readDimensions(jpegHeader(6000, 4000))).toEqual({
      ok: true,
      dimensions: { width: 6000, height: 4000 },
    });
  });

  it('reads progressive JPEG frame headers too', () => {
    expect(readDimensions(jpegHeader(800, 600, 0xc2))).toEqual({
      ok: true,
      dimensions: { width: 800, height: 600 },
    });
  });

  it('does not mistake DHT or DAC for a frame header', () => {
    // 0xC4 (DHT), 0xC8 and 0xCC (DAC) sit in the same numeric range as the
    // SOF markers; reading dimensions from one would produce nonsense.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const result = readDimensions(jpegHeader(800, 600, marker));
      expect(result.ok, `marker ${marker.toString(16)}`).toBe(false);
    }
  });

  it('reads HEIF dimensions from ispe', () => {
    expect(readDimensions(heifHeader([[4032, 3024]]))).toEqual({
      ok: true,
      dimensions: { width: 4032, height: 3024 },
    });
  });

  it('takes the largest ispe, which is the composited grid, not a tile', () => {
    // An Apple HEIC carries an ispe for the grid and one per tile. The
    // largest is what the decoder produces, and over-estimating is the safe
    // direction for a guard.
    const heic = heifHeader([
      [512, 512],
      [8064, 6048],
      [512, 512],
    ]);

    expect(readDimensions(heic)).toEqual({
      ok: true,
      dimensions: { width: 8064, height: 6048 },
    });
  });

  it('reports truncated and malformed input rather than throwing', () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array(8),
      pngHeader(1, 1).slice(0, 20),
      new Uint8Array([0xff, 0xd8, 0xff]),
    ]) {
      expect(() => readDimensions(bytes)).not.toThrow();
      expect(readDimensions(bytes).ok).toBe(false);
    }
  });

  it('terminates on a HEIF box claiming an absurd size', () => {
    const heic = heifHeader([[100, 100]]);
    new DataView(heic.buffer).setUint32(16, 0xffffffff);

    expect(readDimensions(heic).ok).toBe(false);
  });
});

/**
 * decisions.md #21: the megapixel guard must fire from header dimensions,
 * before the decode it is protecting. Validating after a decode is not a
 * guard, it is a report on the crash.
 */
describe('validateSource', () => {
  it('accepts an ordinary photo', () => {
    const result = validateSource(4_000_000, heifHeader([[4032, 3024]]));
    expect(result).toEqual({
      ok: true,
      format: 'heif',
      dimensions: { width: 4032, height: 3024 },
    });
  });

  it('rejects an oversized file before looking at its pixels', () => {
    const result = validateSource(MAX_SOURCE_BYTES + 1, heifHeader([[100, 100]]));
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts a file at exactly the byte limit', () => {
    expect(validateSource(MAX_SOURCE_BYTES, heifHeader([[100, 100]])).ok).toBe(true);
  });

  it('rejects an over-megapixel image from the header alone', () => {
    // 10000 x 6000 = 60 MP, over the 50 MP cap. Nothing has been decoded.
    const result = validateSource(3_000_000, heifHeader([[10_000, 6_000]]));

    expect(result).toMatchObject({ ok: false, code: 'too-many-pixels' });
    expect(result.ok === false && result.message).toContain('60.0 MP');
  });

  it('accepts an image at exactly the megapixel cap', () => {
    const side = Math.floor(Math.sqrt(MAX_SOURCE_PIXELS));
    expect(validateSource(1_000_000, heifHeader([[side, side]])).ok).toBe(true);
  });

  it('rejects video and unsupported formats with a clear message', () => {
    const mp4 = new Uint8Array(32);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    mp4.set([0x69, 0x73, 0x6f, 0x6d], 8);

    const result = validateSource(1_000_000, mp4);
    expect(result).toMatchObject({ ok: false, code: 'unsupported-format' });
    expect(result.ok === false && result.message).toMatch(/video/i);
  });

  it('rejects a file whose header cannot be read', () => {
    const truncated = pngHeader(1, 1).slice(0, 20);
    expect(validateSource(1000, truncated)).toMatchObject({
      ok: false,
      code: 'unreadable',
    });
  });
});
