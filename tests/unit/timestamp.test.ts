import { describe, it, expect, afterEach } from 'vitest';
import { parseExifDateTime, resolveTimestamp } from '../../src/shared/timestamp.ts';

describe('parseExifDateTime', () => {
  it('reads the raw EXIF colon-separated form', () => {
    expect(parseExifDateTime('2026:08:02 17:48:50')).toEqual({
      date: '2026-08-02',
      time: '17:48:50',
    });
  });

  it('appends SubSecTimeOriginal to the seconds', () => {
    expect(parseExifDateTime('2026:08:02 17:48:50', '943')).toEqual({
      date: '2026-08-02',
      time: '17:48:50.943',
    });
  });

  it('pads a short sub-second value to milliseconds', () => {
    expect(parseExifDateTime('2026:08:02 17:48:50', '9')?.time).toBe('17:48:50.900');
  });

  it('truncates an over-long sub-second value', () => {
    expect(parseExifDateTime('2026:08:02 17:48:50', '943217')?.time).toBe(
      '17:48:50.943',
    );
  });

  it('rejects the all-zero placeholder some cameras write', () => {
    expect(parseExifDateTime('0000:00:00 00:00:00')).toBeNull();
  });

  it('rejects an impossible date', () => {
    expect(parseExifDateTime('2026:02:30 12:00:00')).toBeNull();
  });

  it('returns null for missing input', () => {
    expect(parseExifDateTime(null)).toBeNull();
    expect(parseExifDateTime(undefined)).toBeNull();
    expect(parseExifDateTime('')).toBeNull();
  });
});

describe('resolveTimestamp precedence', () => {
  it('prefers DateTimeOriginal above everything else', () => {
    const resolved = resolveTimestamp({
      dateTimeOriginal: '2026:08:02 17:48:50',
      otherEmbedded: ['2020:01:01 00:00:00'],
      filename: 'IMG_19990101_010101.jpg',
    });

    expect(resolved).toEqual({
      date: '2026-08-02',
      time: '17:48:50',
      utcOffset: null,
      source: 'exif-datetimeoriginal',
    });
  });

  it('falls back to another embedded timestamp', () => {
    const resolved = resolveTimestamp({
      dateTimeOriginal: null,
      otherEmbedded: [null, '2026:08:02 09:15:00'],
      filename: 'IMG_19990101_010101.jpg',
    });

    expect(resolved.source).toBe('exif-other');
    expect(resolved.date).toBe('2026-08-02');
    expect(resolved.time).toBe('09:15:00');
  });

  it('takes embedded candidates in the order given', () => {
    const resolved = resolveTimestamp({
      otherEmbedded: ['2026:03:01 08:00:00', '2026:08:02 09:15:00'],
    });

    expect(resolved.date).toBe('2026-03-01');
  });

  it('falls back to the filename when no embedded timestamp is usable', () => {
    const resolved = resolveTimestamp({
      dateTimeOriginal: '0000:00:00 00:00:00',
      otherEmbedded: [],
      filename: 'IMG_20260802_174850943_HDR.jpg',
    });

    expect(resolved).toEqual({
      date: '2026-08-02',
      time: '17:48:50.943',
      utcOffset: null,
      source: 'filename',
    });
  });

  it('reports Undated when nothing is usable', () => {
    const resolved = resolveTimestamp({ filename: 'IMG_1234.jpg' });

    expect(resolved).toEqual({
      date: null,
      time: null,
      utcOffset: null,
      source: 'none',
    });
  });

  it('records a known UTC offset without applying it', () => {
    const resolved = resolveTimestamp({
      dateTimeOriginal: '2026:08:02 00:30:00',
      offsetTimeOriginal: '+02:00',
    });

    // The offset is retained for diagnostics, but the stored wall-clock time
    // is exactly what the camera wrote — not shifted into UTC or anywhere else.
    expect(resolved.utcOffset).toBe('+02:00');
    expect(resolved.date).toBe('2026-08-02');
    expect(resolved.time).toBe('00:30:00');
  });

  it('drops an EXIF offset when the timestamp came from the filename', () => {
    const resolved = resolveTimestamp({
      offsetTimeOriginal: '+02:00',
      filename: 'IMG_20260802_174850.jpg',
    });

    // The offset described the EXIF timestamp, which was unusable. A filename
    // carries no timezone, so keeping the offset would attach it to a value it
    // does not describe.
    expect(resolved.source).toBe('filename');
    expect(resolved.utcOffset).toBeNull();
  });

  it('ignores a malformed offset', () => {
    const resolved = resolveTimestamp({
      dateTimeOriginal: '2026:08:02 12:00:00',
      offsetTimeOriginal: 'not-an-offset',
    });

    expect(resolved.utcOffset).toBeNull();
  });
});

/**
 * The regression test named in implementation-plan.md's testing section.
 *
 * An EXIF capture time is a zoneless camera-local wall clock. Reviving it into
 * a `Date` reinterprets it in whatever timezone the parsing machine happens to
 * use; for an early-morning photo that shifts the calendar day, filing it into
 * the wrong day grid — the site's entire navigation structure (decisions.md
 * #18).
 */
describe('timezone independence', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ZONES = [
    'UTC',
    'Pacific/Kiritimati', // UTC+14, the furthest ahead
    'Pacific/Niue', // UTC-11, the furthest behind
    'America/New_York',
    'Asia/Tokyo',
  ];

  it('files an early-morning photo on the same day in every timezone', () => {
    const results = ZONES.map((zone) => {
      process.env.TZ = zone;
      return resolveTimestamp({ dateTimeOriginal: '2026:08:02 00:30:00' });
    });

    for (const resolved of results) {
      expect(resolved.date).toBe('2026-08-02');
      expect(resolved.time).toBe('00:30:00');
    }
  });

  it('files a late-evening photo on the same day in every timezone', () => {
    const results = ZONES.map((zone) => {
      process.env.TZ = zone;
      return resolveTimestamp({ dateTimeOriginal: '2026:08:02 23:45:00' });
    });

    for (const resolved of results) {
      expect(resolved.date).toBe('2026-08-02');
    }
  });

  it('is equally timezone-independent on the filename path', () => {
    const results = ZONES.map((zone) => {
      process.env.TZ = zone;
      return resolveTimestamp({ filename: 'IMG_20260802_003000.jpg' });
    });

    for (const resolved of results) {
      expect(resolved.date).toBe('2026-08-02');
      expect(resolved.time).toBe('00:30:00');
    }
  });

  it('confirms the hazard is real, so the tests above are not vacuous', () => {
    // If this control ever stops differing, the process no longer honours TZ
    // changes and the assertions above would pass without proving anything.
    process.env.TZ = 'Pacific/Kiritimati';
    const ahead = new Date('2026-08-02T00:30:00').toISOString().slice(0, 10);
    process.env.TZ = 'Pacific/Niue';
    const behind = new Date('2026-08-02T00:30:00').toISOString().slice(0, 10);

    expect(ahead).not.toBe(behind);
  });
});
