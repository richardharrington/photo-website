/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentPage } from '../../src/shared/ui/RecentPage.tsx';
import { Lightbox } from '../../src/shared/ui/Lightbox.tsx';
import { timelineResponse, toPublicPhoto } from '../../src/shared/display-api.ts';
import { appRoutes } from '../../src/shared/urls.ts';
import { makeCatalog, makePhoto } from '../../fixtures/photos.ts';
import type { Resource } from '../../src/shared/ui/useResource.ts';
import type { TimelineResponse } from '../../src/shared/display-api.ts';

/**
 * The Recently Uploaded page as it renders, and the one behaviour of the photo
 * view that only this route has: a link that has outlived its own sitting.
 */

const NOW = Date.parse('2026-09-04T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const UTC = 'UTC';
const routes = appRoutes('/test-base');

function ready(data: TimelineResponse): Resource<TimelineResponse> {
  return { status: 'ready', data, stale: false };
}

function page(timeline: TimelineResponse) {
  return render(
    <RecentPage resource={ready(timeline)} target="top" nowMs={NOW} timeZone={UTC} />,
  );
}

describe('the recent page', () => {
  const holiday = makePhoto({
    id: 'a'.repeat(32),
    captureDate: '2026-08-15',
    captureTime: '10:00:00',
    batchSeq: 1,
    createdAt: new Date(NOW - 30 * HOUR).toISOString(),
  });
  const scan = makePhoto({
    id: 'b'.repeat(32),
    captureDate: '1978-03-02',
    captureTime: null,
    batchSeq: 1,
    createdAt: new Date(NOW - 30 * HOUR).toISOString(),
  });

  const timeline = timelineResponse(makeCatalog([holiday, scan]), 'Family Photos', NOW);

  it('heads each sitting with when it arrived and how much it holds', () => {
    page(timeline);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Added yesterday');
    expect(heading).toHaveTextContent('2 photos');
  });

  it('names the capture span beneath it', () => {
    page(timeline);
    expect(
      screen.getByText('photographs from March 1978 – August 2026'),
    ).toBeInTheDocument();
  });

  it('links its tiles into the recent view, not the library', () => {
    page(timeline);
    const links = screen.getAllByRole('link');
    const tiles = links.filter((link) =>
      link.getAttribute('href')?.includes('/photo/'),
    );
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.getAttribute('href')).toMatch(/\/test-base\/recent\/photo\//);
    }
  });

  /**
   * The subtitle is omitted only when it would restate the heading exactly:
   * every photograph captured on the very day the sitting was uploaded, in the
   * reader's own zone.
   */
  it('drops the subtitle for photographs shot and uploaded the same day', () => {
    const sameDay = makePhoto({
      id: 'c'.repeat(32),
      captureDate: '2026-09-04',
      captureTime: '09:00:00',
      batchSeq: 2,
      createdAt: new Date(NOW - HOUR).toISOString(),
    });

    page(timelineResponse(makeCatalog([sameDay]), 'Family Photos', NOW));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Added today');
    expect(document.querySelector('.recent__subtitle')).toBeNull();
  });

  /**
   * A fixed part of the site, like the Undated section — not a section that
   * exists only if populated. With a floor of 50 this happens only when the
   * library itself is empty.
   */
  it('renders the empty state rather than a 404 when there is nothing', () => {
    page(timelineResponse(makeCatalog([]), 'Family Photos', NOW));
    expect(screen.getByText('No photos here yet.')).toBeInTheDocument();
    expect(screen.queryByText('Not found')).toBeNull();
  });
});

/**
 * A cousin's month-old link to a photograph whose sitting has aged out of the
 * set. The photograph exists, so it opens; it is simply not in the list the
 * arrows step through, so both are disabled and closing goes to the top of
 * `/recent`. Nothing redirects and nothing 404s — a URL that stops working
 * because time passed is what these routes are shaped to avoid.
 */
describe('a photograph that has aged out of the recent set', () => {
  const photo = toPublicPhoto(makePhoto({ id: 'd'.repeat(32) }));

  function openIt(onClose = () => {}) {
    return render(
      <Lightbox
        photo={photo}
        // The recent set, which no longer holds this photograph.
        orderedIds={['e'.repeat(32), 'f'.repeat(32)]}
        backHref={routes.recent()}
        photoHref={routes.recentPhoto}
        onClose={onClose}
      />,
    );
  }

  it('still opens, with both arrows disabled', () => {
    openIt();
    expect(screen.getByLabelText('Previous photo')).toBeDisabled();
    expect(screen.getByLabelText('Next photo')).toBeDisabled();
  });

  it('offers the recent view as the way back', () => {
    openIt();
    const back = screen.getByRole('link', { name: /Lightbox/ });
    expect(back).toHaveAttribute('href', '/test-base/recent');
  });
});
