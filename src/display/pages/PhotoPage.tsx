/**
 * A single photo, opened as a lightbox over its own group.
 *
 * The route is keyed by photo ID and carries no date, so a link stays valid
 * after a capture date is corrected. Landing here directly works exactly like
 * arriving from the grid: the detail response names the group, and the grid
 * renders behind the lightbox either way.
 */

import { useResource } from '../../shared/ui/useResource.ts';
import { formatCaptureDate, formatMonth } from '../../shared/datetime.ts';
import { displayApi, routes } from '../api.ts';
import { Layout } from '../components/Layout.tsx';
import { ErrorState, Loading, NotFound } from '../components/States.tsx';
import { PhotoGrid } from '../components/PhotoGrid.tsx';
import { Lightbox } from '../components/Lightbox.tsx';
import type {
  GroupRef,
  GroupResponse,
  PhotoResponse,
} from '../../shared/display-api.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function groupHref(group: GroupRef): string {
  return group.kind === 'undated'
    ? routes.undated()
    : routes.day(group.year, group.month, group.day);
}

function groupLabel(group: GroupRef): string {
  return group.kind === 'undated'
    ? 'Undated'
    : formatCaptureDate(`${group.year}-${pad2(group.month)}-${pad2(group.day)}`);
}

/** The grid behind the lightbox, so closing lands on a populated page. */
function GroupBackdrop({ group }: { group: GroupRef }) {
  const resource = useResource<GroupResponse>(
    (signal) =>
      group.kind === 'undated'
        ? displayApi.undated(signal)
        : displayApi.day(group.year, group.month, group.day, signal),
    [group.kind, groupHref(group)],
  );

  const crumbs =
    group.kind === 'undated'
      ? [{ label: __SITE_TITLE__, href: routes.home() }]
      : [
          { label: __SITE_TITLE__, href: routes.home() },
          { label: String(group.year), href: routes.year(group.year) },
          {
            label: formatMonth(group.year, group.month),
            href: routes.month(group.year, group.month),
          },
        ];

  return (
    <Layout crumbs={crumbs} title={groupLabel(group)}>
      {resource.status === 'ready' ? <PhotoGrid photos={resource.data.photos} /> : null}
    </Layout>
  );
}

export function PhotoPage({ id }: { id: string }) {
  const detail = useResource<PhotoResponse>(
    (signal) => displayApi.photo(id, signal),
    [id],
    // Previous/next must not unmount the dialog on every step; see
    // ResourceOptions.keepPreviousData.
    { keepPreviousData: true },
  );

  switch (detail.status) {
    case 'loading':
      return (
        <Layout>
          <Loading />
        </Layout>
      );
    case 'not-found':
      // Unknown, trashed, and permanently deleted all land here identically.
      return (
        <Layout>
          <NotFound />
        </Layout>
      );
    case 'error':
      return (
        <Layout>
          <ErrorState message={detail.message} />
        </Layout>
      );
    case 'ready':
      return (
        <>
          <GroupBackdrop group={detail.data.group} />
          <Lightbox
            detail={detail.data}
            groupHref={groupHref(detail.data.group)}
            groupLabel={groupLabel(detail.data.group)}
          />
        </>
      );
  }
}
