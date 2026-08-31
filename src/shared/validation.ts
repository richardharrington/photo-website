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

export function validatePhotoEdit(input: PhotoEditInput): ValidationResult<PhotoEdit> {
  const moment = validateCaptureMoment({ date: input.date, time: input.time });
  if (!moment.ok) return moment;

  const caption = normalizeCaption(input.caption);
  if (caption !== null && caption.length > MAX_CAPTION_LENGTH) {
    return {
      ok: false,
      error: `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer.`,
    };
  }

  return { ok: true, value: { moment: moment.value, caption } };
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
