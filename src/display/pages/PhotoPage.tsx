/**
 * A single photo, opened as a lightbox over the timeline.
 *
 * The route is keyed by photo ID and carries no date, so a link stays valid
 * after a capture date is corrected. Landing here directly works exactly like
 * arriving from the timeline: the detail response names the photo and its
 * group immediately, and the timeline fills in the rest.
 */

import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { navigate } from '../../shared/ui/navigation.ts';
import { useResource } from '../../shared/ui/useResource.ts';
import type { Resource } from '../../shared/ui/useResource.ts';
import { displayApi, routes } from '../api.ts';
import { Layout } from '../components/Layout.tsx';
import { ErrorState, Loading, NotFound } from '../components/States.tsx';
import { Lightbox } from '../components/Lightbox.tsx';
import { requestScrollTo } from '../scroll.ts';
import { tileAnchor } from '../components/PhotoGrid.tsx';
import type {
  GroupRef,
  PhotoResponse,
  PublicPhoto,
  TimelineResponse,
} from '../../shared/display-api.ts';

function groupHref(group: GroupRef): string {
  return group.kind === 'undated'
    ? routes.undated()
    : routes.day(group.year, group.month, group.day);
}

interface TimelineIndex {
  /** Every photo ID in display order: days newest first, then undated. */
  orderedIds: string[];
  photos: Map<string, PublicPhoto>;
  groups: Map<string, GroupRef>;
}

function indexTimeline(data: TimelineResponse): TimelineIndex {
  const orderedIds: string[] = [];
  const photos = new Map<string, PublicPhoto>();
  const groups = new Map<string, GroupRef>();

  for (const year of data.years) {
    for (const month of year.months) {
      for (const day of month.days) {
        for (const photo of day.photos) {
          orderedIds.push(photo.id);
          photos.set(photo.id, photo);
          groups.set(photo.id, {
            kind: 'day',
            year: year.year,
            month: month.month,
            day: day.day,
          });
        }
      }
    }
  }

  for (const photo of data.undated.photos) {
    orderedIds.push(photo.id);
    photos.set(photo.id, photo);
    groups.set(photo.id, { kind: 'undated' });
  }

  return { orderedIds, photos, groups };
}

interface PhotoPageProps {
  id: string;
  /** Shared with the timeline rendered beneath, so this costs no extra request. */
  timeline: Resource<TimelineResponse>;
}

export function PhotoPage({ id, timeline }: PhotoPageProps) {
  const detail = useResource<PhotoResponse>(
    (signal) => displayApi.photo(id, signal),
    [id],
    // Previous/next must not unmount the dialog on every step; see
    // ResourceOptions.keepPreviousData.
    { keepPreviousData: true },
  );

  const data = timeline.status === 'ready' ? timeline.data : null;
  const index = useMemo(() => (data ? indexTimeline(data) : null), [data]);

  const detailData = detail.status === 'ready' ? detail.data : null;

  /**
   * The whole library in display order — arrows cross day, month, and year
   * boundaries and stop only at the two ends of the collection.
   *
   * Neighbours are never taken from the *detail* response while the timeline
   * is available. During a navigation the retained detail still describes the
   * previous photo, so a second arrow press would compute the same "next" and
   * go nowhere: holding an arrow key would advance one photo instead of
   * several. The ordered list and the route's own ID always agree, whatever
   * request is in flight.
   */
  const orderedIds = useMemo(() => {
    if (index) return index.orderedIds;
    if (!detailData) return [id];
    return [detailData.previousId, id, detailData.nextId].filter(
      (value): value is string => value !== null,
    );
  }, [index, detailData, id]);

  const shown = index?.photos.get(id) ?? detailData?.photo ?? null;
  const group = index?.groups.get(id) ?? detailData?.group ?? null;

  const backHref = group ? groupHref(group) : routes.home();

  /**
   * Closing returns to the photo's own day *and* to the photo's own tile.
   * After arrowing deep into a long day, landing on the day's heading would
   * mean finding the photo again by eye.
   */
  const close = useCallback(() => {
    requestScrollTo(tileAnchor(id));
    navigate(backHref);
  }, [id, backHref]);

  if (!shown || !group) {
    if (detail.status === 'not-found') {
      // Unknown, trashed, and permanently deleted all land here identically.
      return (
        <Overlay>
          <NotFound />
        </Overlay>
      );
    }
    if (detail.status === 'error') {
      return (
        <Overlay>
          <ErrorState message={detail.message} />
        </Overlay>
      );
    }
    return (
      <Overlay>
        <Loading />
      </Overlay>
    );
  }

  return (
    <Lightbox
      photo={shown}
      orderedIds={orderedIds}
      // Derived from the photo currently shown, so it follows the arrows
      // across a day boundary.
      backHref={backHref}
      onClose={close}
    />
  );
}

/**
 * The lightbox's own states cover the timeline completely, the way the photo
 * itself does. A 404 for a photo must not show the whole library behind it.
 */
function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="photo-overlay">
      <Layout>{children}</Layout>
    </div>
  );
}
