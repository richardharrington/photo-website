/**
 * Wording for the Recently Uploaded view: when a sitting arrived, and what it
 * holds.
 *
 * This is the half of the feature that needs a calendar, which is why it lives
 * under `ui/` rather than beside the projection. The server groups without one
 * — `createdAt` is a genuine instant and an instant has no calendar day until
 * you choose a place to stand — and the browser labels with the reader's own
 * zone (decisions.md, "The server groups without a calendar").
 *
 * A consequence worth understanding rather than fixing: an evening upload can
 * be same-day for one reader and the day before for a cousin further east, so
 * she sees a subtitle and he does not. That is correct in both frames.
 */

import { formatCaptureDate, formatMonth, monthName } from '../datetime.ts';
import type { CaptureDate } from '../datetime.ts';
import type { RecentGroup } from '../display-api.ts';

/** A calendar day, as some particular zone sees some particular instant. */
export interface ReaderDay {
  year: number;
  month: number;
  day: number;
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Which calendar day an instant falls on, in the reader's zone.
 *
 * `timeZone` is normally left out, which means the reader's own. It is an
 * argument at all because Node fixes `TZ` at process start, so passing a zone
 * explicitly is the only way to test a reader east of the uploader in the same
 * process as everything else.
 *
 * The calendar and numbering system are pinned rather than inherited: the
 * reader's locale may default to a non-Gregorian calendar or to digits
 * `Number` cannot read, and all this needs is a year, a month, and a day to
 * compare against a capture date.
 */
export function readerDay(instantMs: number, timeZone?: string): ReaderDay {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instantMs));

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return { year: value('year'), month: value('month'), day: value('day') };
}

/** `YYYY-MM-DD`, so a reader's day can be compared with a capture date. */
export function readerDayIso(day: ReaderDay): CaptureDate {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(day.year).padStart(4, '0')}-${pad(day.month)}-${pad(day.day)}`;
}

/** Whole calendar days between two days, counted as days and not as hours. */
function daysBetween(from: ReaderDay, to: ReaderDay): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const at = (day: ReaderDay) => Date.UTC(day.year, day.month - 1, day.day);
  return Math.round((at(to) - at(from)) / DAY_MS);
}

/**
 * "Added today", "Added yesterday", "Added Tuesday", "Added August 21",
 * "Added August 21, 2025".
 *
 * Relative for the past week and absolute from seven days on, counted in
 * calendar days rather than 24-hour periods, so an 11pm upload is "yesterday"
 * at 1am. Month-first, like every other date on the site.
 *
 * Staleness is accepted: a page left open overnight says "Added today" about
 * yesterday until it is reloaded.
 */
export function formatAddedAt(
  uploadedAt: string,
  nowMs: number,
  timeZone?: string,
): string {
  const uploaded = readerDay(Date.parse(uploadedAt), timeZone);
  const today = readerDay(nowMs, timeZone);
  const age = daysBetween(uploaded, today);

  // A negative age means a clock disagreement rather than a photograph from
  // the future; the newest thing the library holds is still "today".
  if (age <= 0) return 'Added today';
  if (age === 1) return 'Added yesterday';
  if (age < 7) {
    const weekday = new Date(
      Date.UTC(uploaded.year, uploaded.month - 1, uploaded.day),
    ).getUTCDay();
    return `Added ${WEEKDAY_NAMES[weekday]}`;
  }

  const date = `${monthName(uploaded.month)} ${uploaded.day}`;
  return uploaded.year === today.year
    ? `Added ${date}`
    : `Added ${date}, ${uploaded.year}`;
}

/** The capture span alone, at the coarsest granularity that fits. */
function formatCaptureSpan(earliest: CaptureDate, latest: CaptureDate): string {
  if (earliest === latest) return formatCaptureDate(latest);

  const [y1, m1, d1] = earliest.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = latest.split('-').map(Number) as [number, number, number];

  // A span inside one month always prints its days, however many: "September
  // 1–23, 2026" says more than "September 2026", and a ceiling on the range
  // would be one more threshold with a cliff at its edge.
  if (y1 === y2 && m1 === m2) return `${monthName(m1)} ${d1}–${d2}, ${y1}`;
  if (y1 === y2) return `${monthName(m1)}–${monthName(m2)} ${y1}`;
  return `${formatMonth(y1, m1)} – ${formatMonth(y2, m2)}`;
}

/**
 * Is the whole sitting photographs captured on the very day it was uploaded?
 *
 * The one judgement in this feature that needs both a capture date and a
 * calendar, which is why it is made here rather than on the server. Nothing
 * weaker than strict equality suppresses the subtitle: a weekend uploaded on
 * Monday still prints its span, which is redundant-ish but true, and the
 * alternative was a second use of the 14-day window and a cliff at its edge.
 */
function isSameDayAsUpload(group: RecentGroup, timeZone?: string): boolean {
  if (group.undatedCount !== 0) return false;
  const range = group.captureRange;
  if (!range || range.earliest !== range.latest) return false;
  const day = readerDay(Date.parse(group.uploadedAt), timeZone);
  return range.latest === readerDayIso(day);
}

/**
 * The line under the heading naming what the sitting holds, or `null` when it
 * would only restate the heading.
 */
export function recentSubtitle(group: RecentGroup, timeZone?: string): string | null {
  if (isSameDayAsUpload(group, timeZone)) return null;

  const range = group.captureRange;
  if (!range) return 'undated photographs';

  const span = `photographs from ${formatCaptureSpan(range.earliest, range.latest)}`;
  return group.undatedCount > 0 ? `${span}, and ${group.undatedCount} undated` : span;
}
