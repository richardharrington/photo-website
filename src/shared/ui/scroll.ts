/**
 * Where the timeline should be when the next route renders.
 *
 * Two mechanisms, and they are deliberately different. A route *implies* an
 * anchor — `/2026/03/01` means the March 1st section — and that is recomputed
 * whenever the route changes, including on back and forward. Closing the photo
 * view instead names one exact element, the tile of the photo just being
 * looked at, which no route can express: after arrowing deep into a long day,
 * landing on the day's heading would mean finding the photo again by eye.
 *
 * The one-shot request is module state rather than a `location.hash`, because
 * a hash is part of the URL people copy and share, and this is a transient
 * detail of one navigation.
 */

let pending: string | null = null;

/** Ask the timeline to bring this element ID into view once, on its next render. */
export function requestScrollTo(elementId: string): void {
  pending = elementId;
}

/** Read and clear the request; returns `null` when there is none. */
export function takeScrollRequest(): string | null {
  const requested = pending;
  pending = null;
  return requested;
}

/**
 * Bring an element into view, reporting whether it was there to scroll to.
 *
 * The offset for whatever is pinned above it comes from the element's own
 * `scroll-margin-top`, so the CSS that decides how tall those bands are is
 * still the only place that number is written down.
 *
 * The position is computed and scrolled to rather than handed to
 * `scrollIntoView`, which is what this was. WebKit gets that wrong for an
 * element inside a multi-column container taller than the viewport: it scrolls
 * to the bottom of the page instead, apparently measuring in the flow rather
 * than in the fragment the element is actually painted in. The library never
 * hit it because a day's grid is short; one upload sitting can be an
 * 800-photo import, so the Recently Uploaded view hits it on its first tile.
 * `getBoundingClientRect` is correct in every engine.
 */
export function scrollToElementId(elementId: string): boolean {
  const element = document.getElementById(elementId);
  if (!element) return false;
  const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop);
  const offset = Number.isFinite(margin) ? margin : 0;
  const top = element.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo(0, Math.max(0, top));
  return true;
}
