/**
 * What a run of bytes actually is, from its signature alone.
 *
 * This lives under `src/shared/` rather than in the pipeline because three
 * runtimes now need the same answer: the browser, before it decodes a dropped
 * file, and the Worker, deciding which parts of an emailed message are
 * photographs. Declared `Content-Type` and filename extensions are never
 * consulted — mail clients label HEIC as `application/octet-stream` routinely,
 * and a `.jpg` name means nothing.
 *
 * It is compiled into all three targets, so it must stay free of DOM, Node,
 * and Workers globals.
 */

export type SourceFormat = 'jpeg' | 'png' | 'heif';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** ISO base media brands that carry a still image the decoders here accept. */
const HEIF_BRANDS = [
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
];

export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  if (String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return false;
  return HEIF_BRANDS.includes(String.fromCharCode(...bytes.slice(8, 12)));
}

export function detectFormat(bytes: Uint8Array): SourceFormat | null {
  if (isJpeg(bytes)) return 'jpeg';
  if (isPng(bytes)) return 'png';
  if (isHeif(bytes)) return 'heif';
  return null;
}

/**
 * The MIME type a sniffed format is stored and re-presented under.
 *
 * The pipeline records this as `sourceMimeType`, and an emailed part is stored
 * in R2 under it, so an emailed photograph and a dropped one describe
 * themselves identically once committed.
 */
export const MIME_BY_FORMAT: Record<SourceFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  heif: 'image/heic',
};
