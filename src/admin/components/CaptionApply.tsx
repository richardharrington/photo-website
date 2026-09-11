import { useId, useRef, useState } from 'react';
import { captionSlot, planCaption } from '../caption-apply.ts';
import type { CaptionPlan } from '../caption-apply.ts';
import type { PublicPhoto } from '../../shared/display-api.ts';

/** How an apply ended, as far as the box needs to know. */
export type CaptionApplyResult = 'applied' | 'cancelled' | 'failed';

interface CaptionApplyProps {
  /** The selected photos, in on-screen order. */
  selected: readonly PublicPhoto[];
  /**
   * Confirms if a caption would be lost, sends, and reports how it ended.
   *
   * `sending` is called as the request goes out, which is when the slot
   * starts to say Applying… — not while a confirmation is still asking,
   * because nothing is being applied yet.
   */
  onApply: (plan: CaptionPlan, sending: () => void) => Promise<CaptionApplyResult>;
}

/**
 * The selection bar's caption box: one line, and Enter applies.
 *
 * One line because the pinned bar must not grow three lines taller, and
 * because the photo view's caption uses the opposite convention — Enter is a
 * line break there — so a box that grew on Shift+Enter would apply a
 * half-typed caption to every selected photo the first time photo-view habit
 * pressed Enter. Line breaks are added per photo afterwards.
 *
 * Its state lives here, and the bar is unmounted whenever the selection
 * empties, so the text survives selecting more photos and dies with the bar
 * without anything having to clear it (decisions.md #89).
 */
export function CaptionApply({ selected, onApply }: CaptionApplyProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [appliedOnce, setAppliedOnce] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  // Held for the whole apply, confirmation included, so a second Enter or
  // click cannot start another one behind the dialog.
  const applying = useRef(false);

  const slot = captionSlot({
    text,
    inFlight,
    appliedOnce,
    selectedCaptions: selected.map((photo) => photo.caption),
  });

  async function apply() {
    if (applying.current) return;
    applying.current = true;
    try {
      const result = await onApply(planCaption(selected, text), () =>
        setInFlight(true),
      );
      if (result === 'applied') setAppliedOnce(true);
    } finally {
      applying.current = false;
      setInFlight(false);
      // Focus was on the replace dialog's button, or on Apply, and both are
      // gone now. Back to the box — unless the administrator has since put it
      // somewhere on purpose.
      const input = inputRef.current;
      const focused = document.activeElement;
      if (input?.isConnected && (focused === null || focused === document.body)) {
        input.focus();
      }
    }
  }

  return (
    <div className="caption-apply">
      <label className="caption-apply__label" htmlFor={id}>
        Apply caption to selected
      </label>
      <input
        ref={inputRef}
        id={id}
        className="caption-apply__input"
        type="text"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Stopped before the blur. The deselect listener is on `window`,
            // after React's root; let the event carry on and it would find no
            // field focused and clear the selection on the first press.
            event.stopPropagation();
            event.currentTarget.blur();
            return;
          }
          // Enter that confirms an IME composition is the composition's.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (slot === 'apply') void apply();
        }}
      />
      {/* Fixed width, whatever it holds, so the box beside it never moves.
          `aria-live` rather than `role="status"`: the undo banner is the
          page's one status. */}
      <span className="caption-apply__slot" aria-live="polite">
        {slot === 'apply' ? (
          <button type="button" onClick={() => void apply()}>
            Apply
          </button>
        ) : slot === 'applying' ? (
          'Applying…'
        ) : slot === 'applied' ? (
          'Applied'
        ) : null}
      </span>
    </div>
  );
}
