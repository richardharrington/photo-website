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
 * The canvas transform that renders a source upright.
 *
 * `width` and `height` are the **displayed** dimensions — the size of the
 * destination canvas — which for orientations 5-8 are the source's exchanged.
 * The translation terms are therefore in destination space too. Reading them
 * as the source's is the mistake that shipped: orientations 6, 7, and 8 each
 * translated by the wrong one of the pair, which for a 4032x3024 source drew
 * every pixel outside a 3024-wide canvas and produced a blank artifact.
 *
 * The invariant that catches this, and the one the tests assert for all
 * eight: the four source corners must map exactly onto the canvas rectangle.
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
      return { matrix: [0, 1, -1, 0, width, 0] };
    case 7: // Transverse.
      return { matrix: [0, -1, -1, 0, width, height] };
    case 8: // Rotate 90 counter-clockwise.
      return { matrix: [0, -1, 1, 0, 0, height] };
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
 * **Observed, never assumed.** The original rule trusted the decode path:
 * libheif honours the HEIF `irot` property and returns upright pixels, while
 * `createImageBitmap` was called with `imageOrientation: 'none'` and was
 * therefore believed to do nothing. The second half is false. `'none'` is not
 * a member of the current `ImageOrientation` enum — the spec kept only
 * `'from-image'` and `'flipY'` — so browsers ignore it and fall back to
 * `'from-image'`, which applies the tag. Measured in Chromium on a Motorola
 * JPEG stored 4656x3504 with `Orientation: 6`, all three of `'none'`,
 * `'from-image'`, and no option at all returned 3504x4656: already upright.
 *
 * Applying the tag on top of that rotated every portrait photo a second time
 * and stored it 90 degrees off, which is exactly the failure the libheif half
 * of this rule was written to prevent.
 *
 * So both paths now answer the same question by looking at the pixels: does
 * what the decoder returned already have the shape the EXIF tag describes? If
 * it does, the rotation has happened. That holds whatever any engine decides
 * to do by default, which is the property the old rule was reaching for and
 * did not have.
 */
export function shouldApplyExifOrientation(
  _path: DecodePath,
  orientation: ExifOrientation,
  stored: { width: number; height: number },
  decoded: { width: number; height: number },
): boolean {
  if (orientation === 1) return false;

  const expected = orientedSize(orientation, stored.width, stored.height);

  // A square image cannot be told apart this way, and neither can the
  // mirror-only and 180-degree orientations, which leave the dimensions
  // untouched. Default to not rotating: every decoder in use applies the tag
  // itself, so a second application is the likelier error, and it is the one
  // that visibly corrupts the stored library.
  if (expected.width === expected.height || decoded.width === decoded.height) {
    return false;
  }
  if (!swapsDimensions(orientation)) return false;

  const expectedIsPortrait = expected.height > expected.width;
  const decodedIsPortrait = decoded.height > decoded.width;

  // Shapes agree: the decoder has already applied the tag, and applying it
  // again would rotate a second time. Shapes differ: it has not.
  return decodedIsPortrait !== expectedIsPortrait;
}
