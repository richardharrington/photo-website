import { derivativeUrl } from '../../shared/urls.ts';
import { ConfirmDialog } from './Confirm.tsx';
import type { CaptionPlan } from '../caption-apply.ts';

interface ReplaceCaptionsProps {
  caption: string;
  /** How many photos are selected, including those with no caption. */
  selected: number;
  /** Every photo that would lose a different caption, in on-screen order. */
  replaced: CaptionPlan['replaced'];
  onConfirm: () => void;
  onCancel: () => void;
}

/** The dialog's thumbnails are all this tall; widths follow each photo. */
const THUMB_HEIGHT = 48;

/**
 * Asked only when applying a caption would lose one, and it shows every one.
 *
 * Not a count, and not the first few: the point is to see what is about to go,
 * and a list cut short hides part of it. The server applies each change only
 * where the caption is still the one listed here, so nothing that was not
 * shown can be lost (decisions.md #89).
 */
export function ReplaceCaptions({
  caption,
  selected,
  replaced,
  onConfirm,
  onCancel,
}: ReplaceCaptionsProps) {
  const lost = replaced.length;

  return (
    <ConfirmDialog
      title="Replace captions?"
      confirmLabel="Replace captions"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
      details={
        <ul className="caption-replace">
          {replaced.map(({ photo, expected }) => {
            const thumb = photo.derivatives.thumb;
            return (
              <li key={photo.id} className="caption-replace__row">
                {/* No alt text: the caption beside it is the text. */}
                <img
                  src={derivativeUrl(__WORKER_BASE_URL__, photo.id, 'thumb')}
                  width={Math.round((thumb.width / thumb.height) * THUMB_HEIGHT)}
                  height={THUMB_HEIGHT}
                  alt=""
                  decoding="async"
                />
                <span className="caption-replace__caption">{expected}</span>
              </li>
            );
          })}
        </ul>
      }
    >
      Apply <q className="caption-replace__quote">{caption}</q> to {selected} photo
      {selected === 1 ? '' : 's'}?{' '}
      {selected === 1 ? 'It has' : `${lost} of them ${lost === 1 ? 'has' : 'have'}`} a
      different caption, which will be replaced:
    </ConfirmDialog>
  );
}
