import { useCuration } from './curation.ts';

/**
 * A group heading's Select all.
 *
 * There is no library-wide Select all: a selection is for deleting, and the
 * one bulk gesture worth a button is "this day". It adds to the selection
 * rather than replacing it, so picking two days is two clicks, and it sets no
 * anchor — a range is measured from a tile someone actually clicked.
 *
 * Absent, never disabled, once the whole group is already selected: a control
 * that can do nothing is not shown at all (decisions.md #36). It renders
 * nothing at all without a curation context, which is how the viewer's
 * headings stay exactly as they were.
 */
export function SelectAll({ ids }: { ids: readonly string[] }) {
  const curation = useCuration();
  if (!curation || ids.length === 0) return null;
  if (ids.every((id) => curation.selectedIds.has(id))) return null;

  return (
    <button
      type="button"
      className="timeline__select-all"
      onClick={() => curation.selectAll(ids)}
    >
      Select all
    </button>
  );
}
