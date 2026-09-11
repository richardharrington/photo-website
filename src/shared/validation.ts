/**
 * Validation shared by the admin UI and the admin API.
 *
 * Both call the same functions so the form and the endpoint cannot drift into
 * disagreeing about what a valid edit is. The API validates independently
 * rather than trusting the client — this module is shared code, not a reason
 * to skip the server-side check.
 */

import { validateCaptureMoment, formatCaptureDate } from './datetime.ts';
import type { CaptureDate, CaptureMoment, ValidationResult } from './datetime.ts';
import { isValidPhotoId } from './ids.ts';

export const MAX_CAPTION_LENGTH = 2000;

export interface PhotoEdit {
  moment: CaptureMoment;
  caption: string | null;
}

export interface PhotoEditInput {
  date?: string | null;
  time?: string | null;
  caption?: string | null;
}

/**
 * Captions are plain text with line breaks. Normalizing here — rather than at
 * render time — means the stored value is exactly what is displayed, so no
 * consumer has to decide whether to interpret markup.
 */
export function normalizeCaption(input: string | null | undefined): string | null {
  if (input == null) return null;
  const normalized = input
    .replace(/\r\n?/g, '\n')
    // Strip control characters other than the newline we just normalized.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f]', 'g'), '')
    // Collapse runs of blank lines; keep a single blank line as a paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return normalized === '' ? null : normalized;
}

/**
 * A caption, normalised and within the length limit.
 *
 * The photo view's form, the bulk caption box, and both endpoints all come
 * through here, so there is one limit and one way of saying it.
 */
export function validateCaption(
  input: string | null | undefined,
): ValidationResult<string | null> {
  const caption = normalizeCaption(input);
  if (caption !== null && caption.length > MAX_CAPTION_LENGTH) {
    return {
      ok: false,
      error: `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value: caption };
}

export function validatePhotoEdit(input: PhotoEditInput): ValidationResult<PhotoEdit> {
  const moment = validateCaptureMoment({ date: input.date, time: input.time });
  if (!moment.ok) return moment;

  const caption = validateCaption(input.caption);
  if (!caption.ok) return caption;

  return { ok: true, value: { moment: moment.value, caption: caption.value } };
}

/**
 * One photo's part of a bulk caption request: the caption to store, and the
 * caption the page last saw there.
 */
export interface CaptionChange {
  photoId: string;
  caption: string | null;
  /**
   * Compared byte for byte with the stored caption, which is already
   * normalised, so it is deliberately not normalised here. A photo whose
   * caption is no longer this is left alone (decisions.md #89).
   */
  expected: string | null;
}

/**
 * The body of `POST /captions`, refused as a whole if any part is malformed.
 *
 * `null` is a valid caption even though the caption box can never send one:
 * Undo has to be able to put back "no caption".
 */
export function validateCaptionChanges(
  input: unknown,
): ValidationResult<CaptionChange[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'A list of caption changes is required.' };
  }

  const seen = new Set<string>();
  const changes: CaptionChange[] = [];

  for (const entry of input as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'Each caption change must be an object.' };
    }
    const { photoId, caption, expected } = entry as Record<string, unknown>;

    if (typeof photoId !== 'string' || !isValidPhotoId(photoId)) {
      return { ok: false, error: 'A caption change has a malformed photo ID.' };
    }
    if (seen.has(photoId)) {
      return { ok: false, error: 'A photo appears more than once in the changes.' };
    }
    seen.add(photoId);

    if (caption !== null && typeof caption !== 'string') {
      return { ok: false, error: 'A caption must be text or null.' };
    }
    const validated = validateCaption(caption);
    if (!validated.ok) return validated;

    if (expected !== null && typeof expected !== 'string') {
      return { ok: false, error: 'An expected caption must be text or null.' };
    }

    changes.push({ photoId, caption: validated.value, expected });
  }

  return { ok: true, value: changes };
}

/**
 * Accessible image text. The caption is the real alt text when there is one;
 * otherwise a concise description of what the viewer is looking at, which is
 * more useful to a screen reader than a filename or an empty string.
 *
 * Takes the two fields it actually reads rather than a whole PhotoRecord, so
 * the public projection the viewer receives satisfies it without a cast.
 */
export function altTextFor(photo: {
  caption: string | null;
  captureDate: CaptureDate | null;
}): string {
  if (photo.caption) return photo.caption;
  if (photo.captureDate) return `Photo from ${formatCaptureDate(photo.captureDate)}`;
  return 'Undated photo';
}
