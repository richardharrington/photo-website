/**
 * The photo grids: a single day, and the Undated group.
 */

import { useResource } from '../../shared/ui/useResource.ts';
import { formatCaptureDate, formatMonth } from '../../shared/datetime.ts';
import { displayApi, routes } from '../api.ts';
import { Layout } from '../components/Layout.tsx';
import type { Crumb } from '../components/Layout.tsx';
import { Empty, ErrorState, Loading, NotFound } from '../components/States.tsx';
import { PhotoGrid } from '../components/PhotoGrid.tsx';
import type { GroupResponse } from '../../shared/display-api.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

interface GroupViewProps {
  resource: ReturnType<typeof useResource<GroupResponse>>;
  title: string;
  crumbs: readonly Crumb[];
  emptyMessage?: string;
}

function GroupView({ resource, title, crumbs, emptyMessage }: GroupViewProps) {
  switch (resource.status) {
    case 'loading':
      return (
        <Layout crumbs={crumbs} title={title}>
          <Loading />
        </Layout>
      );
    case 'not-found':
      return (
        <Layout>
          <NotFound />
        </Layout>
      );
    case 'error':
      return (
        <Layout crumbs={crumbs} title={title}>
          <ErrorState message={resource.message} />
        </Layout>
      );
    case 'ready':
      return (
        <Layout crumbs={crumbs} title={title}>
          {resource.data.photos.length === 0 ? (
            <Empty>{emptyMessage}</Empty>
          ) : (
            <PhotoGrid photos={resource.data.photos} />
          )}
        </Layout>
      );
  }
}

export function DayPage({
  year,
  month,
  day,
}: {
  year: number;
  month: number;
  day: number;
}) {
  const resource = useResource<GroupResponse>(
    (signal) => displayApi.day(year, month, day, signal),
    [year, month, day],
  );

  return (
    <GroupView
      resource={resource}
      title={formatCaptureDate(`${year}-${pad2(month)}-${pad2(day)}`)}
      crumbs={[
        { label: __SITE_TITLE__, href: routes.home() },
        { label: String(year), href: routes.year(year) },
        { label: formatMonth(year, month), href: routes.month(year, month) },
      ]}
    />
  );
}

export function UndatedPage() {
  const resource = useResource<GroupResponse>(
    (signal) => displayApi.undated(signal),
    [],
  );

  return (
    <GroupView
      resource={resource}
      title="Undated"
      crumbs={[{ label: __SITE_TITLE__, href: routes.home() }]}
      emptyMessage="No undated photos."
    />
  );
}
