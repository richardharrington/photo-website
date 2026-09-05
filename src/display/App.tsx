import { useLocationPath } from '../shared/ui/navigation.ts';
import { useResource } from '../shared/ui/useResource.ts';
import { readApi, routes } from '../shared/ui/api.ts';
import { parseRoute } from '../shared/ui/routes.ts';
import type { Route } from '../shared/ui/routes.ts';
import { Layout } from '../shared/ui/Layout.tsx';
import { NotFound } from '../shared/ui/States.tsx';
import { TimelinePage } from '../shared/ui/TimelinePage.tsx';
import type { TimelineTarget } from '../shared/ui/TimelinePage.tsx';
import { RecentPage } from '../shared/ui/RecentPage.tsx';
import { PhotoPage } from '../shared/ui/PhotoPage.tsx';
import { ViewToggle } from '../shared/ui/ViewToggle.tsx';
import { recentOrderedIds } from '../shared/ui/timeline-index.ts';
import { useUnseenRecent } from '../shared/ui/unseen.ts';
import type { TimelineResponse } from '../shared/display-api.ts';

/** Which section of the one page a route is asking for. */
function targetOf(
  // `page` is never produced here: the viewer passes no extra pages to the
  // parser, so `/trash` under the display base is its own 404.
  route: Exclude<
    Route,
    { kind: 'not-found' | 'photo' | 'page' | 'recent' | 'recent-photo' }
  >,
): TimelineTarget {
  switch (route.kind) {
    case 'home':
      return { kind: 'top' };
    case 'year':
      return { kind: 'year', year: route.year };
    case 'month':
      return { kind: 'month', year: route.year, month: route.month };
    case 'day':
      return { kind: 'day', year: route.year, month: route.month, day: route.day };
    case 'undated':
      return { kind: 'undated' };
  }
}

export function App() {
  const path = useLocationPath();
  const route = parseRoute(path, __APP_BASE__);

  // A malformed URL never reaches the timeline, so it costs no request.
  if (route.kind === 'not-found' || route.kind === 'page') {
    return (
      <Layout>
        <NotFound />
      </Layout>
    );
  }

  return <Viewer route={route} />;
}

/**
 * The viewer is one page with one request behind it.
 *
 * Two listings now read that one response: the library by capture date, and
 * the Recently Uploaded view by arrival. Only ever one of them is in the DOM —
 * a tile's element id is document-unique, and both scroll paths depend on it
 * resolving to exactly one element.
 *
 * Whichever listing is showing stays mounted underneath the photo view rather
 * than being torn down and rebuilt around it: closing the lightbox is then a
 * reveal, not a re-render, and the page is exactly where it was left. Both
 * children read the same resource, so opening a photo asks the server for
 * nothing but that photo's own detail.
 *
 * No `CurationContext` provider, so every shared component sees `null` and
 * renders the viewer's plain reading interface.
 */
function Viewer({ route }: { route: Exclude<Route, { kind: 'not-found' | 'page' }> }) {
  const timeline = useResource<TimelineResponse>(
    (signal) => readApi.timeline(signal),
    [],
  );

  const data = timeline.status === 'ready' ? timeline.data : null;
  const onRecent = route.kind === 'recent' || route.kind === 'recent-photo';
  const unseen = useUnseenRecent(data?.recent[0]?.uploadedAt ?? null, onRecent);
  const nav = <ViewToggle current={onRecent ? 'recent' : 'library'} unseen={unseen} />;

  if (onRecent) {
    return (
      <>
        <RecentPage
          resource={timeline}
          target={route.kind === 'recent-photo' ? null : 'top'}
          nav={nav}
        />
        {route.kind === 'recent-photo' ? (
          <PhotoPage
            id={route.id}
            timeline={timeline}
            // The arrows traverse the recent set in its own order, and both
            // are disabled for a photograph whose sitting has aged out of it.
            orderedIds={data ? recentOrderedIds(data) : []}
            backHref={routes.recent()}
            photoHref={routes.recentPhoto}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <TimelinePage
        resource={timeline}
        // A photo route must not move the page underneath the lightbox.
        target={route.kind === 'photo' ? null : targetOf(route)}
        nav={nav}
      />
      {route.kind === 'photo' ? <PhotoPage id={route.id} timeline={timeline} /> : null}
    </>
  );
}
