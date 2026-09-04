/**
 * A real PNG, built rather than checked in.
 *
 * The upload path cannot be faked: the browser decodes the file, converts it,
 * and encodes four artifacts with WebAssembly codecs, so a test that drops
 * something has to drop an image a decoder will actually accept. A handful of
 * bytes assembled here is enough for that, needs no binary in the repository,
 * and carries no EXIF — which is the interesting case anyway, since a
 * photograph with no date of its own is exactly the one whose date has to be
 * typed in.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

/** An 8-bit RGB PNG of the given size, filled with a diagonal gradient. */
export function tinyPng(width = 48, height = 32): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    // Filter type 0: no per-scanline prediction, so the bytes are the pixels.
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = (x * 5) % 256;
      raw[pixel + 1] = (y * 7) % 256;
      raw[pixel + 2] = ((x + y) * 3) % 256;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // Compression, filter, and interlace methods: the only values PNG defines.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
