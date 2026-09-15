import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { TrashPage } from '../../shared/ui/TrashPage.tsx';
import type { PermanentDelete, TrashSelection } from '../../shared/ui/TrashPage.tsx';
import { adminApi } from '../api.ts';
import { useDeselectGestures } from '../deselect.ts';
import { SelectionBar } from './SelectionBar.tsx';
import {
  addAll,
  EMPTY_SELECTION,
  extendTo,
  pruneToVisible,
  selectedIds,
  selectOnly,
  toggle,
} from '../selection.ts';
import type { SelectionState } from '../selection.ts';

const PERMANENT_DELETE: PermanentDelete = {
  preview: (ids) => adminApi.previewPermanentDelete(ids),
  confirm: (preview) => adminApi.confirmPermanentDelete(preview),
};

/**
 * The admin's trash: the shared trash page, plus a selection and the bar that
 * acts on it.
 *
 * The grid, the photo view, the restore call, and the permanent-delete dialog
 * are the shared page's, the same one the family app renders. This owns only
 * what the family has none of (family-tier.md 7.7): which photographs are
 * selected, the two ways out of a selection, the bar's Restore and Delete
 * permanently, and the calls permanent deletion makes.
 */
export function AdminTrashPage({
  nav,
  onChanged,
  revision,
}: {
  nav: ReactNode;
  onChanged: () => void;
  /** The app's trash revision; see `TrashPage`. */
  revision: number;
}) {
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);

  // The same two ways out of a selection the library has; see `deselect.ts`.
  useDeselectGestures(useCallback(() => setSelection(EMPTY_SELECTION), []));

  /**
   * The selection, measured against the listing the page holds. Everything
   * works from the pruned selection, never the raw state: a restore takes
   * photos out of the listing without touching it, and a bulk action must
   * never reach a photo the administrator can no longer see.
   */
  const select = useCallback(
    (ids: readonly string[]): TrashSelection => {
      const visible = pruneToVisible(selection, ids);
      return {
        selectedIds: visible.ids,
        chosen: selectedIds(visible),
        selectOnly: (id) => setSelection((state) => selectOnly(state, id)),
        toggle: (id) => setSelection(toggle(visible, id)),
        extendTo: (id) => setSelection(extendTo(visible, ids, id)),
        selectAll: (all) => setSelection((state) => addAll(state, all)),
        deselectAll: () => setSelection(EMPTY_SELECTION),
      };
    },
    [selection],
  );

  return (
    <TrashPage
      nav={nav}
      onChanged={onChanged}
      revision={revision}
      selection={select}
      filenames
      addedFrom={false}
      permanentDelete={PERMANENT_DELETE}
      bar={({ chosen, busy, restore, startPermanentDelete, deselectAll }) =>
        chosen.length > 0 ? (
          <SelectionBar count={chosen.length} onDeselectAll={deselectAll}>
            <button type="button" disabled={busy} onClick={() => restore(chosen)}>
              Restore
            </button>
            <button
              type="button"
              className="admin-danger"
              disabled={busy}
              onClick={() => startPermanentDelete(chosen)}
            >
              Delete permanently
            </button>
          </SelectionBar>
        ) : null
      }
    />
  );
}
