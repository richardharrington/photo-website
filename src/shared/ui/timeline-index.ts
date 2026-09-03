/**
 * The library flattened into display order, with lookups.
 *
 * One index answers every question either app asks of the whole timeline: the
 * photo view's previous and next, and the admin's shift-range, which measures
 * across day, month, and year boundaries. Both derive from the same list, so a
 * range can never disagree with the order the arrows step in.
 */

import type { GroupRef, PublicPhoto, TimelineResponse } from '../display-api.ts';

export interface TimelineIndex {
  /** Every photo ID in display order: days newest first, then undated. */
  orderedIds: string[];
  photos: Map<string, PublicPhoto>;
  groups: Map<string, GroupRef>;
}

export function indexTimeline(data: TimelineResponse): TimelineIndex {
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

  // Undated photos come last, as they do in navigation.
  for (const photo of data.undated.photos) {
    orderedIds.push(photo.id);
    photos.set(photo.id, photo);
    groups.set(photo.id, { kind: 'undated' });
  }

  return { orderedIds, photos, groups };
}
