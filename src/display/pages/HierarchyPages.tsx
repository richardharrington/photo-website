/**
 * The three index levels: years, months within a year, days within a month.
 *
 * All three read the single hierarchy response, so moving between them costs
 * no further requests.
 */

import type { ReactElement } from 'react';
import { useResource } from '../../shared/ui/useResource.ts';
import { formatCaptureDate, formatMonth, monthName } from '../../shared/datetime.ts';
import { displayApi, routes } from '../api.ts';
import { GroupList, Layout } from '../components/Layout.tsx';
import type { Crumb, GroupEntry } from '../components/Layout.tsx';
import { Empty, ErrorState, Loading, NotFound } from '../components/States.tsx';
import type { HierarchyResponse } from '../../shared/display-api.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Fetches the hierarchy and renders the shared loading, failure, and
 * not-found states, handing the loaded data to its child.
 */
function HierarchyGate({
  children,
}: {
  children: (data: HierarchyResponse) => ReactElement;
}) {
  const hierarchy = useResource<HierarchyResponse>(
    (signal) => displayApi.hierarchy(signal),
    [],
  );

  switch (hierarchy.status) {
    case 'loading':
      return (
        <Layout>
          <Loading />
        </Layout>
      );
    case 'error':
      return (
        <Layout>
          <ErrorState message={hierarchy.message} />
        </Layout>
      );
    case 'not-found':
      return (
        <Layout>
          <NotFound />
        </Layout>
      );
    case 'ready':
      return children(hierarchy.data);
  }
}

function MissingGroup() {
  return (
    <Layout>
      <NotFound />
    </Layout>
  );
}

export function YearsPage() {
  return (
    <HierarchyGate>
      {(data) => {
        const entries: GroupEntry[] = data.years.map((year) => ({
          key: String(year.year),
          href: routes.year(year.year),
          label: String(year.year),
          count: year.count,
        }));

        // Undated is listed alongside the years, at the end, rather than
        // hidden behind a separate navigation concept.
        if (data.undated.count > 0) {
          entries.push({
            key: 'undated',
            href: routes.undated(),
            label: 'Undated',
            count: data.undated.count,
          });
        }

        return (
          <Layout isHome>
            {entries.length === 0 ? <Empty /> : <GroupList entries={entries} />}
          </Layout>
        );
      }}
    </HierarchyGate>
  );
}

export function MonthsPage({ year }: { year: number }) {
  return (
    <HierarchyGate>
      {(data) => {
        const found = data.years.find((entry) => entry.year === year);
        if (!found) return <MissingGroup />;

        const crumbs: Crumb[] = [{ label: data.title, href: routes.home() }];
        const entries: GroupEntry[] = found.months.map((month) => ({
          key: String(month.month),
          href: routes.month(year, month.month),
          label: monthName(month.month),
          count: month.count,
        }));

        return (
          <Layout crumbs={crumbs} title={String(year)}>
            <GroupList entries={entries} />
          </Layout>
        );
      }}
    </HierarchyGate>
  );
}

export function DaysPage({ year, month }: { year: number; month: number }) {
  return (
    <HierarchyGate>
      {(data) => {
        const found = data.years
          .find((entry) => entry.year === year)
          ?.months.find((entry) => entry.month === month);
        if (!found) return <MissingGroup />;

        const crumbs: Crumb[] = [
          { label: data.title, href: routes.home() },
          { label: String(year), href: routes.year(year) },
        ];

        const entries: GroupEntry[] = found.days.map((day) => ({
          key: String(day.day),
          href: routes.day(year, month, day.day),
          label: formatCaptureDate(`${year}-${pad2(month)}-${pad2(day.day)}`),
          count: day.count,
        }));

        return (
          <Layout crumbs={crumbs} title={formatMonth(year, month)}>
            <GroupList entries={entries} />
          </Layout>
        );
      }}
    </HierarchyGate>
  );
}
