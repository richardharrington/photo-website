import { useLocationPath } from '../shared/ui/navigation.ts';
import { useResource } from '../shared/ui/useResource.ts';
import { readApi } from '../shared/ui/api.ts';
import { parseRoute } from '../shared/ui/routes.ts';
import type { Route } from '../shared/ui/routes.ts';
import { Layout } from '../shared/ui/Layout.tsx';
import { NotFound } from '../shared/ui/States.tsx';
import { TimelinePage } from '../shared/ui/TimelinePage.tsx';
import type { TimelineTarget } from '../shared/ui/TimelinePage.tsx';
import { PhotoPage } from '../shared/ui/PhotoPage.tsx';
import type { TimelineResponse } from '../shared/display-api.ts';

/** Which section of the one page a route is asking for. */
function targetOf(
  // `page` is never produced here: the viewer passes no extra pages to the
  // parser, so `/trash` under the display base is its own 404.
  route: Exclude<Route, { kind: 'not-found' | 'photo' | 'page' }>,
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
 * The timeline stays mounted underneath the photo view rather than being torn
 * down and rebuilt around it: closing the lightbox is then a reveal, not a
 * re-render, and the page is exactly where it was left. Both children read the
 * same resource, so opening a photo asks the server for nothing but that
 * photo's own detail.
 *
 * No `CurationContext` provider, so every shared component sees `null` and
 * renders the viewer's plain reading interface.
 */
function Viewer({ route }: { route: Exclude<Route, { kind: 'not-found' | 'page' }> }) {
  const timeline = useResource<TimelineResponse>(
    (signal) => readApi.timeline(signal),
    [],
  );

  return (
    <>
      <TimelinePage
        resource={timeline}
        // A photo route must not move the page underneath the lightbox.
        target={route.kind === 'photo' ? null : targetOf(route)}
      />
      {route.kind === 'photo' ? <PhotoPage id={route.id} timeline={timeline} /> : null}
    </>
  );
}
