/**
 * The dot on the Recently added toggle.
 *
 * One key in `localStorage` holding the newest `uploadedAt` this browser has
 * rendered on `/recent`. A response whose newest sitting is newer than that —
 * or a browser with no stored value at all, as on a first visit or a new
 * device — raises the marker, and opening `/recent` clears it.
 *
 * This is emphasis only. It never affects which photographs are in the recent
 * set, so it is safe for it to be absent or wrong, which is what lets every
 * read and write be wrapped in `try`/`catch`: a private window throws on the
 * accessor itself, and the honest answer there is no marker rather than a
 * broken page. Nothing about the recency rule becomes per-device.
 *
 * Storage is an external system, so it is read through `useSyncExternalStore`
 * rather than copied into component state and pushed back from an effect. Both
 * apps may show the toggle in more than one place, and this way they cannot
 * disagree about what has been seen.
 */

import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'photo-site:recent-seen';

/** `undefined` until storage has been consulted; `null` when it holds nothing. */
let cached: string | null | undefined;
const listeners = new Set<() => void>();

function currentSeen(): string | null {
  if (cached === undefined) {
    try {
      cached = window.localStorage.getItem(KEY);
    } catch {
      // A private window can throw on the accessor itself. No marker, then.
      cached = null;
    }
  }
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Is `uploadedAt` newer than what this browser has already been shown? */
function isNewer(uploadedAt: string, seen: string | null): boolean {
  if (seen === null) return true;
  const stored = Date.parse(seen);
  return Number.isNaN(stored) || Date.parse(uploadedAt) > stored;
}

/** Record that this browser has now been shown everything up to `uploadedAt`. */
function markSeen(uploadedAt: string): void {
  if (!isNewer(uploadedAt, currentSeen())) return;
  try {
    window.localStorage.setItem(KEY, uploadedAt);
  } catch {
    // Storage is unavailable; the marker simply does not persist.
  }
  cached = uploadedAt;
  for (const listener of listeners) listener();
}

/**
 * Whether to mark the toggle, given the newest sitting the response carries.
 *
 * Opening `/recent` is what clears it, so the caller says whether that is
 * where the reader now is. On the admin's trash page neither view is current
 * and the marker still shows, which is right: it says the library has
 * something new, wherever you happen to be standing.
 */
export function useUnseenRecent(
  newestUploadedAt: string | null,
  onRecent: boolean,
): boolean {
  const seen = useSyncExternalStore(subscribe, currentSeen, () => null);

  useEffect(() => {
    if (onRecent && newestUploadedAt !== null) markSeen(newestUploadedAt);
  }, [onRecent, newestUploadedAt]);

  if (onRecent || newestUploadedAt === null) return false;
  return isNewer(newestUploadedAt, seen);
}
