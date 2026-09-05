/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest';
import { formatAddedAt, recentSubtitle } from '../../src/shared/ui/recent-labels.ts';
import type { RecentGroup } from '../../src/shared/display-api.ts';

/**
 * The words the browser puts on an upload sitting.
 *
 * The server never names a calendar day, so everything here is a function of
 * an instant, a clock, and a zone. The zone is passed explicitly because Node
 * fixes `TZ` at process start: without it, the case that matters most — a
 * reader for whom the upload fell on a different day than it did for the
 * uploader — could not be tested in the same process as the rest.
 */

const NOW = Date.parse('2026-09-04T18:00:00.000Z');
const UTC = 'UTC';

function group(overrides: Partial<RecentGroup> = {}): RecentGroup {
  return {
    uploadedAt: '2026-09-04T12:00:00.000Z',
    count: 3,
    captureRange: { earliest: '2026-09-04', latest: '2026-09-04' },
    undatedCount: 0,
    photoIds: ['a', 'b', 'c'],
    ...overrides,
  };
}

describe('formatAddedAt', () => {
  it('names today, yesterday, and the weekday inside the past week', () => {
    expect(formatAddedAt('2026-09-04T01:00:00.000Z', NOW, UTC)).toBe('Added today');
    expect(formatAddedAt('2026-09-03T23:00:00.000Z', NOW, UTC)).toBe('Added yesterday');
    // 2026-09-01 is a Tuesday.
    expect(formatAddedAt('2026-09-01T10:00:00.000Z', NOW, UTC)).toBe('Added Tuesday');
    // Six days back is the last day the weekday still reads as recent.
    expect(formatAddedAt('2026-08-29T10:00:00.000Z', NOW, UTC)).toBe('Added Saturday');
  });

  it('counts calendar days, not twenty-four hour periods', () => {
    // Twenty-two hours earlier, but the calendar day before: "yesterday".
    const now = Date.parse('2026-09-04T01:00:00.000Z');
    expect(formatAddedAt('2026-09-03T23:00:00.000Z', now, UTC)).toBe('Added yesterday');
  });

  it('turns absolute from seven days on, month first', () => {
    expect(formatAddedAt('2026-08-28T10:00:00.000Z', NOW, UTC)).toBe('Added August 28');
  });

  it('adds the year once it is not the current one', () => {
    expect(formatAddedAt('2025-08-21T10:00:00.000Z', NOW, UTC)).toBe(
      'Added August 21, 2025',
    );
  });

  it('reads the instant in the zone it is given', () => {
    // 11pm in Los Angeles on the 3rd is the 4th in UTC.
    const uploaded = '2026-09-04T06:00:00.000Z';
    expect(formatAddedAt(uploaded, NOW, UTC)).toBe('Added today');
    expect(formatAddedAt(uploaded, NOW, 'America/Los_Angeles')).toBe('Added yesterday');
  });
});

describe('the subtitle', () => {
  it('names one capture date in full', () => {
    expect(
      recentSubtitle(
        group({
          uploadedAt: '2026-09-04T12:00:00.000Z',
          captureRange: { earliest: '2026-08-02', latest: '2026-08-02' },
        }),
        UTC,
      ),
    ).toBe('photographs from August 2, 2026');
  });

  it('prints the days of a span inside one month', () => {
    expect(
      recentSubtitle(
        group({ captureRange: { earliest: '2026-09-01', latest: '2026-09-03' } }),
        UTC,
      ),
    ).toBe('photographs from September 1–3, 2026');
  });

  /**
   * A ceiling on the range would be one more threshold with a cliff at its
   * edge. "September 1–23" says more than "September 2026", however long the
   * span.
   */
  it('still prints the days of a within-month span longer than a fortnight', () => {
    expect(
      recentSubtitle(
        group({ captureRange: { earliest: '2026-09-01', latest: '2026-09-23' } }),
        UTC,
      ),
    ).toBe('photographs from September 1–23, 2026');
  });

  it('drops to months across one year', () => {
    expect(
      recentSubtitle(
        group({ captureRange: { earliest: '1978-03-14', latest: '1978-08-02' } }),
        UTC,
      ),
    ).toBe('photographs from March–August 1978');
  });

  it('names both months and both years across several', () => {
    expect(
      recentSubtitle(
        group({ captureRange: { earliest: '1977-03-14', latest: '1978-08-02' } }),
        UTC,
      ),
    ).toBe('photographs from March 1977 – August 1978');
  });

  it('appends the undated count when some are undated', () => {
    expect(
      recentSubtitle(
        group({
          captureRange: { earliest: '1977-03-14', latest: '1978-08-02' },
          undatedCount: 4,
        }),
        UTC,
      ),
    ).toBe('photographs from March 1977 – August 1978, and 4 undated');
  });

  it('says so when everything in the sitting is undated', () => {
    expect(recentSubtitle(group({ captureRange: null, undatedCount: 3 }), UTC)).toBe(
      'undated photographs',
    );
  });
});

describe('same-day suppression', () => {
  it('omits the subtitle for photographs shot and uploaded the same day', () => {
    expect(
      recentSubtitle(
        group({
          uploadedAt: '2026-09-04T12:00:00.000Z',
          captureRange: { earliest: '2026-09-04', latest: '2026-09-04' },
          undatedCount: 0,
        }),
        UTC,
      ),
    ).toBeNull();
  });

  /**
   * The same sitting read from a zone where the upload falls on the next day.
   * She sees the subtitle and he does not, and both are right: to her, these
   * *are* photographs from the day before they appeared.
   */
  it('keeps the subtitle for a reader whose day the upload falls on differently', () => {
    expect(
      recentSubtitle(
        group({
          uploadedAt: '2026-09-04T22:00:00.000Z',
          captureRange: { earliest: '2026-09-04', latest: '2026-09-04' },
          undatedCount: 0,
        }),
        'Europe/Berlin',
      ),
    ).toBe('photographs from September 4, 2026');
  });

  it('keeps the subtitle when one undated photograph is in the sitting', () => {
    expect(
      recentSubtitle(
        group({
          uploadedAt: '2026-09-04T12:00:00.000Z',
          captureRange: { earliest: '2026-09-04', latest: '2026-09-04' },
          undatedCount: 1,
        }),
        UTC,
      ),
    ).toBe('photographs from September 4, 2026, and 1 undated');
  });

  /**
   * Nothing weaker than strict equality suppresses: a weekend uploaded on
   * Monday still prints its span, which is redundant-ish but true.
   */
  it('keeps the subtitle for a span ending on the day it was uploaded', () => {
    expect(
      recentSubtitle(
        group({
          uploadedAt: '2026-09-07T12:00:00.000Z',
          captureRange: { earliest: '2026-09-05', latest: '2026-09-07' },
        }),
        UTC,
      ),
    ).toBe('photographs from September 5–7, 2026');
  });
});
