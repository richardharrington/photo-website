/**
 * Conservative filename timestamp extraction, and download-filename
 * sanitization.
 *
 * Filename parsing is the *last* timestamp source before "Undated", so a wrong
 * guess is worse than no guess: it silently files a photo under a fabricated
 * date. Only year-first forms are recognized, because they are the only
 * unambiguous ones — `03/04/2026` is March 4th or April 3rd depending on who
 * wrote it, and is deliberately never parsed.
 */

import { isValidYmd, type CaptureDate, type CaptureTime } from './datetime.ts';

/**
 * Narrower than the manual-entry year range. A filename date is inferred from
 * an unlabelled digit run, so the window is kept tight to limit false
 * positives from serial numbers and other incidental digits.
 */
const FILENAME_MIN_YEAR = 1970;
const FILENAME_MAX_YEAR = 2099;

/**
 * Year, month, day, then an adjacent time. Separators are optional and each is
 * matched individually, so `20260802_174850943`, `2026-08-02 17:48:50`, and
 * `20260802174850` all parse. `(?<!\d)` / `(?!\d)` anchor the match to whole
 * digit runs, so a date cannot be carved out of the middle of a longer number.
 */
const DATETIME_RE =
  /(?<!\d)(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[T_\- .]?(\d{2})[:.]?(\d{2})[:.]?(\d{2})(?:[.,_]?(\d{1,3}))?(?!\d)/g;

/** Date with no usable adjacent time. */
const DATE_RE = /(?<!\d)(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/g;

export interface FilenameTimestamp {
  date: CaptureDate;
  time: CaptureTime | null;
}

function plausibleFilenameDate(year: number, month: number, day: number): boolean {
  if (year < FILENAME_MIN_YEAR || year > FILENAME_MAX_YEAR) return false;
  return isValidYmd(year, month, day);
}

function validTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Extract an unambiguous timestamp from a filename, or null.
 *
 * Scans every candidate rather than stopping at the first regex hit, so a
 * leading digit run that merely looks date-shaped (`IMG_12345678_...`) does
 * not suppress a real date later in the name.
 */
export function parseTimestampFromFilename(filename: string): FilenameTimestamp | null {
  for (const match of filename.matchAll(DATETIME_RE)) {
    const [, y, mo, d, h, mi, s, frac] = match as unknown as string[];
    if (!plausibleFilenameDate(Number(y), Number(mo), Number(d))) continue;
    if (!validTime(Number(h), Number(mi), Number(s))) continue;
    const base = `${h}:${mi}:${s}`;
    return {
      date: `${y}-${mo}-${d}`,
      time: frac ? `${base}.${frac.padEnd(3, '0')}` : base,
    };
  }

  for (const match of filename.matchAll(DATE_RE)) {
    const [, y, mo, d] = match as unknown as string[];
    if (!plausibleFilenameDate(Number(y), Number(mo), Number(d))) continue;
    return { date: `${y}-${mo}-${d}`, time: null };
  }

  return null;
}

/**
 * Control characters, path separators, and the characters Windows reserves.
 * Deliberately narrow: hyphens, underscores, spaces, and parentheses are
 * common in real photo names and are safe to keep. Written with escapes
 * rather than literal bytes so the class stays readable in source.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_FILENAME_CHARS = new RegExp('[\\u0000-\\u001f\\u007f/\\\\:*?"<>|]+', 'g');

const MAX_DOWNLOAD_BASENAME = 96;

/**
 * Build the filename a full-resolution download is served as: the original
 * basename, sanitized, with a `.jpg` extension — because every stored
 * original-size artifact is a re-encoded JPEG regardless of source format.
 */
export function downloadFilenameFor(originalFilename: string, photoId: string): string {
  const withoutDirs = originalFilename.split(/[/\\]/).pop() ?? '';
  const withoutExt = withoutDirs.replace(/\.[^.]{1,10}$/, '');

  const cleaned = withoutExt
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_DOWNLOAD_BASENAME)
    // Slicing can re-expose a trailing dot or space.
    .replace(/[.\s]+$/g, '');

  // A name made entirely of stripped characters still needs to download as
  // something; the photo ID is guaranteed present and safe.
  return `${cleaned === '' ? photoId : cleaned}.jpg`;
}
