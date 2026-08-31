import { useCallback, useState } from 'react';
import { useResource } from '../../shared/ui/useResource.ts';
import { formatCaptureDate } from '../../shared/datetime.ts';
import { TRASH_RETENTION_DAYS } from '../../shared/constants.ts';
import { adminApi } from '../api.ts';
import type { PreviewResult, TrashItem } from '../api.ts';
import { Confirm } from './Confirm.tsx';
import { EMPTY_SELECTION, pruneToVisible, selectedIds, toggle } from '../selection.ts';
import type { SelectionState } from '../selection.ts';

/**
 * The date a trashed photo will be purged.
 *
 * An absolute date rather than a countdown: it is unambiguous, it matches how
 * the rest of the site states dates, and it is a pure function of the record
 * — no clock read during render.
 *
 * `trashedAt` is a genuine instant, unlike a capture time, so Date arithmetic
 * is the right tool here.
 */
function purgeDate(trashedAt: string): string {
  const purgeAt = new Date(Date.parse(trashedAt) + TRASH_RETENTION_DAYS * 86_400_000);
  return formatCaptureDate(purgeAt.toISOString().slice(0, 10));
}

/**
 * The trash.
 *
 * Thumbnails arrive as signed URLs, because the Worker refuses capability-URL
 * access to a trashed photo. There is deliberately no download action here:
 * a trashed photo shows enough to be identified — thumbnail, filename,
 * original date, deletion date — and nothing more.
 */
export function TrashView({ onChanged }: { onChanged: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resource = useResource<{ items: TrashItem[] }>(
    (signal) => adminApi.trash(signal),
    [reloadKey],
  );

  const reload = useCallback(() => {
    setSelection(EMPTY_SELECTION);
    setReloadKey((key) => key + 1);
    onChanged();
  }, [onChanged]);

  async function restore(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      await adminApi.restore(ids);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  async function startPermanentDelete(ids: string[]) {
    setError(null);
    try {
      setPreview(await adminApi.previewPermanentDelete(ids));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmPermanentDelete() {
    if (!preview) return;
    setBusy(true);
    try {
      await adminApi.confirmPermanentDelete(preview);
      setPreview(null);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  if (resource.status === 'loading') return <p className="state">Loading…</p>;
  if (resource.status === 'error') {
    return (
      <p className="state" role="alert">
        {resource.message}
      </p>
    );
  }
  if (resource.status === 'not-found') return <p className="state">Not found.</p>;

  const items = resource.data.items;
  const chosen = selectedIds(
    pruneToVisible(
      selection,
      items.map((i) => i.photo.id),
    ),
  );
  return (
    <section className="trash">
      <p className="trash__intro">
        Deleted photos are kept for {TRASH_RETENTION_DAYS} days, then removed
        automatically.
      </p>

      {error ? (
        <p className="detail__error" role="alert">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="state state--empty">The trash is empty.</p>
      ) : (
        <>
          <div className="trash__toolbar">
            <span>{chosen.length} selected</span>
            <button
              type="button"
              disabled={chosen.length === 0 || busy}
              onClick={() => void restore(chosen)}
            >
              Restore
            </button>
            <button
              type="button"
              className="detail__delete"
              disabled={chosen.length === 0 || busy}
              onClick={() => void startPermanentDelete(chosen)}
            >
              Delete permanently
            </button>
          </div>

          <ul className="trash__list">
            {items.map((item) => {
              const selected = selection.ids.has(item.photo.id);
              return (
                <li key={item.photo.id} className="trash__item">
                  <button
                    type="button"
                    className={`trash__tile ${selected ? 'trash__tile--selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => setSelection(toggle(selection, item.photo.id))}
                  >
                    <img src={item.thumbnailUrl} alt="" loading="lazy" />
                  </button>
                  <div className="trash__meta">
                    <span className="trash__filename">
                      {item.photo.originalFilename}
                    </span>
                    <span>
                      {item.photo.captureDate
                        ? formatCaptureDate(item.photo.captureDate)
                        : 'Undated'}
                    </span>
                    <span className="trash__expiry">
                      Removed on {purgeDate(item.trashedAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {preview ? (
        <Confirm
          preview={preview}
          title="Delete permanently?"
          description="will be deleted permanently. This cannot be undone."
          confirmLabel="Delete permanently"
          destructive
          onConfirm={() => void confirmPermanentDelete()}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
