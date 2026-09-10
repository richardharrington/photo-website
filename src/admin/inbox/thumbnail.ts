/**
 * The Inbox's previews: the thumbnail a camera already embedded, and nothing
 * more.
 *
 * **No part is decoded before Add.** A decode is the expensive, memory-risky,
 * strictly-serial thing the pipeline exists to do one file at a time; showing
 * a card of six emailed photographs must not do it six times over just so the
 * administrator can see what they are. A JPEG carries a small JPEG thumbnail
 * in its EXIF block, and `exifr.thumbnail` hands it back from the first
 * hundred kilobytes of the file.
 *
 * **HEIC has no preview here, and that is measured rather than assumed.**
 * `exifr.thumbnail` returns `undefined` for every HEIC in `sample-photos/`,
 * whole file or prefix alike: exifr reads the TIFF IFD1 thumbnail, and a HEIC
 * keeps its thumbnail as a separate image *item* in the ISO container — which
 * is itself HEVC, so even extracting it would leave bytes no browser can
 * paint without the decoder this page exists to avoid running. A HEIC part
 * therefore gets the neutral tile, alongside PNGs, screenshots, images saved
 * from the web, and signature logos.
 *
 * The tile is not nothing: it carries the filename and the size, which is what
 * separates a 3 MB photograph from a 4 KB logo, and the logo is the thing the
 * administrator is here to untick. But a card of iPhone photographs shows no
 * pictures, and that is a real limit of reviewing without decoding.
 *
 * These fetches are concurrent. They are tiny Range requests, not the serial
 * pipeline, and the whole point is that a card renders at once.
 */

import exifr from 'exifr';

/**
 * How much of the file to ask for.
 *
 * The EXIF block sits at the front of a JPEG and near the front of a HEIC, and
 * a thumbnail is a few tens of kilobytes. This is generous enough for an Apple
 * HEIC's item tables and still a fraction of a 3 MB original.
 */
export const THUMBNAIL_PROBE_BYTES = 128 * 1024;

export interface PartPreview {
  /** Object URL for the embedded JPEG, or null when there was none. */
  url: string | null;
  /**
   * The EXIF `Orientation` tag, applied to the preview as a CSS transform.
   *
   * The stored thumbnail is unrotated, and this is deliberately *not* the
   * pipeline's orientation code: that compares the decoded shape against the
   * shape the tag describes, and a thumbnail is not the decoded image. A tag
   * and a transform is the whole of what a preview needs.
   */
  orientation: number;
}

/** The CSS a given EXIF orientation needs, or null for the identity. */
export function orientationTransform(orientation: number): string | null {
  switch (orientation) {
    case 2:
      return 'scaleX(-1)';
    case 3:
      return 'rotate(180deg)';
    case 4:
      return 'scaleY(-1)';
    case 5:
      return 'rotate(90deg) scaleX(-1)';
    case 6:
      return 'rotate(90deg)';
    case 7:
      return 'rotate(270deg) scaleX(-1)';
    case 8:
      return 'rotate(270deg)';
    default:
      return null;
  }
}

/**
 * Fetch the head of a raw part and pull its embedded thumbnail out.
 *
 * The `Range` header is why the bucket's CORS rule has to allow it and expose
 * `Content-Range`: the signature on the presigned URL does not cover the
 * header, so this is a CORS question rather than a signing one, and a
 * preflight failure arrives as a network error with no status.
 *
 * Every failure — no range support, no EXIF, malformed EXIF, a refused
 * request — resolves to the neutral tile. Nothing here is worth failing a card
 * over.
 */
export async function readEmbeddedThumbnail(
  url: string,
  signal?: AbortSignal,
): Promise<PartPreview> {
  const empty: PartPreview = { url: null, orientation: 1 };

  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url, {
      headers: { range: `bytes=0-${THUMBNAIL_PROBE_BYTES - 1}` },
      signal: signal ?? null,
    });
    // 206 for a served range, 200 for a store that ignored it and sent the
    // whole object. Both are usable; anything else is not.
    if (!response.ok) return empty;
    bytes = await response.arrayBuffer();
  } catch {
    return empty;
  }

  try {
    const thumbnail = await exifr.thumbnail(bytes);
    if (!thumbnail || thumbnail.byteLength === 0) return empty;

    const orientation = await readOrientation(bytes);
    return {
      url: URL.createObjectURL(
        new Blob([thumbnail as BlobPart], { type: 'image/jpeg' }),
      ),
      orientation,
    };
  } catch {
    return empty;
  }
}

/**
 * The `Orientation` tag, read without translation.
 *
 * `translateValues: false` for the same reason `metadata.ts` sets it: translated,
 * `6` becomes the string `"Rotate 90 CW"` and every numeric test silently stops
 * matching on exactly the portrait photographs it exists to correct.
 */
const ORIENTATION_OPTIONS = {
  translateValues: false,
  reviveValues: false,
  tiff: true,
  exif: false,
  icc: false,
  gps: false,
  interop: false,
  thumbnail: false,
};

async function readOrientation(bytes: ArrayBuffer): Promise<number> {
  try {
    const parsed = (await exifr.parse(bytes, ORIENTATION_OPTIONS)) as
      { Orientation?: unknown } | undefined;
    const value = parsed?.Orientation;
    return typeof value === 'number' && value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1;
  }
}
