import { useLocationPath } from '../shared/ui/navigation.ts';
import { useResource } from '../shared/ui/useResource.ts';
import { displayApi } from './api.ts';
import { parseRoute } from './routes.ts';
import type { Route } from './routes.ts';
import { Layout } from './components/Layout.tsx';
import { NotFound } from './components/States.tsx';
import { TimelinePage } from './pages/TimelinePage.tsx';
import type { TimelineTarget } from './pages/TimelinePage.tsx';
import { PhotoPage } from './pages/PhotoPage.tsx';
import type { TimelineResponse } from '../shared/display-api.ts';

/** Which section of the one page a route is asking for. */
function targetOf(
  route: Exclude<Route, { kind: 'not-found' | 'photo' }>,
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
  if (route.kind === 'not-found') {
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
 */
function Viewer({ route }: { route: Exclude<Route, { kind: 'not-found' }> }) {
  const timeline = useResource<TimelineResponse>(
    (signal) => displayApi.timeline(signal),
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
