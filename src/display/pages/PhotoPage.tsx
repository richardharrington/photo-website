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

function crumbsFor(group: GroupRef) {
  if (group.kind === 'undated') {
    return [{ label: __SITE_TITLE__, href: routes.home() }];
  }
  return [
    { label: __SITE_TITLE__, href: routes.home() },
    { label: String(group.year), href: routes.year(group.year) },
    {
      label: formatMonth(group.year, group.month),
      href: routes.month(group.year, group.month),
    },
  ];
}

export function PhotoPage({ id }: { id: string }) {
  const detail = useResource<PhotoResponse>(
    (signal) => displayApi.photo(id, signal),
    [id],
    // Previous/next must not unmount the dialog on every step; see
    // ResourceOptions.keepPreviousData.
    { keepPreviousData: true },
  );

  const group = detail.status === 'ready' ? detail.data.group : null;

  /**
   * The photo's own group: the grid behind the lightbox, and the source of
   * previous/next.
   *
   * Deriving neighbours from the *detail* response was wrong. During a
   * navigation the retained detail still describes the previous photo, so a
   * second arrow press computed the same "next" and went nowhere — holding an
   * arrow key advanced one photo instead of several. The ordered group and the
   * route's own ID always agree, whatever request is in flight.
   */
  const groupResource = useResource<GroupResponse | null>(
    (signal) => {
      if (!group) return Promise.resolve(null);
      return group.kind === 'undated'
        ? displayApi.undated(signal)
        : displayApi.day(group.year, group.month, group.day, signal);
    },
    [group ? groupHref(group) : null],
    { keepPreviousData: true },
  );

  if (detail.status === 'loading') {
    return (
      <Layout>
        <Loading />
      </Layout>
    );
  }
  if (detail.status === 'not-found') {
    // Unknown, trashed, and permanently deleted all land here identically.
    return (
      <Layout>
        <NotFound />
      </Layout>
    );
  }
  if (detail.status === 'error') {
    return (
      <Layout>
        <ErrorState message={detail.message} />
      </Layout>
    );
  }

  const photos =
    groupResource.status === 'ready' ? (groupResource.data?.photos ?? []) : [];

  // Position computed from the route's ID, so it is right even while a detail
  // request for that ID is still in flight.
  const index = photos.findIndex((photo) => photo.id === id);
  const known = index !== -1;

  const shown = known ? photos[index]! : detail.data.photo;

  // The whole group in display order. Until the group has loaded, the detail
  // response's own neighbours stand in as a three-entry list, so the lightbox
  // has one uniform way to step regardless of what is still in flight.
  const orderedIds = known
    ? photos.map((photo) => photo.id)
    : [detail.data.previousId, id, detail.data.nextId].filter(
        (value): value is string => value !== null,
      );

  return (
    <>
      <Layout
        crumbs={crumbsFor(detail.data.group)}
        title={groupLabel(detail.data.group)}
      >
        {photos.length > 0 ? <PhotoGrid photos={photos} /> : null}
      </Layout>

      <Lightbox
        photo={shown}
        index={known ? index : detail.data.index}
        total={known ? photos.length : detail.data.total}
        orderedIds={orderedIds}
        groupHref={groupHref(detail.data.group)}
        groupLabel={groupLabel(detail.data.group)}
      />
    </>
  );
}
