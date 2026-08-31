/**
 * Decoding a source file to upright sRGB pixels.
 *
 * Two decode paths, with different orientation rules — see orientation.ts.
 * HEIC goes through libheif-WASM because no browser decodes it natively
 * outside Safari, and even there `createImageBitmap` support cannot be relied
 * on. Everything else goes through `createImageBitmap`.
 */

import {
  convertBufferP3ToSrgb,
  flattenAlphaOnWhite,
  needsP3Conversion,
} from './color.ts';
import {
  orientedSize,
  shouldApplyExifOrientation,
  transformFor,
} from './orientation.ts';
import type { DecodePath, ExifOrientation } from './orientation.ts';
import type { SourceDimensions, SourceFormat } from './dimensions.ts';

export interface DecodedImage {
  /** Upright, sRGB, opaque RGBA pixels. */
  data: ImageData;
  width: number;
  height: number;
}

/**
 * Minimal shape of the libheif-js decoder. Declared structurally so this
 * module can be reasoned about, and partially tested, without loading a
 * multi-megabyte WASM bundle.
 */
export interface HeifDecoder {
  decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
}

export interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    image: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: { data: Uint8ClampedArray } | null) => void,
  ): void;
  free?(): void;
}

let heifDecoderPromise: Promise<HeifDecoder> | null = null;

/**
 * Load libheif lazily.
 *
 * The package's default entry is CommonJS and fails in a browser with
 * "module is not defined", so this imports the ESM bundle explicitly. That
 * bundle inlines its WebAssembly as base64, which is why no separate `.wasm`
 * fetch has to be allowed in `connect-src` — but it is 1.4 MB, and an
 * administrator who only edits captions should not pay for it up front.
 */
async function getHeifDecoder(): Promise<HeifDecoder> {
  heifDecoderPromise ??= (async () => {
    const { default: createLibheif } =
      await import('libheif-js/libheif-wasm/libheif-bundle.mjs');
    const libheif = await createLibheif();
    return new libheif.HeifDecoder();
  })();
  return heifDecoderPromise;
}

function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', {
    // The pipeline reads pixels back on every image, so tell the browser not
    // to keep the surface GPU-resident.
    willReadFrequently: true,
  });
  if (!context) throw new Error('Could not create a 2D drawing context.');
  return context;
}

async function decodeHeif(bytes: Uint8Array): Promise<ImageData> {
  const decoder = await getHeifDecoder();
  const images = decoder.decode(bytes);
  if (images.length === 0) throw new Error('That HEIC file contains no image.');

  // The first item is the primary image. For Apple's tiled `grid` encoding,
  // libheif returns the full composited picture rather than a single tile.
  const image = images[0]!;
  const width = image.get_width();
  const height = image.get_height();
  const data = new ImageData(width, height);

  await new Promise<void>((resolve, reject) => {
    image.display({ data: data.data, width, height }, (result) => {
      if (result) resolve();
      else reject(new Error('That HEIC file could not be decoded.'));
    });
  });

  image.free?.();
  return data;
}

async function decodeWithImageBitmap(blob: Blob): Promise<ImageData> {
  // `imageOrientation: 'none'` is passed explicitly and deliberately. The
  // spec default has shifted historically and varies across engines, so
  // relying on it would make orientation handling engine-dependent
  // (decisions.md #17).
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
  try {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    // Release the decoded bitmap promptly. Per-file memory release cannot be
    // assumed across a long batch — that is what crashed Firefox on a fourth
    // consecutive file (decisions.md #20).
    bitmap.close();
  }
}

/** Redraw pixels through an orientation transform. */
function applyOrientation(source: ImageData, orientation: ExifOrientation): ImageData {
  const size = orientedSize(orientation, source.width, source.height);
  const sourceCanvas = createCanvas(source.width, source.height);
  context2d(sourceCanvas).putImageData(source, 0, 0);

  const canvas = createCanvas(size.width, size.height);
  const context = context2d(canvas);
  const { matrix } = transformFor(orientation, size.width, size.height);
  context.setTransform(...matrix);
  context.drawImage(sourceCanvas, 0, 0);

  return context2d(canvas).getImageData(0, 0, size.width, size.height);
}

export interface DecodeOptions {
  format: SourceFormat;
  /** Header dimensions, needed for the libheif orientation cross-check. */
  storedDimensions: SourceDimensions;
  orientation: ExifOrientation;
  colorProfile: string | null;
}

/**
 * Decode a source file to upright, opaque, sRGB pixels.
 *
 * The order is fixed: decode, orient, convert colour, flatten alpha. Colour
 * conversion after orientation is equivalent and costs the same, but
 * flattening must come last so that alpha is composited against final colours.
 */
export async function decodeToSrgb(
  blob: Blob,
  bytes: Uint8Array,
  options: DecodeOptions,
): Promise<DecodedImage> {
  const path: DecodePath = options.format === 'heif' ? 'libheif' : 'image-bitmap';

  let image =
    path === 'libheif' ? await decodeHeif(bytes) : await decodeWithImageBitmap(blob);

  if (
    shouldApplyExifOrientation(path, options.orientation, options.storedDimensions, {
      width: image.width,
      height: image.height,
    })
  ) {
    image = applyOrientation(image, options.orientation);
  }

  if (needsP3Conversion(options.colorProfile)) {
    convertBufferP3ToSrgb(image.data);
  }

  // PNG is the only accepted format that carries alpha, but flattening is
  // cheap and unconditionally correct: it is a no-op on opaque pixels.
  flattenAlphaOnWhite(image.data);

  return { data: image, width: image.width, height: image.height };
}
