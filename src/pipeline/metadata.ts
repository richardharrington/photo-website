/**
 * EXIF extraction.
 *
 * Both `exifr` options here are load-bearing, and each guards a different
 * defect (decisions.md #18). Setting only one produces a silent corruption:
 *
 * - `reviveValues: false` keeps `DateTimeOriginal` as the raw
 *   `YYYY:MM:DD HH:MM:SS` string. Revived, it becomes a `Date` interpreted in
 *   the *parsing machine's* timezone, giving a zoneless camera-local wall
 *   clock a spurious instant; for a photo taken before roughly 08:00 that
 *   shifts the calendar day and files it into the wrong day grid.
 *
 * - `translateValues: false` keeps `Orientation` as the number `6` rather than
 *   the string `"Rotate 90 CW"`, so the numeric test in orientation.ts does
 *   not silently skip rotation on exactly the portrait photos it exists to
 *   correct.
 */

import exifr from 'exifr';
import { asExifOrientation } from './orientation.ts';
import type { ExifOrientation } from './orientation.ts';
import { resolveTimestamp } from '../shared/timestamp.ts';
import type { ResolvedTimestamp } from '../shared/timestamp.ts';

export interface SourceMetadata {
  timestamp: ResolvedTimestamp;
  orientation: ExifOrientation;
  /** ICC profile description, used to decide whether to convert colour. */
  colorProfile: string | null;
  /** True when the file carried GPS coordinates. Recorded to confirm they are
   * dropped, never stored. */
  hadGpsData: boolean;
}

const EXIF_OPTIONS = {
  // These two must be set together; either alone yields a silent defect.
  reviveValues: false,
  translateValues: false,

  tiff: true,
  exif: true,
  icc: true,
  // Parsed only to confirm it is being discarded, never to store it.
  gps: true,
  // Nothing here needs interoperability or thumbnail data.
  interop: false,
  thumbnail: false,
};

interface RawExif {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  DateTimeDigitized?: unknown;
  ModifyDate?: unknown;
  SubSecTimeOriginal?: unknown;
  OffsetTimeOriginal?: unknown;
  Orientation?: unknown;
  ProfileDescription?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  GPSLatitude?: unknown;
  GPSLongitude?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Read what the pipeline needs from a source file.
 */
export async function readSourceMetadata(
  file: Blob,
  filename: string,
): Promise<SourceMetadata> {
  // Malformed or absent metadata must not fail an upload: a scan or an
  // exported PNG often carries none, and the photo is still perfectly usable.
  // The timestamp then falls through to the filename, or to Undated.
  let raw: RawExif;
  try {
    raw = ((await exifr.parse(file, EXIF_OPTIONS)) ?? {}) as RawExif;
  } catch {
    raw = {};
  }

  const timestamp = resolveTimestamp({
    dateTimeOriginal: asString(raw.DateTimeOriginal),
    otherEmbedded: [
      asString(raw.CreateDate),
      asString(raw.DateTimeDigitized),
      asString(raw.ModifyDate),
    ],
    subSecOriginal: asString(raw.SubSecTimeOriginal),
    offsetTimeOriginal: asString(raw.OffsetTimeOriginal),
    filename,
  });

  return {
    timestamp,
    orientation: asExifOrientation(raw.Orientation),
    colorProfile: asString(raw.ProfileDescription),
    hadGpsData:
      raw.latitude != null ||
      raw.longitude != null ||
      raw.GPSLatitude != null ||
      raw.GPSLongitude != null,
  };
}
