import { useEffect, useRef } from 'react';
import type { PreviewResult } from '../api.ts';

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

  const count = preview.count;

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
        <p>
          {/* The exact number resolved at preview time. */}
          <strong>
            {count} photo{count === 1 ? '' : 's'}
          </strong>{' '}
          {description}
        </p>

        <div className="confirm__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={destructive ? 'confirm__destructive' : ''}
            onClick={onConfirm}
            disabled={count === 0}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface UndoProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/**
 * The brief Undo shown after a successful trash operation.
 *
 * Restore is not itself gated behind a confirmation: it only ever puts photos
 * back, and making the safe direction slower than the destructive one would be
 * the wrong way round.
 */
export function UndoBanner({ message, onUndo, onDismiss }: UndoProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 12_000);
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
