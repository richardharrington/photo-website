/**
 * EXIF orientation, and the rule for when to apply it.
 *
 * **This is decode-path dependent and must not be generalized**
 * (decisions.md #17). libheif applies the HEIF `irot` property during decode
 * and returns already-upright pixels, while Apple *additionally* writes a
 * redundant EXIF `Orientation: 6`. Applying EXIF orientation on top of
 * libheif's output rotates every portrait HEIC a second time and emits
 * landscape artifacts.
 *
 * The wrong behaviour is *dimensionally self-consistent* — all four artifacts
 * agree with one another and every dimension looks plausible — so a
 * dimensions-only test passes and the corruption ships silently. Only pixel
 * inspection tells them apart, which is why the mandatory regression test
 * compares pixels.
 */

/** The eight EXIF orientation values. Anything else is treated as 1. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function asExifOrientation(value: unknown): ExifOrientation {
  // exifr must be configured with `translateValues: false`, or this arrives as
  // the string "Rotate 90 CW" and every numeric test silently skips rotation
  // on exactly the portrait photos it exists to correct (decisions.md #18).
  return typeof value === 'number' && value >= 1 && value <= 8
    ? (value as ExifOrientation)
    : 1;
}

/** Orientations 5-8 exchange the width and height of the displayed image. */
export function swapsDimensions(orientation: ExifOrientation): boolean {
  return orientation >= 5;
}

export interface Transform {
  /** 2D transform matrix: [a, b, c, d, e, f]. */
  matrix: [number, number, number, number, number, number];
}

/**
 * The canvas transform that renders a source of `width` x `height` upright.
 *
 * Applied to a context sized to the *displayed* dimensions, which for
 * orientations 5-8 are the source dimensions exchanged.
 */
export function transformFor(
  orientation: ExifOrientation,
  width: number,
  height: number,
): Transform {
  switch (orientation) {
    case 2: // Mirror horizontally.
      return { matrix: [-1, 0, 0, 1, width, 0] };
    case 3: // Rotate 180.
      return { matrix: [-1, 0, 0, -1, width, height] };
    case 4: // Mirror vertically.
      return { matrix: [1, 0, 0, -1, 0, height] };
    case 5: // Transpose.
      return { matrix: [0, 1, 1, 0, 0, 0] };
    case 6: // Rotate 90 clockwise.
      return { matrix: [0, 1, -1, 0, height, 0] };
    case 7: // Transverse.
      return { matrix: [0, -1, -1, 0, height, width] };
    case 8: // Rotate 90 counter-clockwise.
      return { matrix: [0, -1, 1, 0, 0, width] };
    case 1:
    default:
      return { matrix: [1, 0, 0, 1, 0, 0] };
  }
}

/** Displayed dimensions after applying an orientation. */
export function orientedSize(
  orientation: ExifOrientation,
  width: number,
  height: number,
): { width: number; height: number } {
  return swapsDimensions(orientation)
    ? { width: height, height: width }
    : { width, height };
}

export type DecodePath = 'libheif' | 'image-bitmap';

/**
 * Whether to apply EXIF orientation to what the decoder returned.
 *
 * - `image-bitmap`: **always**. `createImageBitmap` is called with an explicit
 *   `imageOrientation: 'none'`, so the decoder has done nothing and the EXIF
 *   tag is the only source of truth. (Never rely on the default: it has
 *   shifted historically and varies across engines.)
 *
 * - `libheif`: **normally not**, because libheif has already honoured `irot`.
 *   The comparison below covers the case the spike never observed — a HEIC
 *   carrying EXIF orientation but no `irot` — by checking whether the decoded
 *   pixels already have the shape the EXIF tag describes. If they do, the
 *   rotation has happened; if they do not, it has not.
 */
export function shouldApplyExifOrientation(
  path: DecodePath,
  orientation: ExifOrientation,
  stored: { width: number; height: number },
  decoded: { width: number; height: number },
): boolean {
  if (path === 'image-bitmap') return orientation !== 1;
  if (orientation === 1) return false;

  const expected = orientedSize(orientation, stored.width, stored.height);
  const expectedIsPortrait = expected.height > expected.width;
  const decodedIsPortrait = decoded.height > decoded.width;

  // A square image cannot be told apart this way. Default to not rotating,
  // which is the behaviour observed on every real Apple HEIC: libheif has
  // already done it.
  if (expected.width === expected.height || decoded.width === decoded.height) {
    return false;
  }

  // The decoder's output already matches what EXIF describes, so applying the
  // tag again would rotate a second time.
  return decodedIsPortrait !== expectedIsPortrait;
}
