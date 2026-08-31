import { describe, it, expect } from 'vitest';
import {
  asExifOrientation,
  orientedSize,
  shouldApplyExifOrientation,
  swapsDimensions,
  transformFor,
} from '../../src/pipeline/orientation.ts';
import type { ExifOrientation } from '../../src/pipeline/orientation.ts';

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
  it('is the identity for orientation 1', () => {
    const { matrix } = transformFor(1, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([0, 0]);
    expect(mapPoint(matrix, 100, 50)).toEqual([100, 50]);
  });

  it('mirrors horizontally for orientation 2', () => {
    const { matrix } = transformFor(2, 100, 50);
    // The source's top-left corner lands at the top-right.
    expect(mapPoint(matrix, 0, 0)).toEqual([100, 0]);
    expect(mapPoint(matrix, 100, 0)).toEqual([0, 0]);
  });

  it('rotates 180 for orientation 3', () => {
    const { matrix } = transformFor(3, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([100, 50]);
    expect(mapPoint(matrix, 100, 50)).toEqual([0, 0]);
  });

  it('mirrors vertically for orientation 4', () => {
    const { matrix } = transformFor(4, 100, 50);
    expect(mapPoint(matrix, 0, 0)).toEqual([0, 50]);
  });

  it('rotates 90 clockwise for orientation 6', () => {
    // Displayed size is 50 x 100 for a 100 x 50 source.
    const { matrix } = transformFor(6, 50, 100);
    // The source's top-left corner ends up at the top-right of the output.
    expect(mapPoint(matrix, 0, 0)).toEqual([100, 0]);
    // The source's top-right corner ends up at the bottom-right.
    expect(mapPoint(matrix, 100, 0)).toEqual([100, 100]);
  });

  it('rotates 90 counter-clockwise for orientation 8', () => {
    const { matrix } = transformFor(8, 50, 100);
    expect(mapPoint(matrix, 0, 0)).toEqual([0, 50]);
    expect(mapPoint(matrix, 100, 0)).toEqual([0, -50]);
  });

  it('maps the transpose and transverse diagonals', () => {
    expect(mapPoint(transformFor(5, 50, 100).matrix, 10, 20)).toEqual([20, 10]);
    expect(mapPoint(transformFor(7, 50, 100).matrix, 0, 0)).toEqual([100, 50]);
  });
});

/**
 * The rule from decisions.md #17, which is the whole reason this module has a
 * decision function rather than just applying the tag.
 */
describe('shouldApplyExifOrientation', () => {
  const landscapeStored = { width: 4032, height: 3024 };

  describe('the createImageBitmap path', () => {
    it('always applies the tag, because the decoder did nothing', () => {
      // createImageBitmap is called with an explicit imageOrientation: 'none',
      // so EXIF is the only source of truth on this path.
      for (const orientation of [2, 3, 4, 5, 6, 7, 8] as ExifOrientation[]) {
        expect(
          shouldApplyExifOrientation(
            'image-bitmap',
            orientation,
            landscapeStored,
            landscapeStored,
          ),
          String(orientation),
        ).toBe(true);
      }
    });

    it('does nothing for orientation 1', () => {
      expect(
        shouldApplyExifOrientation('image-bitmap', 1, landscapeStored, landscapeStored),
      ).toBe(false);
    });
  });

  describe('the libheif path', () => {
    it('does not rotate a real Apple portrait HEIC a second time', () => {
      // The exact case that emitted landscape artifacts: ispe says landscape,
      // libheif honoured irot and returned portrait, and Apple redundantly
      // tagged Orientation 6 on top.
      const decodedPortrait = { width: 3024, height: 4032 };

      expect(
        shouldApplyExifOrientation('libheif', 6, landscapeStored, decodedPortrait),
      ).toBe(false);
    });

    it('applies the tag when the decoder evidently did not', () => {
      // The unobserved case: EXIF orientation present but no irot, so libheif
      // returned the stored shape unchanged.
      expect(
        shouldApplyExifOrientation('libheif', 6, landscapeStored, landscapeStored),
      ).toBe(true);
    });

    it('does nothing for orientation 1', () => {
      expect(
        shouldApplyExifOrientation('libheif', 1, landscapeStored, landscapeStored),
      ).toBe(false);
    });

    it('handles a portrait-stored source with a rotation tag', () => {
      const portraitStored = { width: 3024, height: 4032 };
      // Orientation 6 on a portrait source implies a landscape display.
      expect(
        shouldApplyExifOrientation('libheif', 6, portraitStored, {
          width: 4032,
          height: 3024,
        }),
      ).toBe(false);
      expect(
        shouldApplyExifOrientation('libheif', 6, portraitStored, portraitStored),
      ).toBe(true);
    });

    it('leaves a square image alone, since aspect cannot decide it', () => {
      // Defaulting to no rotation matches every real Apple HEIC observed:
      // libheif has already applied irot.
      const square = { width: 3000, height: 3000 };
      expect(shouldApplyExifOrientation('libheif', 6, square, square)).toBe(false);
    });

    it('does not rotate for the mirror-only orientations', () => {
      // 2, 3, and 4 do not change the aspect ratio, so the cross-check cannot
      // detect them; libheif handles them through irot/imir.
      for (const orientation of [2, 3, 4] as ExifOrientation[]) {
        expect(
          shouldApplyExifOrientation(
            'libheif',
            orientation,
            landscapeStored,
            landscapeStored,
          ),
          String(orientation),
        ).toBe(false);
      }
    });
  });
});
