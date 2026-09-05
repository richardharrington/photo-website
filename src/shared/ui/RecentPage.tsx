/**
 * The library by when it arrived: one section per upload sitting, newest
 * first.
 *
 * The site's whole navigation structure is capture date, which is right for
 * finding a photograph and useless for noticing one — a box of scanned 1978
 * prints is new, and on the timeline it sits at the bottom of the page under a
 * 1978 heading. This page exists to say what has turned up lately, and it is
 * the only place on the site ordered by anything but the camera.
 *
 * It renders instead of the timeline, never beside it: `tileAnchor` is a
 * document-unique element id, and both the anchor scroll and the
 * close-the-photo-view scroll depend on it resolving to exactly one element.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Resource } from './useResource.ts';
import { routes } from './api.ts';
import { Layout } from './Layout.tsx';
import { Empty, ErrorState, Loading } from './States.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { SelectAll } from './SelectAll.tsx';
import { scrollToElementId, takeScrollRequest } from './scroll.ts';
import { indexTimeline } from './timeline-index.ts';
import { formatAddedAt, recentSubtitle } from './recent-labels.ts';
import type { PublicPhoto, TimelineResponse } from '../display-api.ts';

function photoCount(count: number): string {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`;
}

interface RecentPageProps {
  resource: Resource<TimelineResponse>;
  /**
   * `'top'` on a fresh navigation to `/recent`; `null` on a photo route,
   * where the lightbox is open over this page and moving it underneath would
   * lose the reader's place.
   */
  target: 'top' | null;
  /** The header's nav slot; see Layout. Both apps pass the view toggle. */
  nav?: ReactNode;
  /** Above the listing, in every state. The admin's upload target lives here. */
  above?: ReactNode;
  /**
   * The moment "Added today" is judged against, passed in rather than read
   * here so a test can fix the clock. Defaults to now.
   */
  nowMs?: number;
  /** An explicit IANA zone, for the same reason. Defaults to the reader's own. */
  timeZone?: string;
}

export function RecentPage({
  resource,
  target,
  nav,
  above,
  nowMs,
  timeZone,
}: RecentPageProps) {
  const data = resource.status === 'ready' ? resource.data : null;

  /*
   * The clock, read once when the page mounts rather than on every render.
   *
   * "Added today" has to mean the same thing all the way down a page, and a
   * reading taken during render would move under a re-render. Staleness is
   * the accepted cost: a page left open overnight says "Added today" about
   * yesterday until it is reloaded.
   */
  const [mountedAt] = useState(() => Date.now());

  // The groups carry ids only, so the photographs come from the same map the
  // timeline builds. One copy of each photo in the response, and therefore no
  // two copies to disagree.
  const photos = useMemo(() => (data ? indexTimeline(data).photos : null), [data]);

  /**
   * The same one-shot scroll the timeline has, and for the same reason:
   * without it, closing the photo view could not return to the tile it was
   * opened from. A fresh navigation to `/recent` goes to the top.
   */
  const settled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!data) return;

    const requested = takeScrollRequest();
    if (requested && scrollToElementId(requested)) {
      settled.current = target;
      return;
    }

    if (target === null || settled.current === target) return;
    settled.current = target;
    window.scrollTo(0, 0);
  }, [data, target]);

  if (resource.status === 'loading') {
    return (
      <Layout isHome nav={nav}>
        {above}
        <Loading />
      </Layout>
    );
  }
  if (resource.status === 'error') {
    return (
      <Layout nav={nav}>
        <ErrorState message={resource.message} />
      </Layout>
    );
  }
  if (resource.status === 'not-found') {
    return (
      <Layout nav={nav}>
        <ErrorState message="The library could not be loaded." />
      </Layout>
    );
  }

  const groups = resource.data.recent;
  const now = nowMs ?? mountedAt;

  return (
    <Layout isHome nav={nav}>
      {above}
      {/* Never a 404: this is a fixed part of the site, like the Undated
          section, so an empty one says so rather than disappearing. A family
          member who followed the toggle deserves an answer, and "nothing
          lately" is an answer. The copy says "the last month" where the
          constant says 30 days, deliberately: the rule has to be exact, and
          this is how the sentence is heard. */}
      {groups.length === 0 ? (
        <Empty>No photos uploaded in the last month.</Empty>
      ) : (
        <div className="recent">
          {groups.map((group) => {
            const subtitle = recentSubtitle(group, timeZone);
            const shown = group.photoIds
              .map((id) => photos?.get(id))
              .filter((photo): photo is PublicPhoto => photo !== undefined);

            return (
              <section
                key={group.uploadedAt}
                className={
                  subtitle ? 'recent__group recent__group--titled' : 'recent__group'
                }
              >
                {/* A count here, unlike a day heading in the library: a day's
                    photographs are all on screen beneath it, and one sitting
                    can be an 800-photo import. */}
                <h2 className="recent__heading">
                  <span>{formatAddedAt(group.uploadedAt, now, timeZone)}</span>
                  <span className="timeline__count">{photoCount(group.count)}</span>
                  {/* Nothing at all in the viewer. */}
                  <SelectAll ids={group.photoIds} />
                </h2>

                {subtitle ? <p className="recent__subtitle">{subtitle}</p> : null}

                {/* Tiles link into `/recent`, or the first click would drop the
                    reader out of the view they are reading. */}
                <PhotoGrid photos={shown} photoHref={routes.recentPhoto} />
              </section>
            );
          })}
        </div>
      )}
    </Layout>
  );
}
