import { useEffect, useState } from 'react';
import type { Ref } from 'react';
import { validatePhotoEdit } from '../validation.ts';
import type { PhotoEdit } from './curation.ts';
import type { PublicPhoto } from '../display-api.ts';

interface EditFormProps {
  photo: PublicPhoto;
  /** Resolves with the stored photo; rejects with a message to show. */
  onSave: (edit: PhotoEdit) => Promise<PublicPhoto>;
  /** Called once a save has resolved, and only then: the view leaves the form. */
  onSaved: () => void;
  /** Discard whatever was typed, without asking, and leave the form. */
  onCancel: () => void;
  /**
   * Told whenever the fields start or stop differing from what is stored.
   *
   * Only this component can know — the values are its own state — and only
   * the view can act on it, because Escape, which would leave the form, is
   * the view's.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** The lightbox holds this to tell whether a field owns the keyboard. */
  ref?: Ref<HTMLFormElement>;
}

/**
 * A photograph's date, time, and caption as fields, in the corner of the photo
 * view where its read view shows them as text.
 *
 * Reached by the view's Edit button, and left by Save changes or Cancel
 * (read-first-photo-view.md). Nothing is sent until Save, which stays disabled
 * until a field differs from what is stored. A save that succeeds hands back
 * through `onSaved`, and the view returns to reading and says "Saved" there;
 * one that fails stays here, with the message and everything typed. Cancel
 * discards without asking.
 *
 * While the form is up the view hides its arrows and refuses to step, and
 * Escape — once no field has focus and Photo info is shut — will not leave
 * while `onDirtyChange` has reported true. Either would throw the typing away
 * while leaving the reader on the same photograph, and a caption dropped that
 * way is worse than a key that does nothing; "Unsaved changes" under Save is
 * the explanation. Closing the photograph still discards, because that reads
 * as leaving.
 *
 * The lightbox keys this component on the photo's ID alone, and deliberately
 * not on the metadata as well, because the stored record can change under a
 * mounted form without a save: the undo banner sits above the photo view, and
 * undoing a bulk caption changes the caption of the photo on screen. A field
 * still showing what was stored follows the new value; a field the
 * administrator has typed in keeps what they typed. Without that an untouched
 * form would read as "Unsaved changes" and refuse Escape over an edit nobody
 * made (decisions.md #89).
 */
export function EditForm({
  photo,
  onSave,
  onSaved,
  onCancel,
  onDirtyChange,
  ref,
}: EditFormProps) {
  const record = {
    date: photo.captureDate ?? '',
    time: photo.captureTime ?? '',
    caption: photo.caption ?? '',
  };
  const [date, setDate] = useState(record.date);
  const [time, setTime] = useState(record.time);
  const [caption, setCaption] = useState(record.caption);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The record as this form last saw it, adjusted during render rather than
  // in an effect, so there is never a painted frame reporting a stale edit.
  const [seen, setSeen] = useState(record);
  if (
    seen.date !== record.date ||
    seen.time !== record.time ||
    seen.caption !== record.caption
  ) {
    if (date === seen.date) setDate(record.date);
    if (time === seen.time) setTime(record.time);
    if (caption === seen.caption) setCaption(record.caption);
    setSeen(record);
  }

  /**
   * Compared against the record rather than tracked as a flag, so typing a
   * character and deleting it again leaves nothing behind.
   */
  const dirty =
    date !== record.date || time !== record.time || caption !== record.caption;

  useEffect(() => {
    onDirtyChange?.(dirty);
    // Whatever the fields held, an unmounted form is holding nothing. This is
    // also what clears the view's copy after Cancel and after a save.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  async function save() {
    // Save is disabled with nothing to send, and the keyboard shortcut
    // follows the button.
    if (saving || !dirty) return;

    // The same validator the API runs. Checking here too means an obvious
    // mistake is caught without a round trip, not that the server trusts it.
    const validated = validatePhotoEdit({ date, time, caption });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const stored = await onSave({
        date: validated.value.moment.date,
        time: validated.value.moment.time,
        caption: validated.value.caption,
      });
      // Clearing the date clears the time, and a caption is stored trimmed:
      // reflect what was actually stored rather than what was typed.
      setDate(stored.captureDate ?? '');
      setTime(stored.captureTime ?? '');
      setCaption(stored.caption ?? '');
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That change could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      ref={ref}
      className="edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="edit-form__field">
        <span>Date</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="YYYY-MM-DD"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>

      <label className="edit-form__field">
        <span>Time</span>
        <input
          type="text"
          placeholder="HH:MM"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          // A time is meaningful only alongside a date; clearing the date
          // clears the time when the edit is saved.
          disabled={date.trim() === ''}
        />
      </label>

      <label className="edit-form__field">
        <span>Caption</span>
        <textarea
          rows={3}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Plain text. Line breaks are kept."
          // Enter belongs to the caption — line breaks are kept — so the
          // keyboard shortcut for saving takes the platform's modifier.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </label>

      <div className="edit-form__actions">
        <button type="submit" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {/* A line of its own, there whether or not it says anything, so the
          message coming and going as the fields change moves nothing: the
          photo view anchors this form at the bottom, and a line appearing
          would lift the whole of it. */}
      <div className="edit-form__status">
        {error ? (
          <span className="admin-error" role="alert">
            {error}
          </span>
        ) : dirty ? (
          /* Escape will not leave the form while this shows, and this is
             where the reason has to be: nothing else on screen changes when
             the key is refused. */
          <span className="edit-form__unsaved">Unsaved changes</span>
        ) : null}
      </div>
    </form>
  );
}
