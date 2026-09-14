/**
 * Where the photo view goes after the photo it is showing is deleted.
 *
 * Triage of a bad day is Delete, confirm, Delete, confirm, so a deletion from
 * the photo view moves to the next photograph rather than dropping back to the
 * timeline. At the end of the library there is no next one, so it steps back
 * instead; with nothing left it closes.
 *
 * It works from the order *before* the patch, which is the only place the
 * deleted photo's neighbours are still written down, and skips every ID in the
 * same deletion — the neighbour may have gone with it.
 */
export function nextAfterDeleting(
  orderedIds: readonly string[],
  deleted: readonly string[],
  from: string,
): string | null {
  const gone = new Set(deleted);
  const position = orderedIds.indexOf(from);
  if (position === -1) return null;

  for (let at = position + 1; at < orderedIds.length; at += 1) {
    const id = orderedIds[at]!;
    if (!gone.has(id)) return id;
  }
  for (let at = position - 1; at >= 0; at -= 1) {
    const id = orderedIds[at]!;
    if (!gone.has(id)) return id;
  }
  return null;
}
