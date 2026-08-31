/**
 * Display P3 to sRGB conversion.
 *
 * decisions.md #19: sRGB output must be genuinely *converted*, not relabelled.
 * The spike pipeline wrote P3 sample values into files tagged sRGB, which
 * reinterprets rather than converts. Measured deviation was small on a
 * low-saturation overcast scene (mean about 1/255 per channel), but error
 * concentrates in saturated pixels, so that figure understates vivid subjects.
 *
 * The conversion must happen **in linear light**. Applying a matrix to
 * gamma-encoded values is a different, wrong operation — it is not a slightly
 * less accurate conversion, it is not a conversion at all.
 *
 * P3 and sRGB share the same transfer function and white point (D65), so only
 * the primaries differ and one 3x3 matrix covers it.
 */

/**
 * Display P3 to sRGB, D65 to D65, linear-light.
 *
 * Derived by composing P3-to-XYZ with the inverse of sRGB-to-XYZ. Both spaces
 * use D65, so no chromatic adaptation is involved.
 */
const P3_TO_SRGB = [
  [1.2249401762805598, -0.2249401762805599, 0.0],
  [-0.0420569547552857, 1.0420569547552856, 0.0],
  [-0.0196375546901123, -0.0786360655071471, 1.0982736201972594],
] as const;

const LUT_SIZE = 256;

/** sRGB / Display P3 electro-optical transfer function, on 0..1. */
export function transferToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** The inverse: linear light back to encoded values, on 0..1. */
export function transferToEncoded(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/**
 * Decode lookup table: one entry per 8-bit input value.
 *
 * The forward direction is exactly 256 possible inputs, so a table is exact
 * here, not an approximation — and it turns a `Math.pow` per subpixel into an
 * array index, which matters across roughly 36 million subpixels on a 12 MP
 * photo.
 */
const TO_LINEAR = new Float32Array(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i += 1) {
  TO_LINEAR[i] = transferToLinear(i / 255);
}

/**
 * Encode lookup table.
 *
 * The reverse direction takes a continuous input, so this one *is* an
 * approximation: 4096 entries with linear interpolation between them, which
 * keeps the round-trip error well below the 1/255 that any 8-bit output can
 * represent.
 */
const ENCODE_STEPS = 4096;
const TO_ENCODED = new Float32Array(ENCODE_STEPS + 1);
for (let i = 0; i <= ENCODE_STEPS; i += 1) {
  TO_ENCODED[i] = transferToEncoded(i / ENCODE_STEPS);
}

function encodeLinear(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 255;
  const scaled = value * ENCODE_STEPS;
  const index = Math.floor(scaled);
  const fraction = scaled - index;
  const low = TO_ENCODED[index]!;
  const high = TO_ENCODED[index + 1] ?? low;
  return Math.round((low + (high - low) * fraction) * 255);
}

/** Convert one Display P3 pixel, 0-255 per channel, to sRGB. */
export function convertPixelP3ToSrgb(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const lr = TO_LINEAR[r]!;
  const lg = TO_LINEAR[g]!;
  const lb = TO_LINEAR[b]!;

  const out: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const row = P3_TO_SRGB[channel]!;
    // Out-of-gamut results are clipped by encodeLinear. Clipping is the right
    // choice here: the alternative, gamut mapping, would alter in-gamut
    // colours across the whole image to preserve a handful of extremes.
    out[channel] = encodeLinear(row[0]! * lr + row[1]! * lg + row[2]! * lb);
  }
  return out;
}

/**
 * Convert an RGBA buffer from Display P3 to sRGB, in place.
 *
 * Alpha is left untouched: it is not a colour channel and carries no gamma.
 */
export function convertBufferP3ToSrgb(data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const lr = TO_LINEAR[data[i]!]!;
    const lg = TO_LINEAR[data[i + 1]!]!;
    const lb = TO_LINEAR[data[i + 2]!]!;

    data[i] = encodeLinear(
      P3_TO_SRGB[0]![0] * lr + P3_TO_SRGB[0]![1] * lg + P3_TO_SRGB[0]![2] * lb,
    );
    data[i + 1] = encodeLinear(
      P3_TO_SRGB[1]![0] * lr + P3_TO_SRGB[1]![1] * lg + P3_TO_SRGB[1]![2] * lb,
    );
    data[i + 2] = encodeLinear(
      P3_TO_SRGB[2]![0] * lr + P3_TO_SRGB[2]![1] * lg + P3_TO_SRGB[2]![2] * lb,
    );
  }
}

/**
 * Composite RGBA onto white, in place, producing opaque pixels.
 *
 * PNG transparency has to go somewhere: the stored artifacts are JPEG and
 * WebP served on a page whose background follows the viewer's light or dark
 * preference, so leaving alpha in would make a photo look different in the
 * two themes. White is the conventional choice and matches how the source
 * image was almost certainly authored.
 *
 * Done in linear light for the same reason as the matrix above: alpha
 * compositing on gamma-encoded values darkens edges.
 */
export function flattenAlphaOnWhite(data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha === 255) continue;

    const a = alpha / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const linear = TO_LINEAR[data[i + channel]!]!;
      // White is 1.0 in linear light.
      data[i + channel] = encodeLinear(linear * a + (1 - a));
    }
    data[i + 3] = 255;
  }
}

/**
 * Whether a colour profile description names a wide-gamut space needing
 * conversion.
 *
 * Deliberately conservative: an unrecognized profile is left alone rather than
 * converted on a guess, because converting an image that is already sRGB
 * would desaturate it.
 */
export function needsP3Conversion(
  profileDescription: string | null | undefined,
): boolean {
  if (!profileDescription) return false;
  const normalized = profileDescription.toLowerCase();
  return normalized.includes('display p3') || normalized.includes('dci-p3');
}
