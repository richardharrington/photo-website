import { useLocationPath, useScrollToTopOnChange } from '../shared/ui/navigation.ts';
import { parseRoute } from './routes.ts';
import { Layout } from './components/Layout.tsx';
import { NotFound } from './components/States.tsx';
import { DaysPage, MonthsPage, YearsPage } from './pages/HierarchyPages.tsx';
import { DayPage, UndatedPage } from './pages/GroupPage.tsx';
import { PhotoPage } from './pages/PhotoPage.tsx';

export function App() {
  const path = useLocationPath();
  const route = parseRoute(path, __APP_BASE__);

  // Opening or closing the lightbox should leave the grid where it was, so a
  // photo route deliberately does not reset the scroll position.
  useScrollToTopOnChange(route.kind === 'photo' ? 'photo' : path);

  switch (route.kind) {
    case 'home':
      return <YearsPage />;
    case 'year':
      return <MonthsPage year={route.year} />;
    case 'month':
      // A month page lists the days within that month.
      return <DaysPage year={route.year} month={route.month} />;
    case 'day':
      return <DayPage year={route.year} month={route.month} day={route.day} />;
    case 'undated':
      return <UndatedPage />;
    case 'photo':
      return <PhotoPage id={route.id} />;
    case 'not-found':
      return (
        <Layout>
          <NotFound />
        </Layout>
      );
  }
}
