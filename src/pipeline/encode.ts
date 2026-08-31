/**
 * Encoding the four stored artifacts with WebAssembly codecs.
 *
 * WASM rather than `canvas.toBlob` (decisions.md #2): toBlob offers no
 * chroma-subsampling control, differs across browsers, and Safari cannot
 * encode WebP at all. mozjpeg and libwebp produce byte-identical output in
 * every supported browser, which is what makes the stored library independent
 * of whichever machine happened to upload a photo.
 *
 * Because every artifact is re-encoded from decoded pixels, no EXIF and no
 * GPS survives into any stored file. That is a property of re-encoding, not a
 * stripping step that could be forgotten.
 */

import { RENDITIONS, RENDITION_SPECS } from '../shared/constants.ts';
import type { Rendition } from '../shared/constants.ts';
import type { DerivativeDescriptor } from '../shared/catalog.ts';

export interface EncodedArtifact {
  rendition: Rendition;
  bytes: Uint8Array;
  descriptor: DerivativeDescriptor;
  contentType: string;
}

/**
 * mozjpeg options for the full-resolution download.
 *
 * `chroma_subsample: 1` with `auto_subsample: false` is true 4:4:4. Leaving
 * auto_subsample on lets the encoder decide, which at quality 92 usually means
 * 4:2:0 — visibly softer on fine detail and coloured text, in the one artifact
 * meant to be the keepable copy.
 */
const JPEG_OPTIONS = {
  quality: RENDITION_SPECS.full.quality,
  auto_subsample: false,
  chroma_subsample: 1,
  progressive: true,
  // Nothing downstream reads an embedded profile; the pixels are sRGB and the
  // file says so through its own markers.
  optimize_coding: true,
} as const;

const WEBP_OPTIONS = {
  quality: RENDITION_SPECS.thumb.quality,
  // Default method is a reasonable speed/size tradeoff; the pipeline is
  // already dominated by the full-resolution JPEG encode.
  method: 4,
} as const;

/** Longest-edge fit. Never upscales: a small source stays its own size. */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number | null,
): { width: number; height: number } {
  if (maxEdge === null) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Resize with the browser's own scaler.
 *
 * `resizeQuality: 'high'` asks for a proper downscale rather than nearest
 * neighbour; a 12 MP photo reduced to 400 px in one step looks bad without it.
 */
async function resize(
  source: ImageData,
  width: number,
  height: number,
): Promise<ImageData> {
  if (source.width === width && source.height === height) return source;

  const bitmap = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a 2D drawing context.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

let jpegEncoder: Promise<
  (data: ImageData, options?: unknown) => Promise<ArrayBuffer>
> | null = null;
let webpEncoder: Promise<
  (data: ImageData, options?: unknown) => Promise<ArrayBuffer>
> | null = null;

async function getJpegEncoder() {
  jpegEncoder ??= import('@jsquash/jpeg/encode').then(
    (module) =>
      module.default as (data: ImageData, options?: unknown) => Promise<ArrayBuffer>,
  );
  return jpegEncoder;
}

async function getWebpEncoder() {
  webpEncoder ??= import('@jsquash/webp/encode').then(
    (module) =>
      module.default as (data: ImageData, options?: unknown) => Promise<ArrayBuffer>,
  );
  return webpEncoder;
}

/**
 * Encode all four artifacts from one decoded image.
 *
 * Serial on purpose. Encoding is the expensive half of the pipeline and
 * several simultaneous large encodes are a memory risk; only the *uploads*
 * run concurrently (decisions.md #21).
 */
export async function encodeArtifacts(
  image: ImageData,
  onProgress?: (rendition: Rendition) => void,
): Promise<EncodedArtifact[]> {
  const artifacts: EncodedArtifact[] = [];

  for (const rendition of RENDITIONS) {
    const spec = RENDITION_SPECS[rendition];
    const size = scaledSize(image.width, image.height, spec.maxEdge);
    const resized = await resize(image, size.width, size.height);

    const buffer =
      spec.format === 'jpeg'
        ? await (
            await getJpegEncoder()
          )(resized, JPEG_OPTIONS)
        : await (
            await getWebpEncoder()
          )(resized, {
            ...WEBP_OPTIONS,
            quality: spec.quality,
          });

    const bytes = new Uint8Array(buffer);
    artifacts.push({
      rendition,
      bytes,
      contentType: spec.contentType,
      descriptor: { width: size.width, height: size.height, bytes: bytes.byteLength },
    });

    onProgress?.(rendition);
  }

  return artifacts;
}
