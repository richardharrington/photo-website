import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { PreviewResult } from '../api.ts';

interface ConfirmDialogProps {
  title: string;
  /** What will happen, in the words of this specific action. */
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** True when there is nothing to act on, e.g. a preview that resolved to 0. */
  nothingToDo?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The dialog every confirmation wears: modal, Escape cancels, focus starts on
 * the confirm button, and a click on the backdrop is a cancel.
 *
 * It knows nothing about photos. `Confirm` below is the photo-counting case,
 * which is most of them; the Notifications page names an address instead.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  nothingToDo = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{children}</p>

        <div className="confirm__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={destructive ? 'confirm__destructive' : ''}
            onClick={onConfirm}
            disabled={nothingToDo}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  /** The resolved preview. Its ID list is exactly what will be acted on. */
  preview: PreviewResult;
  title: string;
  /** Says plainly what happens, in the words of this specific action. */
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirm half of every destructive action.
 *
 * It states the count from the *resolved preview*, not from the current
 * selection, and confirming acts on that same explicit ID list. A photo
 * committed between preview and confirm is therefore not covered by it
 * (decisions.md #12) — which is also why the count shown here is the honest
 * one to state.
 */
export function Confirm({
  preview,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const count = preview.count;

  return (
    <ConfirmDialog
      title={title}
      confirmLabel={confirmLabel}
      destructive={destructive}
      nothingToDo={count === 0}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {/* The exact number resolved at preview time. */}
      <strong>
        {count} photo{count === 1 ? '' : 's'}
      </strong>{' '}
      {description}
    </ConfirmDialog>
  );
}

interface UndoProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/** How long the offer stands before it withdraws itself. */
const UNDO_VISIBLE_MS = 5_000;

/**
 * The brief Undo shown after a successful trash operation.
 *
 * Restore is not itself gated behind a confirmation: it only ever puts photos
 * back, and making the safe direction slower than the destructive one would be
 * the wrong way round.
 *
 * Brief means brief: five seconds from the moment it appears, whatever else
 * re-renders in between. That is why `onDismiss` has to be stable — a fresh
 * closure on every parent render would restart this clock each time, and the
 * banner would outstay its welcome by however long the page stayed busy.
 */
export function UndoBanner({ message, onUndo, onDismiss }: UndoProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="undo" role="status">
      <span>{message}</span>
      <button type="button" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
