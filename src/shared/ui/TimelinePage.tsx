/**
 * The whole library as one scrolling page: years, months within them, days
 * within those, and every day's photo grid.
 *
 * There is no navigation between levels because there are no levels to move
 * between — reaching a photo is a scroll, not four clicks. The old index pages
 * survive only as URLs: `/2026/03/01` still means something, and now means
 * "this page, scrolled there".
 *
 * Every image in the library is in the DOM. That is deliberate at this site's
 * scale (design.md: a few hundred photos a year); `loading="lazy"` keeps the
 * network cost proportional to what is actually scrolled past, and
 * virtualization would trade exact anchors and exact back-navigation for a
 * problem this library does not have.
 */

import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Resource } from './useResource.ts';
import { monthName } from '../datetime.ts';
import { Link } from './Link.tsx';
import { routes } from './api.ts';
import { Layout } from './Layout.tsx';
import { Empty, ErrorState, Loading, NotFound } from './States.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { scrollToElementId, takeScrollRequest } from './scroll.ts';
import type { TimelineMonth, TimelineResponse, TimelineYear } from '../display-api.ts';

/** The section a route asks the page to be scrolled to. */
export type TimelineTarget =
  | { kind: 'top' }
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'day'; year: number; month: number; day: number }
  | { kind: 'undated' };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function yearAnchor(year: number): string {
  return `y-${year}`;
}
export function monthAnchor(year: number, month: number): string {
  return `m-${year}-${pad2(month)}`;
}
export function dayAnchor(year: number, month: number, day: number): string {
  return `d-${year}-${pad2(month)}-${pad2(day)}`;
}
export const UNDATED_ANCHOR = 'undated';

/** The element a target names, or `null` for the top of the page. */
function anchorFor(target: TimelineTarget): string | null {
  switch (target.kind) {
    case 'top':
      return null;
    case 'year':
      return yearAnchor(target.year);
    case 'month':
      return monthAnchor(target.year, target.month);
    case 'day':
      return dayAnchor(target.year, target.month, target.day);
    case 'undated':
      return UNDATED_ANCHOR;
  }
}

/** A stable identity for a target, so the scroll effect fires once per route. */
function targetKey(target: TimelineTarget): string {
  return anchorFor(target) ?? 'top';
}

function photoCount(count: number): string {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`;
}

/**
 * Does the library contain the section this route names?
 *
 * A well-formed route for a section with no photos is a 404, not an empty
 * group — the same rule the old index pages followed, and the reason a
 * mistyped date never looks like a day whose photos were deleted.
 */
function sectionExists(data: TimelineResponse, target: TimelineTarget): boolean {
  const year = (y: number): TimelineYear | undefined =>
    data.years.find((entry) => entry.year === y);
  const month = (y: number, m: number): TimelineMonth | undefined =>
    year(y)?.months.find((entry) => entry.month === m);

  switch (target.kind) {
    case 'top':
      return true;
    case 'undated':
      // A fixed part of the page, valid even when it holds nothing — unlike a
      // day, which exists only if it has photos.
      return true;
    case 'year':
      return year(target.year) !== undefined;
    case 'month':
      return month(target.year, target.month) !== undefined;
    case 'day':
      return (
        month(target.year, target.month)?.days.some(
          (entry) => entry.day === target.day,
        ) ?? false
      );
  }
}

interface TimelinePageProps {
  resource: Resource<TimelineResponse>;
  /**
   * Where this route wants the page. `null` on a photo route: the lightbox is
   * open over the timeline and moving it underneath would lose the reader's
   * place.
   */
  target: TimelineTarget | null;
  /** The header's nav slot; see Layout. The viewer passes nothing. */
  nav?: ReactNode;
  /**
   * Rendered inside the layout above the timeline, in every state including
   * the empty library. The admin's upload target lives here; the viewer
   * passes nothing.
   */
  above?: ReactNode;
}

export function TimelinePage({ resource, target, nav, above }: TimelinePageProps) {
  const data = resource.status === 'ready' ? resource.data : null;

  /**
   * Scroll to whatever the current navigation asks for, once it can be exact.
   *
   * All the metadata arrives in one response and carries every rendition's
   * dimensions, so by the time this runs the page's height is final and will
   * not move as images load. That is the whole reason anchors can be a plain
   * `scrollIntoView` with no measuring, retrying, or observing.
   */
  const settled = useRef<string | null>(null);
  const key = target ? targetKey(target) : null;
  useLayoutEffect(() => {
    if (!data) return;

    // A one-shot request (closing the photo view) names an exact tile and wins
    // over the route's own section for that single navigation.
    const requested = takeScrollRequest();
    if (requested && scrollToElementId(requested)) {
      settled.current = key;
      return;
    }

    if (key === null || settled.current === key) return;
    settled.current = key;
    if (key === 'top') window.scrollTo(0, 0);
    else scrollToElementId(key);
  }, [data, key]);

  if (resource.status === 'loading') {
    return (
      <Layout isHome nav={nav}>
        {above}
        <Loading />
      </Layout>
    );
  }
  if (resource.status === 'not-found') {
    return (
      <Layout nav={nav}>
        <NotFound />
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

  if (target && !sectionExists(resource.data, target)) {
    return (
      <Layout nav={nav}>
        <NotFound />
      </Layout>
    );
  }

  const timeline = resource.data;
  // Undated is a section of the page only when it holds something — unless the
  // route asked for it by name, which still deserves an answer rather than a
  // 404 (an empty Undated group is valid, an empty day is not).
  const showUndated = timeline.undated.count > 0 || target?.kind === 'undated';

  if (timeline.total === 0 && !showUndated) {
    return (
      <Layout isHome nav={nav}>
        {above}
        <Empty />
      </Layout>
    );
  }

  return (
    <Layout isHome nav={nav}>
      {above}
      <div className="timeline">
        {timeline.years.map((year) => (
          <section
            key={year.year}
            className="timeline__year"
            id={yearAnchor(year.year)}
          >
            <h2 className="timeline__year-heading">
              <Link to={routes.year(year.year)} replace className="timeline__anchor">
                <span>{year.year}</span>
                <span className="timeline__count">{photoCount(year.count)}</span>
              </Link>
            </h2>

            {year.months.map((month) => (
              <section
                key={month.month}
                className="timeline__month"
                id={monthAnchor(year.year, month.month)}
              >
                <h3 className="timeline__month-heading">
                  <Link
                    to={routes.month(year.year, month.month)}
                    replace
                    className="timeline__anchor"
                  >
                    <span>{monthName(month.month)}</span>
                    <span className="timeline__count">{photoCount(month.count)}</span>
                  </Link>
                </h3>

                {month.days.map((day) => (
                  <section
                    key={day.day}
                    className="timeline__day"
                    id={dayAnchor(year.year, month.month, day.day)}
                  >
                    <h4 className="timeline__day-heading">
                      <Link
                        to={routes.day(year.year, month.month, day.day)}
                        replace
                        className="timeline__anchor"
                      >
                        {/* The year is the enclosing heading; repeating it on
                            every day would be noise. Nor is there a count: a
                            day's photographs are all on screen beneath it, so
                            the number only clutters the smallest heading of
                            the three. Months and years still carry theirs. */}
                        <span>
                          {monthName(month.month)} {day.day}
                        </span>
                      </Link>
                    </h4>
                    <PhotoGrid photos={day.photos} />
                  </section>
                ))}
              </section>
            ))}
          </section>
        ))}

        {showUndated ? (
          <section className="timeline__year" id={UNDATED_ANCHOR}>
            <h2 className="timeline__year-heading">
              <Link to={routes.undated()} replace className="timeline__anchor">
                <span>Undated</span>
                <span className="timeline__count">
                  {photoCount(timeline.undated.count)}
                </span>
              </Link>
            </h2>
            {timeline.undated.count === 0 ? (
              <Empty>No undated photos.</Empty>
            ) : (
              <PhotoGrid photos={timeline.undated.photos} />
            )}
          </section>
        ) : null}
      </div>
    </Layout>
  );
}
