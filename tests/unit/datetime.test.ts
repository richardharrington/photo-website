import { describe, it, expect } from 'vitest';
import {
  normalizeCaptureDate,
  normalizeCaptureTime,
  normalizeUtcOffset,
  validateCaptureMoment,
  timeSortKey,
  daysInMonth,
  isLeapYear,
  formatCaptureDate,
  formatCaptureTimeForViewer,
  formatMonth,
  splitCaptureDate,
} from '../../src/shared/datetime.ts';

describe('normalizeCaptureDate', () => {
  it('accepts a real date', () => {
    expect(normalizeCaptureDate('2026-08-02')).toBe('2026-08-02');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCaptureDate('  2026-08-02 ')).toBe('2026-08-02');
  });

  it('rejects an impossible day', () => {
    expect(normalizeCaptureDate('2026-02-30')).toBeNull();
    expect(normalizeCaptureDate('2026-04-31')).toBeNull();
    expect(normalizeCaptureDate('2026-13-01')).toBeNull();
    expect(normalizeCaptureDate('2026-00-10')).toBeNull();
    expect(normalizeCaptureDate('2026-01-00')).toBeNull();
  });

  it('handles leap days by rule, not by Date arithmetic', () => {
    expect(normalizeCaptureDate('2024-02-29')).toBe('2024-02-29');
    expect(normalizeCaptureDate('2026-02-29')).toBeNull();
    expect(normalizeCaptureDate('2000-02-29')).toBe('2000-02-29');
    expect(normalizeCaptureDate('1900-02-29')).toBeNull();
  });

  it('rejects unpadded and non-ISO forms rather than guessing', () => {
    expect(normalizeCaptureDate('2026-8-2')).toBeNull();
    expect(normalizeCaptureDate('08/02/2026')).toBeNull();
    expect(normalizeCaptureDate('2026-08-02T10:00:00Z')).toBeNull();
  });

  it('does not roll an out-of-range date forward the way Date would', () => {
    // `new Date('2026-02-30')` is not NaN in every engine, and Date arithmetic
    // happily rolls February 30th into March 2nd. Nothing here uses Date.
    expect(normalizeCaptureDate('2026-02-30')).toBeNull();
  });
});

describe('isLeapYear / daysInMonth', () => {
  it('follows the Gregorian rule', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2025)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('reports month lengths', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe('normalizeCaptureTime', () => {
  it('pads a bare hour and minute to seconds', () => {
    expect(normalizeCaptureTime('17:48')).toBe('17:48:00');
  });

  it('keeps seconds and pads fractional digits to milliseconds', () => {
    expect(normalizeCaptureTime('17:48:50')).toBe('17:48:50');
    expect(normalizeCaptureTime('17:48:50.943')).toBe('17:48:50.943');
    expect(normalizeCaptureTime('17:48:50.9')).toBe('17:48:50.900');
  });

  it('accepts midnight and the last second of the day', () => {
    expect(normalizeCaptureTime('00:00:00')).toBe('00:00:00');
    expect(normalizeCaptureTime('23:59:59')).toBe('23:59:59');
  });

  it('rejects out-of-range components', () => {
    expect(normalizeCaptureTime('24:00:00')).toBeNull();
    expect(normalizeCaptureTime('17:60:00')).toBeNull();
    expect(normalizeCaptureTime('17:48:60')).toBeNull();
  });

  it('rejects forms it cannot read unambiguously', () => {
    expect(normalizeCaptureTime('5:48 PM')).toBeNull();
    expect(normalizeCaptureTime('174850')).toBeNull();
  });
});

describe('normalizeUtcOffset', () => {
  it('accepts a signed offset', () => {
    expect(normalizeUtcOffset('+02:00')).toBe('+02:00');
    expect(normalizeUtcOffset('-07:00')).toBe('-07:00');
  });

  it('rejects anything else', () => {
    expect(normalizeUtcOffset('0200')).toBeNull();
    expect(normalizeUtcOffset('Z')).toBeNull();
    expect(normalizeUtcOffset('')).toBeNull();
  });
});

describe('validateCaptureMoment', () => {
  it('accepts a date with a time', () => {
    const result = validateCaptureMoment({ date: '2026-08-02', time: '17:48' });
    expect(result).toEqual({
      ok: true,
      value: { date: '2026-08-02', time: '17:48:00' },
    });
  });

  it('accepts a date with no time', () => {
    const result = validateCaptureMoment({ date: '2026-08-02', time: null });
    expect(result).toEqual({ ok: true, value: { date: '2026-08-02', time: null } });
  });

  it('clears the time when the date is cleared', () => {
    // The rule from design.md: a time is meaningful only alongside a date, and
    // removing the date removes the time rather than rejecting the edit.
    for (const date of [null, '', '   ', undefined]) {
      expect(validateCaptureMoment({ date, time: '17:48' })).toEqual({
        ok: true,
        value: { date: null, time: null },
      });
    }
  });

  it('rejects an invalid date', () => {
    const result = validateCaptureMoment({ date: '2026-02-30', time: null });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid time alongside a valid date', () => {
    const result = validateCaptureMoment({ date: '2026-08-02', time: '25:00' });
    expect(result.ok).toBe(false);
  });
});

describe('timeSortKey', () => {
  it('orders times within a day', () => {
    expect(timeSortKey('08:00:00')).toBeLessThan(timeSortKey('17:48:50'));
    expect(timeSortKey('17:48:50')).toBeLessThan(timeSortKey('17:48:50.943'));
  });

  it('sorts a missing time after every real time', () => {
    expect(timeSortKey(null)).toBe(Number.POSITIVE_INFINITY);
    expect(timeSortKey('23:59:59.999')).toBeLessThan(timeSortKey(null));
  });
});

describe('formatting', () => {
  it('writes unambiguous text dates', () => {
    expect(formatCaptureDate('2026-08-02')).toBe('August 2, 2026');
    expect(formatCaptureDate('2026-12-25')).toBe('December 25, 2026');
    expect(formatMonth(2026, 8)).toBe('August 2026');
  });

  it('shows viewer times as 12-hour clock without seconds', () => {
    expect(formatCaptureTimeForViewer('17:48:50.943')).toBe('5:48 PM');
    expect(formatCaptureTimeForViewer('00:05:00')).toBe('12:05 AM');
    expect(formatCaptureTimeForViewer('12:00:00')).toBe('12:00 PM');
    expect(formatCaptureTimeForViewer('09:30:00')).toBe('9:30 AM');
  });

  it('splits a canonical date into numeric parts', () => {
    expect(splitCaptureDate('2026-08-02')).toEqual({
      year: 2026,
      month: 8,
      day: 2,
    });
  });
});
