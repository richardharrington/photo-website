import { describe, it, expect } from 'vitest';
import {
  asExifOrientation,
  orientedSize,
  shouldApplyExifOrientation,
  swapsDimensions,
  transformFor,
} from '../../src/pipeline/orientation.ts';
import type { DecodePath, ExifOrientation } from '../../src/pipeline/orientation.ts';

/** Apply a transform matrix to a point, the way a canvas context would. */
function mapPoint(
  matrix: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

describe('asExifOrientation', () => {
  it('accepts the eight valid numeric values', () => {
    for (let value = 1; value <= 8; value += 1) {
      expect(asExifOrientation(value)).toBe(value);
    }
  });

  /**
   * decisions.md #18: without `translateValues: false`, exifr returns
   * "Rotate 90 CW" instead of 6, and a numeric test silently skips rotation on
   * exactly the portrait photos it exists to correct. Falling back to 1 here
   * is the safe direction, but the real fix is the exifr option.
   */
  it('falls back to 1 for a translated string, rather than guessing', () => {
    expect(asExifOrientation('Rotate 90 CW')).toBe(1);
    expect(asExifOrientation('Horizontal (normal)')).toBe(1);
  });

  it('falls back to 1 for missing or out-of-range values', () => {
    for (const value of [undefined, null, 0, 9, -1, NaN, {}, []]) {
      expect(asExifOrientation(value)).toBe(1);
    }
  });
});

describe('swapsDimensions and orientedSize', () => {
  it('exchanges width and height for orientations 5 to 8 only', () => {
    for (const orientation of [1, 2, 3, 4] as ExifOrientation[]) {
      expect(swapsDimensions(orientation), String(orientation)).toBe(false);
      expect(orientedSize(orientation, 4032, 3024)).toEqual({
        width: 4032,
        height: 3024,
      });
    }
    for (const orientation of [5, 6, 7, 8] as ExifOrientation[]) {
      expect(swapsDimensions(orientation), String(orientation)).toBe(true);
      expect(orientedSize(orientation, 4032, 3024)).toEqual({
        width: 3024,
        height: 4032,
      });
    }
  });
});

/**
 * Corner mapping rather than dimension checks.
 *
 * The double-rotation defect decisions.md #17 records produces artifacts whose
 * dimensions are all mutually consistent and entirely plausible, so any
 * dimensions-only assertion passes while the image ships sideways. These tests
 * therefore check *where a specific corner lands*.
 */
describe('transformFor', () => {
  /**
   * The invariant that matters, and the one whose absence let a real bug
   * ship: the transform is applied to a canvas of the *displayed* size, so
   * the four source corners must land exactly on that canvas rectangle.
   * Orientations 6, 7, and 8 each used the wrong member of the width/height
   * pair in their translation, mapping the whole image off-canvas — which
   * produced blank artifacts while every recorded dimension stayed
   * self-consistent.
   */
  function mappedBounds(orientation: ExifOrientation, srcW: number, srcH: number) {
    const size = orientedSize(orientation, srcW, srcH);
    const { matrix } = transformFor(orientation, size.width, size.height);
    const corners = [
      mapPoint(matrix, 0, 0),
      mapPoint(matrix, srcW, 0),
      mapPoint(matrix, srcW, srcH),
      mapPoint(matrix, 0, srcH),
    ];
    const xs = corners.map((corner) => corner[0]);
    const ys = corners.map((corner) => corner[1]);
    return {
      canvas: size,
      x: [Math.min(...xs), Math.max(...xs)],
      y: [Math.min(...ys), Math.max(...ys)],
    };
  }

  it('maps the source exactly onto the canvas for all eight orientations', () => {
    const orientations: ExifOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

    for (const orientation of orientations) {
      const { canvas, x, y } = mappedBounds(orientation, 100, 50);
      expect({ orientation, x, y }).toEqual({
        orientation,
        x: [0, canvas.width],
        y: [0, canvas.height],
      });
    }
  });

  it('holds for a portrait source too, not just a landscape one', () => {
    const orientations: ExifOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

    for (const orientation of orientations) {
      const { canvas, x, y } = mappedBounds(orientation, 3024, 4032);
      expect({ orientation, x, y }).toEqual({
        orientation,
        x: [0, canvas.width],
        y: [0, canvas.height],
      });
    }
  });

  it('is the identity for orientation 1', () => {
    const { matrix } = transformFor(1, 100, 50);
    expect(mapPoint(matrix, 10, 20)).toEqual([10, 20]);
  });

  it('mirrors horizontally for orientation 2', () => {
    const { matrix } = transformFor(2, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([100, 0]);
    expect(mapPoint(matrix, 100, 50)).toEqual([0, 50]);
  });

  it('rotates 180 for orientation 3', () => {
    const { matrix } = transformFor(3, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([100, 50]);
  });

  it('mirrors vertically for orientation 4', () => {
    const { matrix } = transformFor(4, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([0, 50]);
  });

  it('rotates 90 clockwise for orientation 6', () => {
    // A 100 x 50 source displays as 50 x 100.
    const { matrix } = transformFor(6, 50, 100);
    // The source's top-left corner ends up at the top-right of the canvas,
    // which is x = 50 — the canvas width, not its height.
    expect(mapPoint(matrix, 0, 0)).toEqual([50, 0]);
    // Its top-right corner ends up at the bottom-right.
    expect(mapPoint(matrix, 100, 0)).toEqual([50, 100]);
    // Its bottom-left corner ends up at the origin.
    expect(mapPoint(matrix, 0, 50)).toEqual([0, 0]);
  });

  it('rotates 90 counter-clockwise for orientation 8', () => {
    const { matrix } = transformFor(8, 50, 100);
    // Top-left goes to the bottom-left; no coordinate may be negative.
    expect(mapPoint(matrix, 0, 0)).toEqual([0, 100]);
    expect(mapPoint(matrix, 100, 0)).toEqual([0, 0]);
    expect(mapPoint(matrix, 100, 50)).toEqual([50, 0]);
  });

  it('maps the transpose and transverse diagonals', () => {
    expect(mapPoint(transformFor(5, 50, 100).matrix, 10, 20)).toEqual([20, 10]);
    expect(mapPoint(transformFor(7, 50, 100).matrix, 0, 0)).toEqual([50, 100]);
    expect(mapPoint(transformFor(7, 50, 100).matrix, 100, 50)).toEqual([0, 0]);
  });
});

/**
 * The rule that decides whether the decoder has already applied the tag.
 *
 * It used to answer from the decode path: libheif honours `irot`, so don't
 * re-apply; `createImageBitmap` was passed `imageOrientation: 'none'`, so do.
 * The second half was false — `'none'` is not in the current
 * `ImageOrientation` enum, so browsers ignore it and apply EXIF anyway — and
 * every portrait JPEG was stored rotated 90 degrees as a result. The rule now
 * observes the decoded shape instead, and must give the same answer on both
 * paths for the same pixels.
 */
describe('shouldApplyExifOrientation', () => {
  const paths: DecodePath[] = ['image-bitmap', 'libheif'];
  const landscapeStored = { width: 4032, height: 3024 };
  const portraitDecoded = { width: 3024, height: 4032 };

  it('does nothing for orientation 1', () => {
    for (const path of paths) {
      expect(
        shouldApplyExifOrientation(path, 1, landscapeStored, landscapeStored),
        path,
      ).toBe(false);
    }
  });

  it('does not rotate again when the decoder already applied the tag', () => {
    // Both real decoders do: libheif through irot, and createImageBitmap
    // through the EXIF handling that `imageOrientation: 'none'` fails to
    // switch off.
    for (const path of paths) {
      expect(
        shouldApplyExifOrientation(path, 6, landscapeStored, portraitDecoded),
        path,
      ).toBe(false);
    }
  });

  it('applies the tag when the decoder evidently did not', () => {
    for (const path of paths) {
      expect(
        shouldApplyExifOrientation(path, 6, landscapeStored, landscapeStored),
        path,
      ).toBe(true);
    }
  });

  it('gives the same answer for the same pixels on either path', () => {
    // The regression that matters: nothing here may depend on the decoder
    // again, because what a decoder does by default is not knowable from here.
    const cases = [
      [6, landscapeStored, portraitDecoded],
      [6, landscapeStored, landscapeStored],
      [8, landscapeStored, portraitDecoded],
      [1, landscapeStored, landscapeStored],
    ] as const;

    for (const [orientation, stored, decoded] of cases) {
      const [viaBitmap, viaHeif] = paths.map((path) =>
        shouldApplyExifOrientation(path, orientation, stored, decoded),
      );
      expect(viaBitmap, `orientation ${orientation}`).toBe(viaHeif);
    }
  });

  it('does not double-rotate the Motorola JPEG that shipped rotated', () => {
    // The actual failure, with its real numbers: stored landscape with
    // Orientation 6, and Chromium handed back an already-upright bitmap.
    const stored = { width: 4656, height: 3504 };
    const decoded = { width: 3504, height: 4656 };

    expect(shouldApplyExifOrientation('image-bitmap', 6, stored, decoded)).toBe(false);
  });

  it('does not rotate a real Apple portrait HEIC a second time', () => {
    // ispe says landscape, libheif honoured irot and returned portrait, and
    // Apple redundantly tagged Orientation 6 on top.
    expect(
      shouldApplyExifOrientation('libheif', 6, landscapeStored, portraitDecoded),
    ).toBe(false);
  });

  it('handles a portrait-stored source with a rotation tag', () => {
    const portraitStored = { width: 3024, height: 4032 };
    // Orientation 6 on a portrait source implies a landscape display.
    for (const path of paths) {
      expect(
        shouldApplyExifOrientation(path, 6, portraitStored, {
          width: 4032,
          height: 3024,
        }),
        path,
      ).toBe(false);
      expect(
        shouldApplyExifOrientation(path, 6, portraitStored, portraitStored),
        path,
      ).toBe(true);
    }
  });

  it('leaves a square image alone, since aspect cannot decide it', () => {
    const square = { width: 3000, height: 3000 };
    for (const path of paths) {
      expect(shouldApplyExifOrientation(path, 6, square, square), path).toBe(false);
    }
  });

  it('does not rotate for the orientations that leave the shape alone', () => {
    // 2, 3, and 4 mirror or turn 180, so the cross-check cannot detect them.
    // Every decoder in use applies them itself, and a second application is
    // the error that corrupts the stored library.
    for (const orientation of [2, 3, 4] as ExifOrientation[]) {
      for (const path of paths) {
        expect(
          shouldApplyExifOrientation(path, orientation, landscapeStored, {
            width: 4032,
            height: 3024,
          }),
          `${path} ${orientation}`,
        ).toBe(false);
      }
    }
  });
});
