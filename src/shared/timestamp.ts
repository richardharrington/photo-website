/**
 * Timestamp precedence.
 *
 * Kept separate from EXIF extraction so the precedence rule can be tested
 * without decoding an image, and so the same rule is available to the API when
 * it validates what the browser submitted.
 */

import { normalizeCaptureDate, normalizeCaptureTime } from './datetime.ts';
import type { CaptureDate, CaptureTime } from './datetime.ts';
import { parseTimestampFromFilename } from './filename.ts';
import type { TimestampSource } from './catalog.ts';

/**
 * Candidate timestamps as read from the file, before any interpretation.
 *
 * The EXIF fields are **raw camera-local strings** in `YYYY:MM:DD HH:MM:SS`
 * form, exactly as `exifr` returns them under `reviveValues: false`. They are
 * strings rather than `Date`s on purpose: a `Date` here would already have
 * been reinterpreted in the parsing machine's timezone, which is precisely the
 * defect recorded in decisions.md #18.
 */
export interface TimestampCandidates {
  /** EXIF `DateTimeOriginal`, the highest-precedence source. */
  dateTimeOriginal?: string | null;
  /** `CreateDate` / `DateTimeDigitized` / `ModifyDate`, in that order. */
  otherEmbedded?: readonly (string | null | undefined)[];
  /** EXIF `SubSecTimeOriginal`, appended to the seconds when present. */
  subSecOriginal?: string | null;
  /** EXIF `OffsetTimeOriginal`, e.g. `+02:00`. Recorded, never applied. */
  offsetTimeOriginal?: string | null;
  filename?: string | null;
}

export interface ResolvedTimestamp {
  date: CaptureDate | null;
  time: CaptureTime | null;
  utcOffset: string | null;
  source: TimestampSource;
}

/** `2026:08:02 17:48:50` — EXIF's colon-separated date form. */
const EXIF_DATETIME_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * Parse one raw EXIF datetime string into camera-local date and time parts.
 * Returns null for the all-zero placeholder some cameras write, and for
 * anything that is not a real calendar date.
 */
export function parseExifDateTime(
  raw: string | null | undefined,
  subSec?: string | null,
): { date: CaptureDate; time: CaptureTime } | null {
  if (!raw) return null;
  const match = EXIF_DATETIME_RE.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match as unknown as string[];

  const date = normalizeCaptureDate(`${y}-${mo}-${d}`);
  if (date === null) return null;

  const fraction = subSec ? String(subSec).replace(/\D/g, '').slice(0, 3) : '';
  const timeText = fraction ? `${h}:${mi}:${s}.${fraction}` : `${h}:${mi}:${s}`;
  const time = normalizeCaptureTime(timeText);
  if (time === null) return null;

  return { date, time };
}

/**
 * Apply the precedence from design.md:
 *   1. `DateTimeOriginal`
 *   2. other embedded creation timestamps
 *   3. an unambiguous filename timestamp
 *   4. Undated
 */
export function resolveTimestamp(candidates: TimestampCandidates): ResolvedTimestamp {
  const utcOffset = normalizeOffset(candidates.offsetTimeOriginal);

  const original = parseExifDateTime(
    candidates.dateTimeOriginal,
    candidates.subSecOriginal,
  );
  if (original) {
    return { ...original, utcOffset, source: 'exif-datetimeoriginal' };
  }

  for (const raw of candidates.otherEmbedded ?? []) {
    const parsed = parseExifDateTime(raw);
    if (parsed) return { ...parsed, utcOffset, source: 'exif-other' };
  }

  if (candidates.filename) {
    const fromName = parseTimestampFromFilename(candidates.filename);
    if (fromName) {
      return {
        date: fromName.date,
        time: fromName.time,
        // A filename carries no timezone information, so an offset read from
        // EXIF does not describe this timestamp and is dropped.
        utcOffset: null,
        source: 'filename',
      };
    }
  }

  return { date: null, time: null, utcOffset: null, source: 'none' };
}

function normalizeOffset(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return /^[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : null;
}
