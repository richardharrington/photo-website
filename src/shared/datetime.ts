/**
 * Capture date and time handling.
 *
 * Capture timestamps are **camera-local wall-clock values held as strings**.
 * Nothing here constructs a `Date` from them, and nothing may: reviving a
 * zoneless camera-local time in the parsing machine's timezone gives it a
 * spurious instant, and for photos taken before roughly 08:00 local that
 * shifts the calendar day — filing the photo into the wrong day grid, which
 * is the site's entire navigation structure (decisions.md #18).
 *
 * `Date` is used only for genuine instants (record creation, trash
 * expiry), which are separate fields.
 */

/** `YYYY-MM-DD`, camera-local. */
export type CaptureDate = string;
/** `HH:MM:SS` or `HH:MM:SS.mmm`, camera-local. */
export type CaptureTime = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

export const MIN_YEAR = 1826;
export const MAX_YEAR = 2999;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * Parse and canonicalize a capture date. Purely lexical: no `Date` involved,
 * so the result cannot depend on the machine's timezone.
 */
export function normalizeCaptureDate(input: string): CaptureDate | null {
  const match = DATE_RE.exec(input.trim());
  if (!match) return null;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!isValidYmd(year, month, day)) return null;
  return `${y}-${m}-${d}`;
}

/**
 * Parse and canonicalize a capture time. Accepts `HH:MM`, `HH:MM:SS`, and
 * `HH:MM:SS.mmm`; emits `HH:MM:SS` or `HH:MM:SS.mmm`. Fractional precision is
 * retained because it orders same-second burst photos, even though the viewer
 * does not display it.
 */
export function normalizeCaptureTime(input: string): CaptureTime | null {
  const match = TIME_RE.exec(input.trim());
  if (!match) return null;
  const [, hh, mm, ss, frac] = match;
  const hour = Number(hh);
  const minute = Number(mm);
  const second = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const base = `${hh}:${mm}:${String(second).padStart(2, '0')}`;
  return frac ? `${base}.${frac.padEnd(3, '0')}` : base;
}

/** A known UTC offset such as `+02:00`. Recorded, never applied. */
export function normalizeUtcOffset(input: string): string | null {
  const trimmed = input.trim();
  return OFFSET_RE.test(trimmed) ? trimmed : null;
}

export interface CaptureMoment {
  date: CaptureDate | null;
  time: CaptureTime | null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The single date/time rule, shared by the admin UI and the admin API so both
 * enforce it identically: a time is meaningful only alongside a date, and
 * clearing the date clears the time with it.
 */
export function validateCaptureMoment(input: {
  date: string | null | undefined;
  time: string | null | undefined;
}): ValidationResult<CaptureMoment> {
  const rawDate = input.date?.trim() ?? '';
  const rawTime = input.time?.trim() ?? '';

  if (rawDate === '') {
    // Clearing the date clears the time rather than rejecting the edit, so the
    // UI's "remove date" action is a single uncontroversial step.
    return { ok: true, value: { date: null, time: null } };
  }

  const date = normalizeCaptureDate(rawDate);
  if (date === null) {
    return { ok: false, error: 'Capture date must be a real date in YYYY-MM-DD form.' };
  }

  if (rawTime === '') return { ok: true, value: { date, time: null } };

  const time = normalizeCaptureTime(rawTime);
  if (time === null) {
    return {
      ok: false,
      error: 'Capture time must be a real time in HH:MM or HH:MM:SS form.',
    };
  }

  return { ok: true, value: { date, time } };
}

/** Sort key for a capture time; date-only photos sort after timed ones. */
export function timeSortKey(time: CaptureTime | null): number {
  if (time === null) return Number.POSITIVE_INFINITY;
  const match = TIME_RE.exec(time);
  if (!match) return Number.POSITIVE_INFINITY;
  const [, hh, mm, ss, frac] = match;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Number(hh) * 3_600_000 + Number(mm) * 60_000 + Number(ss ?? '0') * 1000 + ms;
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function splitCaptureDate(date: CaptureDate): DateParts {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Not a canonical capture date: ${date}`);
  const [, y, m, d] = match as unknown as [string, string, string, string];
  return { year: Number(y), month: Number(m), day: Number(d) };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/** "August 2, 2026" — unambiguous text, never a locale-ordered numeric date. */
export function formatCaptureDate(date: CaptureDate): string {
  const { year, month, day } = splitCaptureDate(date);
  return `${monthName(month)} ${day}, ${year}`;
}

/** "August 2026". */
export function formatMonth(year: number, month: number): string {
  return `${monthName(month)} ${year}`;
}

/**
 * "5:48 PM" — viewer presentation drops seconds and milliseconds. Formatted
 * arithmetically rather than through `Intl`/`Date`, which would require
 * inventing a timezone for a value that deliberately has none.
 */
export function formatCaptureTimeForViewer(time: CaptureTime): string {
  const match = TIME_RE.exec(time);
  if (!match) return time;
  const [, hh, mm] = match as unknown as [string, string, string];
  const hour24 = Number(hh);
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${mm} ${suffix}`;
}

/** Admin presentation keeps full precision. */
export function formatCaptureTimeForAdmin(time: CaptureTime): string {
  return time;
}
