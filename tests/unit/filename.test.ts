import { describe, it, expect } from 'vitest';
import {
  parseTimestampFromFilename,
  downloadFilenameFor,
} from '../../src/shared/filename.ts';

describe('parseTimestampFromFilename', () => {
  it('parses the pattern named in design.md', () => {
    expect(parseTimestampFromFilename('IMG_20260802_174850943_HDR.jpg')).toEqual({
      date: '2026-08-02',
      time: '17:48:50.943',
    });
  });

  it('parses common camera and screenshot forms', () => {
    const cases: [string, string, string | null][] = [
      ['PXL_20260802_174850943.jpg', '2026-08-02', '17:48:50.943'],
      ['Screenshot_20260802-174850.png', '2026-08-02', '17:48:50'],
      ['2026-08-02 17:48:50.jpg', '2026-08-02', '17:48:50'],
      ['2026-08-02T17:48:50.heic', '2026-08-02', '17:48:50'],
      ['20260802174850.jpg', '2026-08-02', '17:48:50'],
      ['VID_20260802_174850.mp4', '2026-08-02', '17:48:50'],
      ['20260802.jpg', '2026-08-02', null],
      ['2026-08-02.jpg', '2026-08-02', null],
      ['holiday-20260802-beach.jpeg', '2026-08-02', null],
    ];

    for (const [filename, date, time] of cases) {
      expect(parseTimestampFromFilename(filename), filename).toEqual({
        date,
        time,
      });
    }
  });

  it('refuses ambiguous numeric date orders', () => {
    // 03/04/2026 is March 4th or April 3rd depending on the writer. Guessing
    // would silently file the photo under a fabricated date.
    for (const filename of [
      '03-04-2026.jpg',
      '03/04/2026.jpg',
      '04.03.2026.jpg',
      'IMG_08022026.jpg',
    ]) {
      expect(parseTimestampFromFilename(filename), filename).toBeNull();
    }
  });

  it('rejects digit runs that are not real dates', () => {
    for (const filename of [
      'IMG_12345678.jpg',
      'IMG_20261301.jpg',
      'IMG_20260230.jpg',
      'IMG_20260000.jpg',
      'DSC_0042.jpg',
      'IMG_1234.jpg',
      'no-digits-at-all.png',
    ]) {
      expect(parseTimestampFromFilename(filename), filename).toBeNull();
    }
  });

  it('does not carve a date out of the middle of a longer number', () => {
    expect(parseTimestampFromFilename('999920260802999.jpg')).toBeNull();
    expect(parseTimestampFromFilename('IMG_1234567890123.jpg')).toBeNull();
  });

  it('skips a date-shaped run that is not valid and keeps scanning', () => {
    expect(parseTimestampFromFilename('IMG_12345678_20260802.jpg')).toEqual({
      date: '2026-08-02',
      time: null,
    });
  });

  it('stays inside a plausible year window', () => {
    expect(parseTimestampFromFilename('IMG_19690802.jpg')).toBeNull();
    expect(parseTimestampFromFilename('IMG_21000802.jpg')).toBeNull();
    expect(parseTimestampFromFilename('IMG_19700802.jpg')?.date).toBe('1970-08-02');
    expect(parseTimestampFromFilename('IMG_20990802.jpg')?.date).toBe('2099-08-02');
  });

  it('ignores an adjacent run that is not a valid time', () => {
    // Date still parses; the impossible time is simply not used.
    expect(parseTimestampFromFilename('IMG_20260802_997060.jpg')).toEqual({
      date: '2026-08-02',
      time: null,
    });
  });

  it('accepts a leap day and rejects a non-leap February 29th', () => {
    expect(parseTimestampFromFilename('IMG_20240229.jpg')?.date).toBe('2024-02-29');
    expect(parseTimestampFromFilename('IMG_20260229.jpg')).toBeNull();
  });
});

describe('downloadFilenameFor', () => {
  const ID = 'a'.repeat(32);

  it('keeps the original basename and forces a .jpg extension', () => {
    expect(downloadFilenameFor('IMG_20260802.HEIC', ID)).toBe('IMG_20260802.jpg');
    expect(downloadFilenameFor('beach day.png', ID)).toBe('beach day.jpg');
    expect(downloadFilenameFor('photo.jpeg', ID)).toBe('photo.jpg');
  });

  it('strips directory components from a dropped folder path', () => {
    expect(downloadFilenameFor('2026/august/IMG_0001.HEIC', ID)).toBe('IMG_0001.jpg');
    expect(downloadFilenameFor('C:\\Photos\\IMG_0001.HEIC', ID)).toBe('IMG_0001.jpg');
  });

  it('removes path separators and reserved characters', () => {
    expect(downloadFilenameFor('a:b*c?d"e<f>g|h.jpg', ID)).toBe('abcdefgh.jpg');
  });

  it('keeps characters that are common and safe in photo names', () => {
    expect(downloadFilenameFor("Nana's 80th (best).jpg", ID)).toBe(
      "Nana's 80th (best).jpg",
    );
    expect(downloadFilenameFor('beach-day_2026.jpg', ID)).toBe('beach-day_2026.jpg');
  });

  it('falls back to the photo ID when nothing usable survives', () => {
    expect(downloadFilenameFor('...', ID)).toBe(`${ID}.jpg`);
    expect(downloadFilenameFor('', ID)).toBe(`${ID}.jpg`);
    expect(downloadFilenameFor('/', ID)).toBe(`${ID}.jpg`);
  });

  it('never leaves a leading or trailing dot after truncation', () => {
    const long = `${'x'.repeat(95)}.....jpg`;
    const result = downloadFilenameFor(long, ID);

    expect(result.endsWith('.jpg')).toBe(true);
    expect(result).not.toMatch(/\.\.+jpg$/);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('does not treat a long trailing segment as an extension', () => {
    expect(downloadFilenameFor('report.2026summary', ID)).toBe(
      'report.2026summary.jpg',
    );
  });
});
