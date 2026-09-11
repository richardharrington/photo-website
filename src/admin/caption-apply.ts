/**
 * The rules behind the selection bar's caption box, with no React and no DOM.
 *
 * Everything the box decides — what its slot shows, which photos a caption
 * would change, which of those would lose a caption, and what Undo sends back
 * — is decided here, so each rule is tested in one place. See
 * docs/specs/bulk-captions.md and decisions.md #89.
 */

import { normalizeCaption } from '../shared/validation.ts';
import type { CaptionChange } from '../shared/validation.ts';
import type { PublicPhoto } from '../shared/display-api.ts';

/** What stands in the space after the caption box. */
export type CaptionSlot = 'blank' | 'apply' | 'applying' | 'applied';

/**
 * The slot, evaluated in this order.
 *
 * `Applied` is a confirmation of something the administrator did, not a
 * description of the photos, so it needs both halves: a flag saying this bar
 * has applied something, and a live comparison saying every selected photo
 * still carries it. The flag alone would go stale after Undo, a photo-view
 * edit, or a refetch; the comparison alone would claim an apply nobody made.
 */
export function captionSlot(input: {
  text: string;
  inFlight: boolean;
  appliedOnce: boolean;
  /** Stored captions of the selected photos. */
  selectedCaptions: readonly (string | null)[];
}): CaptionSlot {
  if (input.inFlight) return 'applying';
  const caption = normalizeCaption(input.text);
  if (caption === null) return 'blank';
  if (
    input.appliedOnce &&
    input.selectedCaptions.every((stored) => stored === caption)
  ) {
    return 'applied';
  }
  return 'apply';
}

export interface CaptionPlan {
  /** Normalised; null means there is nothing to apply. */
  caption: string | null;
  /** How many photos were selected, including those already carrying it. */
  selected: number;
  /** One per selected photo whose caption differs, in the order given. */
  changes: (CaptionChange & { caption: string })[];
  /** The subset of `changes` with a non-null `expected`: the dialog's rows. */
  replaced: { photo: PublicPhoto; expected: string }[];
}

/**
 * What applying `text` to these photos would do.
 *
 * `selected` must already be in on-screen order, because `replaced` is shown
 * as a list and the order it is shown in has to be the order on the page.
 * Comparison is exact after normalisation, so `beach` replaces `Beach`.
 */
export function planCaption(
  selected: readonly PublicPhoto[],
  text: string,
): CaptionPlan {
  const caption = normalizeCaption(text);
  const plan: CaptionPlan = {
    caption,
    selected: selected.length,
    changes: [],
    replaced: [],
  };
  if (caption === null) return plan;

  for (const photo of selected) {
    if (photo.caption === caption) continue;
    plan.changes.push({ photoId: photo.id, caption, expected: photo.caption });
    if (photo.caption !== null) plan.replaced.push({ photo, expected: photo.caption });
  }
  return plan;
}

/**
 * The request that puts back what an apply changed.
 *
 * Only the photos the server reports as updated are reversed — a photo that
 * was skipped or already matched lost nothing. Each carries the caption it
 * had as the caption to store, and the caption just applied as the one to
 * expect, so a photo whose caption has changed again since is left alone.
 */
export function reverseCaptionChanges(
  changes: readonly (CaptionChange & { caption: string })[],
  updatedIds: readonly string[],
): { photoId: string; caption: string | null; expected: string }[] {
  const updated = new Set(updatedIds);
  return changes
    .filter((change) => updated.has(change.photoId))
    .map((change) => ({
      photoId: change.photoId,
      caption: change.expected,
      expected: change.caption,
    }));
}
