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
import { navigate } from './navigation.ts';
import { useResource } from './useResource.ts';
import type { Resource } from './useResource.ts';
import { readApi, routes } from './api.ts';
import { Layout } from './Layout.tsx';
import { ErrorState, Loading, NotFound } from './States.tsx';
import { Lightbox } from './Lightbox.tsx';
import { requestScrollTo } from './scroll.ts';
import { tileAnchor } from './PhotoGrid.tsx';
import { indexTimeline } from './timeline-index.ts';
import type { GroupRef, PhotoResponse, TimelineResponse } from '../display-api.ts';

function groupHref(group: GroupRef): string {
  return group.kind === 'undated'
    ? routes.undated()
    : routes.day(group.year, group.month, group.day);
}

interface PhotoPageProps {
  id: string;
  /** Shared with the listing rendered beneath, so this costs no extra request. */
  timeline: Resource<TimelineResponse>;
  /**
   * The order the arrows traverse, and where closing goes.
   *
   * Both default to the library's own: the whole timeline in display order,
   * and the photograph's own day. The Recently Uploaded view passes its own
   * order and `/recent`, because it is the listing on screen and the arrows
   * have to follow what the reader can see.
   *
   * A live photograph absent from the list given — a month-old link to
   * `/recent/photo/<id>` whose sitting has aged out — still opens. Both arrows
   * are simply disabled, and closing lands at the top of the listing rather
   * than on a tile that is not there. Nothing redirects and nothing 404s: the
   * photograph exists, and a URL that stops working because time passed is
   * exactly what these routes are shaped to avoid.
   */
  orderedIds?: readonly string[];
  backHref?: string;
  /** The route a stepped-to photograph lives at; defaults to the library's. */
  photoHref?: (id: string) => string;
}

export function PhotoPage({
  id,
  timeline,
  orderedIds: givenOrderedIds,
  backHref: givenBackHref,
  photoHref,
}: PhotoPageProps) {
  const detail = useResource<PhotoResponse>(
    (signal) => readApi.photo(id, signal),
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
    if (givenOrderedIds) return givenOrderedIds;
    if (index) return index.orderedIds;
    if (!detailData) return [id];
    return [detailData.previousId, id, detailData.nextId].filter(
      (value): value is string => value !== null,
    );
  }, [givenOrderedIds, index, detailData, id]);

  const shown = index?.photos.get(id) ?? detailData?.photo ?? null;
  const group = index?.groups.get(id) ?? detailData?.group ?? null;

  const backHref = givenBackHref ?? (group ? groupHref(group) : routes.home());

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
      photoHref={photoHref}
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
