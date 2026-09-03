import { useState } from 'react';
import type { Ref } from 'react';
import { validatePhotoEdit } from '../validation.ts';
import type { PhotoEdit } from './curation.ts';
import type { PublicPhoto } from '../display-api.ts';

interface EditFormProps {
  photo: PublicPhoto;
  /** Resolves with the stored photo; rejects with a message to show. */
  onSave: (edit: PhotoEdit) => Promise<PublicPhoto>;
  /** The lightbox holds this to tell whether a field owns the keyboard. */
  ref?: Ref<HTMLFormElement>;
}

/**
 * The admin's caption and date, in place of the viewer's caption and date.
 *
 * Where the photo view shows what a photograph says about itself, the admin
 * shows the same three facts as fields, in the same corner. There is no Edit
 * toggle: editing is what an administrator is here for, and a toggle would put
 * a click in front of every correction.
 *
 * Nothing is sent until Save. An unsaved edit is discarded silently on arrow
 * navigation, on Escape, and on close: the lightbox keys this component on the
 * photo's ID, so arrowing away remounts it with the stored values.
 *
 * Keyed on the ID alone, and deliberately not on the metadata as well — a
 * save comes back with the updated record, and remounting on that would wipe
 * the "Saved" confirmation the user was meant to see.
 */
export function EditForm({ photo, onSave, ref }: EditFormProps) {
  const [date, setDate] = useState(photo.captureDate ?? '');
  const [time, setTime] = useState(photo.captureTime ?? '');
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    // The same validator the API runs. Checking here too means an obvious
    // mistake is caught without a round trip, not that the server trusts it.
    const validated = validatePhotoEdit({ date, time, caption });
    if (!validated.ok) {
      setError(validated.error);
      setSaved(false);
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
      // Clearing the date clears the time; reflect what was actually stored
      // rather than what was typed.
      setDate(stored.captureDate ?? '');
      setTime(stored.captureTime ?? '');
      setSaved(true);
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
        <span>Capture date</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="YYYY-MM-DD"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>

      <label className="edit-form__field">
        <span>Capture time</span>
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
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {error ? (
          <span className="admin-error" role="alert">
            {error}
          </span>
        ) : saved ? (
          <span className="edit-form__saved">Saved</span>
        ) : null}
      </div>
    </form>
  );
}
