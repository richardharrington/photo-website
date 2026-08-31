import { describe, it, expect } from 'vitest';
import {
  convertBufferP3ToSrgb,
  convertPixelP3ToSrgb,
  flattenAlphaOnWhite,
  needsP3Conversion,
  transferToEncoded,
  transferToLinear,
} from '../../src/pipeline/color.ts';

/**
 * A reference conversion written independently of the implementation: full
 * floating-point arithmetic, no lookup tables, no shared constants beyond the
 * matrix itself. The implementation's LUTs are an optimization, and this is
 * what they are checked against.
 */
function referenceP3ToSrgb(r: number, g: number, b: number): [number, number, number] {
  const toLinear = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const toEncoded = (v: number) => {
    const x = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, x)) * 255);
  };

  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  return [
    toEncoded(1.2249401762805598 * lr - 0.2249401762805599 * lg),
    toEncoded(-0.0420569547552857 * lr + 1.0420569547552856 * lg),
    toEncoded(
      -0.0196375546901123 * lr - 0.0786360655071471 * lg + 1.0982736201972594 * lb,
    ),
  ];
}

describe('transfer functions', () => {
  it('round-trip within 8-bit precision', () => {
    for (let i = 0; i <= 255; i += 1) {
      const roundTripped = transferToEncoded(transferToLinear(i / 255)) * 255;
      expect(Math.abs(roundTripped - i), `value ${i}`).toBeLessThan(0.001);
    }
  });

  it('pin the endpoints exactly', () => {
    expect(transferToLinear(0)).toBe(0);
    expect(transferToLinear(1)).toBeCloseTo(1, 10);
    expect(transferToEncoded(0)).toBe(0);
    expect(transferToEncoded(1)).toBeCloseTo(1, 10);
  });
});

/**
 * decisions.md #19: sRGB output must be genuinely converted, not relabelled.
 * Deviation concentrates in saturated pixels, so a low-saturation sample would
 * understate the error — the saturated cases below are the point of the test.
 */
describe('convertPixelP3ToSrgb', () => {
  it('leaves neutral greys untouched', () => {
    // P3 and sRGB share a white point, so the grey axis is common to both.
    for (const value of [0, 64, 128, 200, 255]) {
      const [r, g, b] = convertPixelP3ToSrgb(value, value, value);
      expect(Math.abs(r - value), `grey ${value}`).toBeLessThanOrEqual(1);
      expect(Math.abs(g - value), `grey ${value}`).toBeLessThanOrEqual(1);
      expect(Math.abs(b - value), `grey ${value}`).toBeLessThanOrEqual(1);
    }
  });

  it('actually changes saturated colours, rather than passing them through', () => {
    // The defect this guards against is writing P3 values into a file labelled
    // sRGB. If conversion were a no-op, these would come back unchanged.
    const [r, g, b] = convertPixelP3ToSrgb(255, 0, 0);
    expect(r).toBe(255);
    // P3 red is outside sRGB's gamut; the converted value clips with
    // noticeably negative green and blue contributions.
    expect(g).toBe(0);
    expect(b).toBe(0);

    // A strongly saturated in-gamut green shifts measurably.
    const green = convertPixelP3ToSrgb(0, 200, 0);
    expect(green[1]).toBeGreaterThan(200);
  });

  it('matches an independent floating-point reference conversion', () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 200, 0], // saturated orange
      [200, 0, 180], // saturated magenta
      [10, 120, 200],
      [128, 128, 128],
      [30, 60, 90],
      [250, 250, 200],
      [3, 3, 3], // inside the transfer function's linear segment
    ];

    for (const [r, g, b] of samples) {
      const actual = convertPixelP3ToSrgb(r, g, b);
      const expected = referenceP3ToSrgb(r, g, b);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(
          Math.abs(actual[channel]! - expected[channel]!),
          `rgb(${r},${g},${b}) channel ${channel}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('agrees with the reference across the whole cube, not just samples', () => {
    let worst = 0;
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const actual = convertPixelP3ToSrgb(r, g, b);
          const expected = referenceP3ToSrgb(r, g, b);
          for (let channel = 0; channel < 3; channel += 1) {
            worst = Math.max(worst, Math.abs(actual[channel]! - expected[channel]!));
          }
        }
      }
    }
    // The encode LUT is an interpolated approximation; this bounds its error
    // below what 8-bit output can represent.
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('clips out-of-gamut results instead of wrapping them', () => {
    // A negative matrix result must clamp to 0, not wrap to 255.
    const [, g] = convertPixelP3ToSrgb(255, 0, 0);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(255);
  });
});

describe('convertBufferP3ToSrgb', () => {
  it('converts every pixel and leaves alpha alone', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 128, 0, 200, 0, 255]);
    convertBufferP3ToSrgb(data);

    expect(data[3]).toBe(128);
    expect(data[7]).toBe(255);
    expect([data[0], data[1], data[2]]).toEqual(convertPixelP3ToSrgb(255, 0, 0));
  });

  it('handles an empty buffer', () => {
    expect(() => convertBufferP3ToSrgb(new Uint8ClampedArray(0))).not.toThrow();
  });
});

describe('flattenAlphaOnWhite', () => {
  it('leaves opaque pixels untouched', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    flattenAlphaOnWhite(data);
    expect([...data]).toEqual([10, 20, 30, 255]);
  });

  it('turns a fully transparent pixel white', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 0]);
    flattenAlphaOnWhite(data);
    expect([...data]).toEqual([255, 255, 255, 255]);
  });

  it('composites in linear light, not on gamma-encoded values', () => {
    // Half-transparent black over white. Naive compositing on encoded values
    // gives 128; the correct linear-light result is noticeably lighter, and
    // getting this wrong darkens every soft edge in a transparent PNG.
    const data = new Uint8ClampedArray([0, 0, 0, 128]);
    flattenAlphaOnWhite(data);

    expect(data[3]).toBe(255);
    expect(data[0]).toBeGreaterThan(180);
    expect(data[0]).toBeLessThan(200);
  });

  it('produces opaque output for every input alpha', () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i += 1) {
      data[i * 4] = 100;
      data[i * 4 + 1] = 150;
      data[i * 4 + 2] = 200;
      data[i * 4 + 3] = i;
    }
    flattenAlphaOnWhite(data);

    for (let i = 0; i < 256; i += 1) {
      expect(data[i * 4 + 3], `alpha ${i}`).toBe(255);
    }
  });
});

describe('needsP3Conversion', () => {
  it('recognizes the wide-gamut profiles worth converting', () => {
    expect(needsP3Conversion('Display P3')).toBe(true);
    expect(needsP3Conversion('display p3')).toBe(true);
    expect(needsP3Conversion('Apple Display P3')).toBe(true);
    expect(needsP3Conversion('DCI-P3 D65')).toBe(true);
  });

  it('leaves anything unrecognized alone rather than converting on a guess', () => {
    // Converting an image that is already sRGB would desaturate it, so an
    // unknown profile is deliberately left untouched.
    for (const profile of [
      'sRGB IEC61966-2.1',
      'Adobe RGB (1998)',
      'Generic RGB Profile',
      'ProPhoto RGB',
      '',
      null,
      undefined,
    ]) {
      expect(needsP3Conversion(profile), String(profile)).toBe(false);
    }
  });
});
